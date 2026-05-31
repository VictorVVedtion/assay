package evidence

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func pu(n uint64) *uint64 { return &n }
func ps(s string) *string { return &s }

// vector is one entry in testdata/digest_vectors.json — the shared cross-language
// golden. Go generates it (UPDATE_VECTORS=1); both Go and Python assert against it.
type vector struct {
	Name     string `json:"name"`
	Record   Record `json:"record"`
	CanonHex string `json:"canon_hex"`
	Hash     string `json:"hash"`
}

func sampleRecords() []vector {
	return []vector{
		{
			Name: "minimal-nonstream",
			Record: Record{
				V: 1, Seq: 0,
				ID:       "0192f0aa-0000-7000-8000-000000000001",
				TsStart:  "2026-05-30T12:00:00.000000000Z",
				PrevHash: GenesisPrevHash,
				Route: Route{
					Method: "POST", Path: "/v1/chat/completions",
					Upstream: "https://relay.example.com", ClaimedModel: ps("gpt-4o"),
					Provider: "openai", APISurface: "chat.completions",
				},
				Request: Request{
					Headers:     map[string][]string{"authorization": {"REDACTED"}, "content-type": {"application/json"}},
					Raw:         `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`,
					RawEncoding: "utf8",
					RawSHA256:   "11" + "00000000000000000000000000000000000000000000000000000000000000"[2:],
					Bytes:       62,
				},
				Response: Response{
					Status: 200, Headers: map[string][]string{"content-type": {"application/json"}},
					Stream: false, Complete: true,
					Raw:         `{"id":"chatcmpl-x","model":"gpt-4o","choices":[{"message":{"role":"assistant","content":"hello"}}],"usage":{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}}`,
					RawEncoding: "utf8",
					RawSHA256:   "22" + "00000000000000000000000000000000000000000000000000000000000000"[2:],
					Bytes:       170,
					ClaimedUsage: &Usage{
						PromptTokens: pu(8), CompletionTokens: pu(1), TotalTokens: pu(9),
					},
					ClaimedModel: ps("gpt-4o"),
				},
				Timing:  Timing{TTFTUs: nil, TotalUs: pu(845000), StreamChunks: 0, ConnReused: false, UpstreamConnectUs: pu(83000)},
				Capture: Capture{TeeOk: true, ClientDisconnected: false},
			},
		},
		{
			Name: "stream-reasoning-cached",
			Record: Record{
				V: 1, Seq: 1,
				ID:       "0192f0aa-0000-7000-8000-000000000002",
				TsStart:  "2026-05-30T12:00:01.250000000Z",
				PrevHash: "abc1230000000000000000000000000000000000000000000000000000000000",
				Route: Route{
					Method: "POST", Path: "/v1/chat/completions",
					Upstream: "https://relay.example.com", ClaimedModel: ps("o3"),
					Provider: "openai", APISurface: "chat.completions",
				},
				Request: Request{
					Headers:     map[string][]string{"authorization": {"REDACTED"}},
					Raw:         `{"model":"o3","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"think"}]}`,
					RawEncoding: "utf8", RawSHA256: "33" + "00000000000000000000000000000000000000000000000000000000000000"[2:],
					Bytes: 110,
				},
				Response: Response{
					Status: 200, Headers: map[string][]string{"content-type": {"text/event-stream"}},
					Stream: true, Complete: true,
					Raw:         "data: {\"choices\":[{\"delta\":{\"content\":\"42\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":900,\"total_tokens\":912,\"completion_tokens_details\":{\"reasoning_tokens\":898},\"prompt_tokens_details\":{\"cached_tokens\":10}}}\n\ndata: [DONE]\n\n",
					RawEncoding: "utf8", RawSHA256: "44" + "00000000000000000000000000000000000000000000000000000000000000"[2:],
					Bytes: 240,
					ClaimedUsage: &Usage{
						PromptTokens: pu(12), CompletionTokens: pu(900), TotalTokens: pu(912),
						CompletionDetails: &CompletionTokensDetails{ReasoningTokens: pu(898)},
						PromptDetails:     &PromptTokensDetails{CachedTokens: pu(10)},
					},
					ClaimedModel: ps("o3"), SystemFingerprint: ps("fp_abc123"),
				},
				Timing:  Timing{TTFTUs: pu(410000), TotalUs: pu(5200000), StreamChunks: 1, ConnReused: true, UpstreamConnectUs: pu(0)},
				Capture: Capture{TeeOk: true, ClientDisconnected: false},
			},
		},
		{
			Name: "nulls-base64-incomplete",
			Record: Record{
				V: 1, Seq: 2,
				ID:       "0192f0aa-0000-7000-8000-000000000003",
				TsStart:  "2026-05-30T12:00:02.000000000Z",
				PrevHash: "def4560000000000000000000000000000000000000000000000000000000000",
				Route: Route{
					Method: "POST", Path: "/v1/chat/completions",
					Upstream: "https://relay.example.com", ClaimedModel: nil,
					Provider: "unknown", APISurface: "other",
				},
				Request: Request{
					Headers:     map[string][]string{},
					Raw:         "q6w9", // pretend base64 of non-utf8 bytes
					RawEncoding: "base64", RawSHA256: "",
					Bytes: 3, Truncated: false,
				},
				Response: Response{
					Status: 200, Headers: map[string][]string{},
					Stream: true, Complete: false, ContentEncoding: nil,
					Raw:         "data: {\"choices\":[{\"delta\":{\"content\":\"partia",
					RawEncoding: "utf8", RawSHA256: "",
					Bytes: 9000000, Truncated: true,
					ClaimedUsage: nil, ClaimedModel: nil, SystemFingerprint: nil,
				},
				Timing:  Timing{TTFTUs: pu(120000), TotalUs: nil, StreamChunks: 1, ConnReused: false, UpstreamConnectUs: nil},
				Capture: Capture{TeeOk: false, ClientDisconnected: true, Note: ps("body cap reached; client_disconnect")},
			},
		},
	}
}

