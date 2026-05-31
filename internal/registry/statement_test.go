package registry

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func sampleFingerprint() Fingerprint {
	return Fingerprint{
		Provider: "openai", Model: "gpt-4o-mini",
		ModelSnapshot: "gpt-4o-mini-2024-07-18", Precision: "reference",
		PromptPoolHash:     "aa" + "00000000000000000000000000000000000000000000000000000000000000"[2:],
		SamplingParamsHash: "bb" + "00000000000000000000000000000000000000000000000000000000000000"[2:],
		SamplesDigest:      "cc" + "00000000000000000000000000000000000000000000000000000000000000"[2:],
		NSamples:           250,
		CollectedAt:        "2026-05-31",
		CollectionMethod:   "official-api-direct",
	}
}

func TestSamplesDigestDeterministicAndOrderInvariant(t *testing.T) {
	a := map[int][]string{0: {"x", "y", "z"}, 1: {"foo"}}
	b := map[int][]string{1: {"foo"}, 0: {"z", "x", "y"}} // reordered
	if SamplesDigest(a) != SamplesDigest(b) {
		t.Fatal("SamplesDigest must be order-invariant within a prompt and across prompt insertion order")
	}
	c := map[int][]string{0: {"x", "y"}, 1: {"foo"}}
	if SamplesDigest(a) == SamplesDigest(c) {
		t.Fatal("different multisets must digest differently")
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	pub, seed, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	s := &Statement{V: StatementVersion, Fingerprint: sampleFingerprint(),
		SignerID: "alice", SignedAt: "2026-05-31T00:00:00Z"}
	sig, err := Sign(s, seed)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	s.Sig = sig
	if s.SignerKey != pub {
		t.Fatalf("Sign must stamp SignerKey with derived pubkey: got %s want %s", s.SignerKey, pub)
	}
	if err := Verify(s); err != nil {
		t.Fatalf("Verify valid sig: %v", err)
	}
	// Tamper the fingerprint -> verify must fail.
	s.Fingerprint.Model = "gpt-4o" // not what was signed
	if err := Verify(s); err == nil {
		t.Fatal("Verify must fail after the signed fingerprint is altered")
	}
}

func TestVerifyRejectsLiftedSignature(t *testing.T) {
	// A signature made by key A must not verify if SignerKey is swapped to key B.
	_, seedA, _ := GenerateKey()
	pubB, _, _ := GenerateKey()
	s := &Statement{V: StatementVersion, Fingerprint: sampleFingerprint(),
		SignerID: "alice", SignedAt: "2026-05-31T00:00:00Z"}
	sig, _ := Sign(s, seedA)
	s.Sig = sig
	s.SignerKey = pubB // lift onto another key
	if err := Verify(s); err == nil {
		t.Fatal("Verify must reject a signature lifted onto a different signer_key")
	}
}

// TestEmitVectors writes deterministic cross-language vectors: a fixed seed, the
// canonical statement bytes (hex), and the signature. Python must reproduce the
// SAME canon bytes and verify the SAME signature. Run with UPDATE_VECTORS=1.
func TestEmitVectors(t *testing.T) {
	// Fixed 32-byte seed for determinism (NOT a real key).
	seedHex := "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
	s := &Statement{V: StatementVersion, Fingerprint: sampleFingerprint(),
		SignerID: "test-signer", SignedAt: "2026-05-31T12:00:00Z",
		ExpiresAt: "2026-08-31T12:00:00Z"}
	sig, err := Sign(s, seedHex)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	s.Sig = sig
	canonHex := hex.EncodeToString(Canon(s))
	fpID := FingerprintID(&s.Fingerprint)

	vec := map[string]any{
		"seed_hex": seedHex, "signer_key": s.SignerKey, "sig_hex": sig,
		"canon_hex": canonHex, "fingerprint_id": fpID, "statement": s,
		"samples_example": map[string]any{
			"samples": map[string][]string{"0": {"alpha", "beta"}, "1": {"gamma"}},
			"digest":  SamplesDigest(map[int][]string{0: {"alpha", "beta"}, 1: {"gamma"}}),
		},
	}
	path := filepath.Join("..", "..", "testdata", "registry_vectors.json")
	if os.Getenv("UPDATE_VECTORS") == "1" {
		out, _ := json.MarshalIndent(vec, "", "  ")
		if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
			t.Fatalf("write vectors: %v", err)
		}
		t.Logf("wrote %s", path)
	}
	// Always self-check the round trip against the file if present.
	if b, err := os.ReadFile(path); err == nil {
		var got map[string]any
		_ = json.Unmarshal(b, &got)
		if got["canon_hex"] != canonHex {
			t.Errorf("canon drift vs golden:\n got=%s\nwant=%s", canonHex, got["canon_hex"])
		}
		if got["sig_hex"] != sig {
			t.Errorf("sig drift vs golden")
		}
	}
}
