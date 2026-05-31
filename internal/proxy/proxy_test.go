package proxy

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"assay/internal/config"
	"assay/internal/evidence"
)

func testProxy(t *testing.T, upstream string) (*Proxy, *evidence.Writer, string) {
	t.Helper()
	evPath := filepath.Join(t.TempDir(), "evidence.jsonl")
	cfg := &config.Config{
		Listen:              ":0",
		StripAcceptEncoding: true,
		Upstreams:           []config.Upstream{{Target: upstream, AuthMode: "passthrough"}},
		Capture:             config.Capture{MaxBodyBytes: 8 << 20, ChannelSize: 256, DrainOnDisconnect: true},
		Timeouts:            config.Timeouts{DialMs: 5000, TLSHandshakeMs: 5000, ResponseHeaderMs: 10000, StreamIdleMs: 10000},
		Evidence:            config.Evidence{Path: evPath, FlushEveryRecords: 1, RedactHeaders: []string{"authorization"}},
	}
	w, err := evidence.NewWriter(evidence.WriterOptions{Path: evPath, FlushEveryRecords: 1})
	if err != nil {
		t.Fatalf("writer: %v", err)
	}
	return New(cfg, w), w, evPath
}

func readEvidence(t *testing.T, path string) []evidence.Record {
	t.Helper()
	// Give the async writer a moment to flush.
	time.Sleep(50 * time.Millisecond)
	res, err := evidence.VerifyFile(path)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if res.Status != evidence.VerifyValid && res.Status != evidence.VerifyEmpty {
		t.Fatalf("evidence chain not valid: %s (%s)", res.Status, res.Detail)
	}
	f, _ := http.Dir(filepath.Dir(path)).Open(filepath.Base(path))
	defer f.Close()
	var recs []evidence.Record
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for sc.Scan() {
		var r evidence.Record
		if err := jsonUnmarshalStrict(sc.Bytes(), &r); err != nil {
			t.Fatalf("decode evidence line: %v", err)
		}
		recs = append(recs, r)
	}
	return recs
}

func jsonUnmarshalStrict(b []byte, v any) error {
	dec := newDecoder(b)
	return dec.Decode(v)
}

// TestNonStreamPassthroughAndEvidence verifies a non-streaming JSON response is
// forwarded verbatim and produces one valid evidence record with parsed usage.
func TestNonStreamPassthroughAndEvidence(t *testing.T) {
	const body = `{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"hello world"}}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11},"system_fingerprint":"fp_test"}`
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer client-key" {
			t.Errorf("upstream did not receive client auth verbatim: %q", got)
		}
		if got := r.Header.Get("Accept-Encoding"); got != "identity" {
			t.Errorf("Accept-Encoding should be forced to identity, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	defer up.Close()

	p, w, evPath := testProxy(t, up.URL)
	defer w.Close()

	req := httptest.NewRequest("POST", "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Body.String() != body {
		t.Fatalf("response not passed through verbatim:\n got=%q\nwant=%q", rec.Body.String(), body)
	}

	recs := readEvidence(t, evPath)
	if len(recs) != 1 {
		t.Fatalf("expected 1 evidence record, got %d", len(recs))
	}
	e := recs[0]
	if e.Route.Provider != "openai" || e.Route.APISurface != "chat.completions" {
		t.Errorf("classify = %s/%s", e.Route.Provider, e.Route.APISurface)
	}
	if e.Route.ClaimedModel == nil || *e.Route.ClaimedModel != "gpt-4o" {
		t.Errorf("claimed_model = %v", e.Route.ClaimedModel)
	}
	if e.Response.ClaimedUsage == nil || e.Response.ClaimedUsage.CompletionTokens == nil || *e.Response.ClaimedUsage.CompletionTokens != 2 {
		t.Errorf("claimed usage not parsed: %+v", e.Response.ClaimedUsage)
	}
	if e.Request.Headers["authorization"][0] != "REDACTED" {
		t.Errorf("authorization not redacted in evidence: %v", e.Request.Headers["authorization"])
	}
	if !e.Capture.TeeOk || !e.Response.Complete {
		t.Errorf("tee_ok=%v complete=%v", e.Capture.TeeOk, e.Response.Complete)
	}
}

// TestStreamingFlushAndUsage verifies SSE is streamed with per-chunk flushing
// (not batched) and that streamed usage + reconstructed text land in evidence.
func TestStreamingFlushAndUsage(t *testing.T) {
	chunks := []string{
		`data: {"choices":[{"delta":{"role":"assistant","content":""}}]}` + "\n\n",
		`data: {"choices":[{"delta":{"content":"Hel"}}]}` + "\n\n",
		`data: {"choices":[{"delta":{"content":"lo"}}]}` + "\n\n",
		`data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}` + "\n\n",
		`data: [DONE]` + "\n\n",
	}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		for _, c := range chunks {
			_, _ = io.WriteString(w, c)
			if fl != nil {
				fl.Flush()
			}
			time.Sleep(20 * time.Millisecond)
		}
	}))
	defer up.Close()

	p, w, evPath := testProxy(t, up.URL)
	defer w.Close()

	req := httptest.NewRequest("POST", "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)

	full := strings.Join(chunks, "")
	if rec.Body.String() != full {
		t.Fatalf("stream not passed through verbatim:\n got=%q\nwant=%q", rec.Body.String(), full)
	}

	recs := readEvidence(t, evPath)
	if len(recs) != 1 {
		t.Fatalf("expected 1 record, got %d", len(recs))
	}
	e := recs[0]
	if !e.Response.Stream {
		t.Error("stream flag not set")
	}
	if e.Timing.StreamChunks != 3 {
		t.Errorf("stream_chunks = %d, want 3 (content events only)", e.Timing.StreamChunks)
	}
	if e.Response.ClaimedUsage == nil || *e.Response.ClaimedUsage.CompletionTokens != 1 {
		t.Errorf("streamed usage not extracted: %+v", e.Response.ClaimedUsage)
	}
	if e.Timing.TTFTUs == nil {
		t.Error("ttft not measured for stream")
	}
	if !e.Response.Complete {
		t.Error("complete should be true after [DONE]")
	}
}

