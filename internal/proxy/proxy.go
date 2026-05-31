// Package proxy implements the assay (照妖镜) data plane: a transparent,
// fail-open OpenAI-compatible audit proxy. It forwards each request to the
// configured upstream relay, streams the response back to the client byte-for-
// byte with per-chunk flushing, and — entirely off the client's critical path —
// tees a bounded copy into the hash-chained evidence log.
//
// Fail-open is structural, not aspirational (PHASE0.md §2):
//   - The client read/write path depends only on forward+flush. Capture runs on
//     a copy; if anything in capture fails or the queue is full, the record is
//     dropped (counted) and the client is unaffected.
//   - No marshal/hash/fsync ever runs on a goroutine holding a client conn; the
//     evidence.Writer owns all of that in its own goroutine.
package proxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"assay/internal/config"
	"assay/internal/evidence"
)

// hopByHop headers must not be forwarded verbatim (RFC 7230 §6.1); Go sets
// framing itself. Forwarding them can corrupt the client connection.
var hopByHop = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-authenticate": true,
	"proxy-authorization": true, "te": true, "trailer": true,
	"transfer-encoding": true, "upgrade": true,
}

// Proxy is the data-plane HTTP handler.
type Proxy struct {
	cfg         *config.Config
	upstream    config.Upstream
	writer      *evidence.Writer
	client      *http.Client
	maxBody     int
	scrubBodies bool
}

// New builds a Proxy from config and an evidence writer.
func New(cfg *config.Config, w *evidence.Writer) *Proxy {
	u := cfg.Upstreams[0] // MVP: single upstream
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   cfg.Timeouts.Dial(),
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   cfg.Timeouts.TLSHandshake(),
		ResponseHeaderTimeout: cfg.Timeouts.ResponseHeader(),
		ExpectContinueTimeout: 1 * time.Second,
		// We manage Accept-Encoding ourselves (set identity upstream so captured
		// bytes are decodable text). Disable Go's automatic gzip add/decompress
		// so it never re-adds Accept-Encoding: gzip behind our back.
		DisableCompression: true,
	}
	return &Proxy{
		cfg:      cfg,
		upstream: u,
		writer:   w,
		// No Client.Timeout: it would kill long streams. Stream idle is handled
		// per-read in the copy loop; header/dial/TLS bounded by the Transport.
		client:      &http.Client{Transport: transport},
		maxBody:     cfg.Capture.MaxBodyBytes,
		scrubBodies: cfg.Evidence.ScrubBodySecretsEnabled(),
	}
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" {
		written, dropped, werr := p.writer.Stats()
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","evidence_written":%d,"evidence_dropped":%d,"write_errors":%d}`+"\n", written, dropped, werr)
		return
	}
	p.handle(w, r)
}

