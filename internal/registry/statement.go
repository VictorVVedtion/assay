// Package registry implements the community signed reference fingerprint
// registry (Phase 2, the trust moat). A buyer with no official LLM access can
// import a genuine-model reference and trust it because multiple INDEPENDENT
// parties cross-signed the SAME fingerprint.
//
// This file defines the canonical, signed-statement byte encoding. Like the
// evidence digest (internal/evidence/digest.go) it is a length-prefixed,
// explicitly-typed encoding — NOT JSON/JCS — so Go and Python produce
// byte-identical signing preimages (no float/key-order/unicode ambiguity). The
// Python mirror is analyzer/assay_analyzer/registry.py; shared signature test
// vectors in testdata/registry_vectors.json pin them together.
package registry

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// normalizeCompletion MUST match analyzer normalize_completion (NFC + strip) so
// the signed samples digest binds the SAME bytes the MMD kernel consumes — this
// is what lets two independent collectors of the same model converge on one
// FingerprintID (redteam blocker #3). strings.TrimSpace matches Python str.strip
// for the ASCII+common-unicode whitespace both treat as space.
func normalizeCompletion(s string) string {
	return strings.TrimSpace(norm.NFC.String(s))
}

// StatementVersion is the signed-statement schema version. A bump changes the
// signing preimage and invalidates old signatures, so bump only on a breaking
// change to WHICH bytes are signed.
const StatementVersion = 1

// domainTag is prepended to every signing preimage so a signature over an assay
// fingerprint statement can never be confused with a signature over any other
// assay artifact (domain separation).
const domainTag = "assay-fingerprint-statement-v1"

// Fingerprint is the genuine-model attestation payload. It binds the model
// identity AND the exact sampling protocol AND a content digest of the genuine
// completions, so a signature commits to all of it. The completions themselves
// live in the reference blob; the statement carries only their digest, keeping
// the signed object small and the blob independently verifiable against it.
type Fingerprint struct {
	Provider           string `json:"provider"`
	Model              string `json:"model"`
	ModelSnapshot      string `json:"model_snapshot"`       // e.g. gpt-4o-mini-2024-07-18; "" if unknown
	Precision          string `json:"precision"`            // reference|fp32|fp16|... label
	PromptPoolHash     string `json:"prompt_pool_hash"`     // sha256 of the shared canonical prompt pool
	SamplingParamsHash string `json:"sampling_params_hash"` // sha256 of temp|max_tokens|n
	SamplesDigest      string `json:"samples_digest"`       // sha256 of the canonical completions (see SamplesDigest)
	NSamples           uint64 `json:"n_samples"`            // total completions behind the digest
	CollectedAt        string `json:"collected_at"`         // RFC3339 date the genuine samples were collected
	CollectionMethod   string `json:"collection_method"`    // e.g. "official-api-direct"
}

// Statement is a Fingerprint plus the signer identity and validity window. It is
// the object that gets signed (via Canon) and carries one signer's signature.
// Multiple signers each produce their own Statement over the SAME Fingerprint;
// the registry groups them and the quorum rule counts distinct trusted signers.
type Statement struct {
	V           int         `json:"v"`
	Fingerprint Fingerprint `json:"fingerprint"`
	SignerID    string      `json:"signer_id"`  // human label; the trust anchor is the pubkey, not this
	SignerKey   string      `json:"signer_key"` // hex Ed25519 public key (32 bytes)
	SignedAt    string      `json:"signed_at"`  // RFC3339 when this signer signed
	ExpiresAt   string      `json:"expires_at"` // RFC3339; "" = no expiry (discouraged)
	Sig         string      `json:"sig"`        // hex Ed25519 signature over Canon(statement); excluded from Canon
}

// FingerprintID is the stable identity of WHAT is being attested — the digest of
// the Fingerprint alone (no signer, no signature). Distinct signers attesting
// the same genuine model produce statements with the SAME FingerprintID, which
// is how the quorum rule groups them.
func FingerprintID(f *Fingerprint) string {
	sum := sha256.Sum256(canonFingerprint(f))
	return hex.EncodeToString(sum[:])
}

// Canon returns the exact bytes a signer signs: domainTag || version ||
// canon(fingerprint) || signer identity || validity. The Sig field is excluded
// (you cannot sign your own signature). SignerKey IS included so a signature is
// bound to the key that made it (prevents lifting a sig onto another key).
func Canon(s *Statement) []byte {
	buf := make([]byte, 0, 512)
	putS(&buf, domainTag)
	putU64(&buf, uint64(s.V))
	buf = append(buf, canonFingerprint(&s.Fingerprint)...)
	putS(&buf, s.SignerID)
	putS(&buf, s.SignerKey)
	putS(&buf, s.SignedAt)
	putS(&buf, s.ExpiresAt)
	return buf
}

func canonFingerprint(f *Fingerprint) []byte {
	buf := make([]byte, 0, 256)
	putS(&buf, "fingerprint")
	putS(&buf, f.Provider)
	putS(&buf, f.Model)
	putS(&buf, f.ModelSnapshot)
	putS(&buf, f.Precision)
	putS(&buf, f.PromptPoolHash)
	putS(&buf, f.SamplingParamsHash)
	putS(&buf, f.SamplesDigest)
	putU64(&buf, f.NSamples)
	putS(&buf, f.CollectedAt)
	putS(&buf, f.CollectionMethod)
	return buf
}

// SamplesDigest computes the canonical content digest of genuine completions,
// the value that goes in Fingerprint.SamplesDigest. samples: prompt_id -> list
// of completion strings. Order-independent within a prompt (completions sorted)
// so two collectors of the same multiset get the same digest; prompt ids sorted
// numerically. This lets any holder of the reference blob verify it matches the
// signed fingerprint, and lets independent collectors converge on one ID.
func SamplesDigest(samples map[int][]string) string {
	h := sha256.New()
	h.Write([]byte("assay-samples-v1"))
	pids := make([]int, 0, len(samples))
	for pid := range samples {
		pids = append(pids, pid)
	}
	sort.Ints(pids)
	for _, pid := range pids {
		var pidb [8]byte
		binary.BigEndian.PutUint64(pidb[:], uint64(pid))
		h.Write(pidb[:])
		comps := make([]string, 0, len(samples[pid]))
		for _, c := range samples[pid] {
			comps = append(comps, normalizeCompletion(c)) // blocker #3: bind normalized bytes
		}
		sort.Strings(comps)
		var n [8]byte
		binary.BigEndian.PutUint64(n[:], uint64(len(comps)))
		h.Write(n[:])
		for _, c := range comps {
			binary.BigEndian.PutUint64(n[:], uint64(len(c)))
			h.Write(n[:])
			h.Write([]byte(c))
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

// --- length-prefixed primitives (mirror internal/evidence/digest.go) ---

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