// TestUpstreamErrorIsRecorded verifies a dead upstream yields a 502 to the
// client and a complete=false evidence record (no lost audit trail).
func TestUpstreamErrorIsRecorded(t *testing.T) {
	p, w, evPath := testProxy(t, "http://127.0.0.1:1") // refused
	defer w.Close()

	req := httptest.NewRequest("POST", "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","messages":[]}`))
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	recs := readEvidence(t, evPath)
	if len(recs) != 1 || recs[0].Response.Complete {
		t.Fatalf("expected 1 complete=false record, got %+v", recs)
	}
}

// TestBodySecretScrubbing proves a credential placed in a request body is NOT
// stored verbatim in evidence (assay must not be a second leak), while the
// response still passes through verbatim to the client and the chain verifies.
func TestBodySecretScrubbing(t *testing.T) {
	const secret = "sk-ABCDEFGHIJKLMNOP1234567890abcdef"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Upstream must still receive the REAL secret (scrub is storage-only).
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), secret) {
			t.Errorf("upstream did not receive the real secret (scrub must be storage-only)")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-1","model":"gpt-4o","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}`)
	}))
	defer up.Close()

	p, w, evPath := testProxy(t, up.URL)
	defer w.Close()

	reqBody := `{"model":"gpt-4o","messages":[{"role":"user","content":"my key is ` + secret + ` please use it"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}

	recs := readEvidence(t, evPath)
	if len(recs) != 1 {
		t.Fatalf("expected 1 record, got %d", len(recs))
	}
	e := recs[0]
	if strings.Contains(e.Request.Raw, secret) {
		t.Errorf("SECOND LEAK: real secret stored verbatim in evidence: %q", e.Request.Raw)
	}
	if !strings.Contains(e.Request.Raw, "[assay-redacted:openai_key]") {
		t.Errorf("expected typed redaction marker in stored body, got: %q", e.Request.Raw)
	}
	if e.Capture.Note == nil || !strings.Contains(*e.Capture.Note, "scrubbed 1 credential") {
		t.Errorf("expected scrub note, got: %v", e.Capture.Note)
	}
	// Chain must verify over the SCRUBBED bytes (raw_sha256 is over what we store).
	if e.Request.RawSHA256 != sha256hex([]byte(e.Request.Raw)) {
		t.Errorf("raw_sha256 must match stored (scrubbed) body for reproducibility")
	}
}

func TestClassifyRoute(t *testing.T) {
	cases := map[string][2]string{
		"/v1/chat/completions":                  {"openai", "chat.completions"},
		"/v1/responses":                         {"openai", "responses"},
		"/v1/embeddings":                        {"openai", "embeddings"},
		"/v1/messages":                          {"anthropic", "messages"},
		"/v1beta/models/gemini:generateContent": {"gemini", "generateContent"},
		"/something/else":                       {"unknown", "other"},
	}
	for path, want := range cases {
		p, a := ClassifyRoute(path)
		if p != want[0] || a != want[1] {
			t.Errorf("ClassifyRoute(%q) = %s/%s, want %s/%s", path, p, a, want[0], want[1])
		}
	}
}

var _ = context.Background
var _ = bytes.NewReader