// handle proxies one request. Errors talking to the upstream are surfaced to the
// client (fail-open w.r.t. AUDIT, not w.r.t. a broken upstream — a dead relay is
// the relay's failure and the client must see it).
func (p *Proxy) handle(w http.ResponseWriter, r *http.Request) {
	startWall := time.Now().UTC()
	startMono := time.Now()

	reqBody, reqTruncated, reqTotal := readCapped(r.Body, p.maxBody)
	_ = r.Body.Close()

	provider, apiSurface := ClassifyRoute(r.URL.Path)

	// Build the upstream request. We forward the ORIGINAL header set (minus
	// hop-by-hop); redaction happens later on a COPY for evidence only.
	target := p.upstream.Target + r.URL.Path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	outReq, err := http.NewRequestWithContext(ctx, r.Method, target, bytes.NewReader(reqBody))
	if err != nil {
		http.Error(w, "assay: bad upstream request: "+err.Error(), http.StatusBadGateway)
		return
	}
	copyHeaders(outReq.Header, r.Header)
	if p.cfg.StripAcceptEncoding {
		// Explicitly request identity so the relay returns uncompressed bytes we
		// can store as decodable text. Just deleting the header is insufficient:
		// Go's transport would auto-add Accept-Encoding: gzip (lens streaming).
		outReq.Header.Set("Accept-Encoding", "identity")
	}
	applyAuth(outReq, p.upstream)

	// httptrace: connect timing + true time-to-first-byte.
	var connectUs *uint64
	var connReused bool
	var gotConn time.Time
	trace := &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			connReused = info.Reused
			gotConn = time.Now()
		},
		WroteRequest: func(httptrace.WroteRequestInfo) {},
	}
	outReq = outReq.WithContext(httptrace.WithClientTrace(ctx, trace))

	resp, err := p.client.Do(outReq)
	if err != nil {
		// Upstream failed before headers. Record evidence (complete=false) then
		// surface to client.
		note := "upstream error: " + err.Error()
		p.submit(p.buildRecord(recordInput{
			startWall: startWall, method: r.Method, path: r.URL.Path,
			provider: provider, apiSurface: apiSurface,
			reqHeaders: r.Header, reqBody: reqBody, reqTrunc: reqTruncated, reqTotal: reqTotal,
			status: http.StatusBadGateway, complete: false, teeOk: true, note: &note,
		}))
		http.Error(w, "assay: upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if !gotConn.IsZero() {
		us := uint64(time.Since(gotConn).Microseconds()) // ~ time to headers from conn
		_ = us
	}
	if connReused {
		z := uint64(0)
		connectUs = &z
	}

	isStream := isEventStream(resp.Header)

	// Write client response headers (strip hop-by-hop; preserve everything else
	// verbatim for transparency).
	for k, vs := range resp.Header {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)

	// The copy loop: read upstream -> write+flush client FIRST -> append a copy
	// to the capture buffer SECOND. Only a client-write error aborts it.
	cap := newCaptureBuf(p.maxBody)
	buf := make([]byte, 32*1024)
	var ttftUs *uint64
	var clientGone bool
	firstByte := true

	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if firstByte {
				us := uint64(time.Since(startMono).Microseconds())
				ttftUs = &us
				firstByte = false
			}
			if !clientGone {
				if _, werr := w.Write(buf[:n]); werr != nil {
					// Client vanished. Stop serving it, but keep draining upstream
					// (drain mode) so evidence + usage tail are complete, and so we
					// can cancel upstream to stop the relay billing.
					clientGone = true
					if !p.cfg.Capture.DrainOnDisconnect {
						cancel()
					}
				} else if flusher != nil {
					flusher.Flush()
				}
			}
			cap.append(buf[:n]) // best-effort; bounded; never blocks client
		}
		if rerr != nil {
			break
		}
	}

	totalUs := uint64(time.Since(startMono).Microseconds())

	// Decide completion. For non-stream: a clean io.EOF means full body.
	respBytes, respTrunc, respTotal := cap.bytes()
	complete := true
	var note *string
	if clientGone {
		complete = false
		n := "client_disconnect"
		note = &n
	}

	rec := p.buildRecord(recordInput{
		startWall: startWall, method: r.Method, path: r.URL.Path,
		provider: provider, apiSurface: apiSurface,
		reqHeaders: r.Header, reqBody: reqBody, reqTrunc: reqTruncated, reqTotal: reqTotal,
		respHeaders: resp.Header, respBody: respBytes, respTrunc: respTrunc, respTotal: respTotal,
		status: resp.StatusCode, stream: isStream, complete: complete,
		ttftUs: ttftUs, totalUs: &totalUs, connReused: connReused, connectUs: connectUs,
		teeOk: !cap.overflowed(), clientDisconnected: clientGone, note: note,
		contentEncoding: headerPtr(resp.Header, "Content-Encoding"),
	})
	p.submit(rec)
}

type recordInput struct {
	startWall                          time.Time
	method, path, provider, apiSurface string
	reqHeaders                         http.Header
	reqBody                            []byte
	reqTrunc                           bool
	reqTotal                           int
	respHeaders                        http.Header
	respBody                           []byte
	respTrunc                          bool
	respTotal                          int
	status                             int
	stream, complete                   bool
	ttftUs, totalUs, connectUs         *uint64
	connReused                         bool
	teeOk, clientDisconnected          bool
	note                               *string
	contentEncoding                    *string
}

