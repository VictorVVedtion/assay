package evidence

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"sort"
	"strings"
)

// Canon returns the canonical byte encoding of a Record used as the sha256
// preimage for its hash. It is a custom length-prefixed, explicitly-typed
// encoding — deliberately NOT JCS/JSON — so an independent Python implementation
// (analyzer/assay_analyzer/digest.py) produces byte-identical output without any
// float-formatting, key-ordering, or unicode-normalization ambiguity.
//
// CONTRACT (PHASE0.md §4): every field below is encoded in this exact order with
// these exact primitives. Changing any of it changes every hash and MUST bump
// SchemaVersion. The cross-language test vectors in testdata/digest_vectors.json
// pin this; analyzer tests must reproduce them.
//
// Primitives (big-endian):
//
//	u64(n)      = 8-byte big-endian
//	b(x)        = u64(len(x)) || x
//	s(str)      = b(utf8(str))
//	optU64(p)   = 0x00 if nil else 0x01 || u64(*p)
//	optS(p)     = 0x00 if nil else 0x01 || s(*p)
//	u8b(bool)   = 0x00 / 0x01
//	hmap(h)     = u64(nKeys) || for key asc: s(key) || s(values joined by "\n")
func Canon(r *Record) []byte {
	buf := make([]byte, 0, 1024+len(r.Request.Raw)+len(r.Response.Raw))

	putS(&buf, "assay-evidence-v1") // domain separator

	putU64(&buf, r.Seq)
	putS(&buf, r.ID)
	putS(&buf, r.TsStart)
	putS(&buf, r.PrevHash)

	// route
	putS(&buf, r.Route.Method)
	putS(&buf, r.Route.Path)
	putS(&buf, r.Route.Upstream)
	putOptS(&buf, r.Route.ClaimedModel)
	putS(&buf, r.Route.Provider)
	putS(&buf, r.Route.APISurface)

	// request
	putHmap(&buf, r.Request.Headers)
	putS(&buf, r.Request.Raw)
	putS(&buf, r.Request.RawEncoding)
	putS(&buf, r.Request.RawSHA256)
	putU64(&buf, r.Request.Bytes)
	putU8b(&buf, r.Request.Truncated)

	// response
	putU64(&buf, uint64(r.Response.Status))
	putHmap(&buf, r.Response.Headers)
	putU8b(&buf, r.Response.Stream)
	putU8b(&buf, r.Response.Complete)
	putOptS(&buf, r.Response.ContentEncoding)
	putS(&buf, r.Response.Raw)
	putS(&buf, r.Response.RawEncoding)
	putS(&buf, r.Response.RawSHA256)
	putU64(&buf, r.Response.Bytes)
	putU8b(&buf, r.Response.Truncated)
	putUsage(&buf, r.Response.ClaimedUsage)
	putOptS(&buf, r.Response.ClaimedModel)
	putOptS(&buf, r.Response.SystemFingerprint)

	// timing
	putOptU64(&buf, r.Timing.TTFTUs)
	putOptU64(&buf, r.Timing.TotalUs)
	putU64(&buf, r.Timing.StreamChunks)
	putU8b(&buf, r.Timing.ConnReused)
	putOptU64(&buf, r.Timing.UpstreamConnectUs)

	// capture
	putU8b(&buf, r.Capture.TeeOk)
	putU8b(&buf, r.Capture.ClientDisconnected)
	putOptS(&buf, r.Capture.Note)

	return buf
}

// Hash returns hex(sha256(Canon(record))). The Hash field itself is excluded
// from Canon, so this is well-defined regardless of r.Hash's current value.
func Hash(r *Record) string {
	sum := sha256.Sum256(Canon(r))
	return hex.EncodeToString(sum[:])
}

// --- primitives ---

func putU64(buf *[]byte, n uint64) {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], n)
	*buf = append(*buf, b[:]...)
}

func putBytes(buf *[]byte, x []byte) {
	putU64(buf, uint64(len(x)))
	*buf = append(*buf, x...)
}

func putS(buf *[]byte, s string) { putBytes(buf, []byte(s)) }

func putOptU64(buf *[]byte, p *uint64) {
	if p == nil {
		*buf = append(*buf, 0x00)
		return
	}
	*buf = append(*buf, 0x01)
	putU64(buf, *p)
}

func putOptS(buf *[]byte, p *string) {
	if p == nil {
		*buf = append(*buf, 0x00)
		return
	}
	*buf = append(*buf, 0x01)
	putS(buf, *p)
}

func putU8b(buf *[]byte, v bool) {
	if v {
		*buf = append(*buf, 0x01)
	} else {
		*buf = append(*buf, 0x00)
	}
}

// putHmap encodes a header map deterministically: keys are sorted ascending and
// each key's values are joined by "\n". Callers store lowercase, de-duplicated
// keys (Go http.Header already merges by canonical case before lowercasing), so
// no case-merge is needed here.
func putHmap(buf *[]byte, h map[string][]string) {
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	putU64(buf, uint64(len(keys)))
	for _, k := range keys {
		putS(buf, k)
		putS(buf, strings.Join(h[k], "\n"))
	}
}

// putUsage encodes the optional usage object with a fixed sub-field order,
// flattening the nested detail objects to two optional integers.
func putUsage(buf *[]byte, u *Usage) {
	if u == nil {
		*buf = append(*buf, 0x00)
		return
	}
	*buf = append(*buf, 0x01)
	putOptU64(buf, u.PromptTokens)
	putOptU64(buf, u.CompletionTokens)
	putOptU64(buf, u.TotalTokens)

	var reasoning, cached *uint64
	if u.CompletionDetails != nil {
		reasoning = u.CompletionDetails.ReasoningTokens
	}
	if u.PromptDetails != nil {
		cached = u.PromptDetails.CachedTokens
	}
	putOptU64(buf, reasoning)
	putOptU64(buf, cached)
}