func TestDigestVectors(t *testing.T) {
	samples := sampleRecords()
	for i := range samples {
		samples[i].CanonHex = hex.EncodeToString(Canon(&samples[i].Record))
		samples[i].Hash = Hash(&samples[i].Record)
	}

	goldenPath := filepath.Join("..", "..", "testdata", "digest_vectors.json")

	if os.Getenv("UPDATE_VECTORS") == "1" {
		out, err := json.MarshalIndent(samples, "", "  ")
		if err != nil {
			t.Fatalf("marshal vectors: %v", err)
		}
		out = append(out, '\n')
		if err := os.WriteFile(goldenPath, out, 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("wrote %d vectors to %s", len(samples), goldenPath)
	}

	goldenBytes, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden (run once with UPDATE_VECTORS=1): %v", err)
	}
	var golden []vector
	if err := json.Unmarshal(goldenBytes, &golden); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	if len(golden) != len(samples) {
		t.Fatalf("golden has %d vectors, samples %d", len(golden), len(samples))
	}

	for i, g := range golden {
		// Go regression: recomputing from the golden's parsed record must match.
		gotCanon := hex.EncodeToString(Canon(&g.Record))
		gotHash := Hash(&g.Record)
		if gotCanon != g.CanonHex {
			t.Errorf("[%s] canon mismatch vs golden\n got=%s\nwant=%s", g.Name, gotCanon, g.CanonHex)
		}
		if gotHash != g.Hash {
			t.Errorf("[%s] hash mismatch vs golden\n got=%s\nwant=%s", g.Name, gotHash, g.Hash)
		}
		// Determinism: Canon must be byte-stable across calls.
		if !bytes.Equal(Canon(&g.Record), Canon(&golden[i].Record)) {
			t.Errorf("[%s] Canon not deterministic", g.Name)
		}
		// Sanity: hash is sha256 hex of canon.
		if len(g.Hash) != 64 {
			t.Errorf("[%s] hash not 64 hex chars: %q", g.Name, g.Hash)
		}
	}
}