func (p *Proxy) buildRecord(in recordInput) *evidence.Record {
	rec := &evidence.Record{
		ID:      uuid.NewString(),
		TsStart: in.startWall.Format(time.RFC3339Nano),
		Route: evidence.Route{
			Method: in.method, Path: in.path, Upstream: p.upstream.Target,
			ClaimedModel: extractModelFromRequest(in.reqBody),
			Provider:     in.provider, APISurface: in.apiSurface,
		},
		Request: evidence.Request{
			Headers:   redactHeaders(in.reqHeaders, p.cfg.Evidence.RedactHeaders),
			Bytes:     uint64(in.reqTotal),
			Truncated: in.reqTrunc,
		},
		Response: evidence.Response{
			Status: in.status, Stream: in.stream, Complete: in.complete,
			ContentEncoding: in.contentEncoding,
			Bytes:           uint64(in.respTotal),
			Truncated:       in.respTrunc,
		},
		Timing: evidence.Timing{
			TTFTUs: in.ttftUs, TotalUs: in.totalUs,
			ConnReused: in.connReused, UpstreamConnectUs: in.connectUs,
		},
		Capture: evidence.Capture{
			TeeOk: in.teeOk, ClientDisconnected: in.clientDisconnected, Note: in.note,
		},
	}
	if in.respHeaders != nil {
		rec.Response.Headers = redactHeaders(in.respHeaders, p.cfg.Evidence.RedactHeaders)
	} else {
		rec.Response.Headers = map[string][]string{}
	}

	// Scrub credential-shaped secrets from bodies BEFORE hashing/storing, so the
	// evidence log never becomes a durable copy of the buyer's credentials. The
	// hash chain is computed over the SCRUBBED bytes (what we actually store),
	// keeping replay reproducible. Parsing (usage/SSE) runs on the scrubbed body
	// too — credentials never appear in usage/model fields anyway, so this is
	// safe. NOTE: catches credential SHAPES only; prose/code/PII are untouched.
	reqBody, respBody := in.reqBody, in.respBody
	var scrubCounts map[string]int
	if p.scrubBodies {
		var rc, sc map[string]int
		reqBody, rc = scrubBodySecrets(reqBody)
		respBody, sc = scrubBodySecrets(respBody)
		scrubCounts = mergeCounts(rc, sc)
	}

	// Request body: store as text if valid UTF-8, else base64 (keeps digest
	// deterministic — lens evidence-integrity).
	rec.Request.Raw, rec.Request.RawEncoding = encodeBody(reqBody)
	rec.Request.RawSHA256 = sha256hex(reqBody)

	// Response body + derived (untrusted) fields.
	rec.Response.Raw, rec.Response.RawEncoding = encodeBody(respBody)
	rec.Response.RawSHA256 = sha256hex(respBody)
	rec.Response.ClaimedModel = headerlessModelEcho(respBody)
	rec.Response.SystemFingerprint = systemFingerprint(respBody)

	if in.stream {
		res := ParseSSE(respBody)
		rec.Timing.StreamChunks = res.DataEvents
		rec.Response.ClaimedUsage = res.Usage
		if res.SawDone && in.complete {
			rec.Response.Complete = true
		}
	} else if respBody != nil {
		rec.Response.ClaimedUsage = extractUsage(in.provider, in.apiSurface, respBody)
	}

	if n := totalCounts(scrubCounts); n > 0 {
		note := fmt.Sprintf("scrubbed %d credential(s) from bodies before storage: %v", n, scrubCounts)
		if rec.Capture.Note == nil {
			rec.Capture.Note = &note
		} else {
			combined := *rec.Capture.Note + "; " + note
			rec.Capture.Note = &combined
		}
	}
	return rec
}

func mergeCounts(a, b map[string]int) map[string]int {
	if a == nil && b == nil {
		return nil
	}
	out := map[string]int{}
	for k, v := range a {
		out[k] += v
	}
	for k, v := range b {
		out[k] += v
	}
	return out
}

func totalCounts(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}

func (p *Proxy) submit(rec *evidence.Record) {
	_ = p.writer.Submit(rec) // false => dropped+counted; client already served
}

// --- helpers ---

func applyAuth(out *http.Request, u config.Upstream) {
	switch u.AuthMode {
	case "inject":
		out.Header.Set("Authorization", "Bearer "+u.Credential())
	default: // passthrough: leave the client's Authorization as copied
	}
}

func copyHeaders(dst, src http.Header) {
	for k, vs := range src {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

func isEventStream(h http.Header) bool {
	return strings.Contains(strings.ToLower(h.Get("Content-Type")), "text/event-stream")
}

func headerPtr(h http.Header, key string) *string {
	v := h.Get(key)
	if v == "" {
		return nil
	}
	return &v
}

// readCapped reads up to max bytes for capture, but also counts the true total
// by draining the rest. For REQUESTS the full body is needed to forward, so this
// returns the full body when under cap; callers needing the forwarded body use
// the returned slice. (Requests are rarely huge; we read fully then cap-mark.)
func readCapped(r io.Reader, max int) (body []byte, truncated bool, total int) {
	all, _ := io.ReadAll(r)
	total = len(all)
	if total > max {
		return all[:max], true, total
	}
	return all, false, total
}

func encodeBody(b []byte) (raw, encoding string) {
	if b == nil {
		return "", "utf8"
	}
	if utf8.Valid(b) {
		return string(b), "utf8"
	}
	return base64.StdEncoding.EncodeToString(b), "base64"
}

func sha256hex(b []byte) string {
	if b == nil {
		return ""
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func headerlessModelEcho(body []byte) *string {
	if body == nil {
		return nil
	}
	return extractModelFromRequest(body) // "model" key works for responses too
}

func systemFingerprint(body []byte) *string {
	if body == nil {
		return nil
	}
	var probe struct {
		SystemFingerprint string `json:"system_fingerprint"`
	}
	if jsonUnmarshal(body, &probe) && probe.SystemFingerprint != "" {
		return &probe.SystemFingerprint
	}
	return nil
}
