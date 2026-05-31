// Package evidence defines the immutable, hash-chained audit record that the
// assay (照妖镜) data plane appends to evidence.jsonl, plus the cross-language
// canonical digest and chain logic.
//
// The schema is the frozen contract in PHASE0.md §3-§4. Two rules dominate the
// design:
//
//   - The digest (see digest.go) is a custom length-prefixed typed encoding,
//     NOT JCS, so Go and Python hash byte-identically (no float/JSON/unicode
//     canonicalization divergence). All numeric fields are integers.
//   - Bodies are stored as decoded text (identity content-encoding; the proxy
//     strips Accept-Encoding upstream). raw_encoding flags a base64 fallback for
//     the rare non-UTF-8 case so the hash stays deterministic.
package evidence

// SchemaVersion is the current evidence-record schema version. Bumped only on
// breaking changes; additive optional fields do not bump it (PHASE0.md §11).
const SchemaVersion = 1

// GenesisPrevHash is the prev_hash of the seq=0 record (64 hex zeros).
const GenesisPrevHash = "0000000000000000000000000000000000000000000000000000000000000000"

// Record is one evidence entry. Field order here is documentation only; the
// hash is defined by Canon (digest.go), not by struct or JSON order.
type Record struct {
	V        int    `json:"v"`
	Seq      uint64 `json:"seq"`
	ID       string `json:"id"`        // uuidv7
	TsStart  string `json:"ts_start"`  // RFC3339Nano
	PrevHash string `json:"prev_hash"` // hex; genesis = GenesisPrevHash
	Hash     string `json:"hash"`      // hex(sha256(Canon(record))); excluded from Canon

	Route    Route    `json:"route"`
	Request  Request  `json:"request"`
	Response Response `json:"response"`
	Timing   Timing   `json:"timing"`
	Capture  Capture  `json:"capture"`
}

// Route identifies where the request went. claimed_model and the response's
// echoed model are UNTRUSTED; provider/api_surface are derived from the request
// path (PHASE0.md §6.4) and decide which checks may run.
type Route struct {
	Method       string  `json:"method"`
	Path         string  `json:"path"`
	Upstream     string  `json:"upstream"`
	ClaimedModel *string `json:"claimed_model"` // from request body.model; may be null
	Provider     string  `json:"provider"`      // openai|anthropic|gemini|unknown
	APISurface   string  `json:"api_surface"`   // chat.completions|responses|messages|generateContent|other
}

// Request is the captured client request. Headers are redacted (PHASE0.md §10)
// on a deep copy; the upstream-forwarded request is never mutated. raw is the
// exact request body; raw_sha256 lets cache/replay and privacy modes work
// without re-reading raw.
type Request struct {
	Headers     map[string][]string `json:"headers"`      // lowercase keys
	Raw         string              `json:"raw"`          // exact request body
	RawEncoding string              `json:"raw_encoding"` // utf8|base64
	RawSHA256   string              `json:"raw_sha256"`   // hex sha256 of raw bytes ("" if not computed)
	Bytes       uint64              `json:"bytes"`        // true total bytes even if truncated
	Truncated   bool                `json:"truncated"`
}

// Usage mirrors the relay-reported usage object. UNTRUSTED. Pointers distinguish
// "absent" from zero so token_recount never compares against a fabricated zero.
type Usage struct {
	PromptTokens      *uint64                  `json:"prompt_tokens,omitempty"`
	CompletionTokens  *uint64                  `json:"completion_tokens,omitempty"`
	TotalTokens       *uint64                  `json:"total_tokens,omitempty"`
	CompletionDetails *CompletionTokensDetails `json:"completion_tokens_details,omitempty"`
	PromptDetails     *PromptTokensDetails     `json:"prompt_tokens_details,omitempty"`
}

type CompletionTokensDetails struct {
	ReasoningTokens *uint64 `json:"reasoning_tokens,omitempty"`
}

type PromptTokensDetails struct {
	CachedTokens *uint64 `json:"cached_tokens,omitempty"`
}

// Response is the captured upstream response. complete=false means the stream
// ended abnormally (upstream EOF/error/timeout, or client disconnect) and the
// captured body is partial — analyzers must skip, not flag (PHASE0.md §6).
type Response struct {
	Status            int                 `json:"status"`
	Headers           map[string][]string `json:"headers"` // unmodified upstream headers, lowercase keys, UNTRUSTED
	Stream            bool                `json:"stream"`
	Complete          bool                `json:"complete"`         // saw [DONE]/clean EOF
	ContentEncoding   *string             `json:"content_encoding"` // upstream's; should be identity after AE strip
	Raw               string              `json:"raw"`
	RawEncoding       string              `json:"raw_encoding"` // utf8|base64
	RawSHA256         string              `json:"raw_sha256"`
	Bytes             uint64              `json:"bytes"`
	Truncated         bool                `json:"truncated"`
	ClaimedUsage      *Usage              `json:"claimed_usage"`      // null when stream w/o include_usage
	ClaimedModel      *string             `json:"claimed_model"`      // echoed; UNTRUSTED
	SystemFingerprint *string             `json:"system_fingerprint"` // UNTRUSTED
}

// Timing is integer microseconds (no floats — keeps the digest deterministic).
// ttft_us is null for non-stream responses. See PHASE0.md §3.1.
type Timing struct {
	TTFTUs            *uint64 `json:"ttft_us"`
	TotalUs           *uint64 `json:"total_us"`
	StreamChunks      uint64  `json:"stream_chunks"` // SSE data events with non-empty choices
	ConnReused        bool    `json:"conn_reused"`
	UpstreamConnectUs *uint64 `json:"upstream_connect_us"`
}

// Capture records the health of the capture pipeline itself (independent of the
// client outcome). tee_ok=false means evidence is incomplete (overload drop,
// redaction/decode failure) — never that the client request failed.
type Capture struct {
	TeeOk              bool    `json:"tee_ok"`
	ClientDisconnected bool    `json:"client_disconnected"`
	Note               *string `json:"note"`
}
