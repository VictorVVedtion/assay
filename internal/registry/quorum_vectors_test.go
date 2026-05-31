package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestEmitQuorumVectors writes a full cross-language quorum scenario: a trust
// root (threshold 2) self-signed by 3 fixed-seed keys, a registry of statements
// (2 vetted sign fp1 -> PASS; 1 vetted signs fp2 -> NO_QUORUM; 1 community signs
// fp1), and the expected per-fingerprint status. The Python mirror
// (analyzer/tests/test_registry.py) must reproduce the IDENTICAL verdict, proving
// evaluate_quorum agrees across languages. UPDATE_VECTORS=1 to regenerate.
func TestEmitQuorumVectors(t *testing.T) {
	// Fixed seeds -> deterministic keys.
	seeds := []string{
		"1111111111111111111111111111111111111111111111111111111111111111",
		"2222222222222222222222222222222222222222222222222222222222222222",
		"3333333333333333333333333333333333333333333333333333333333333333",
		"4444444444444444444444444444444444444444444444444444444444444444", // community
	}
	pubs := make([]string, len(seeds))
	for i, sd := range seeds {
		p, _, err := keyFromSeed(sd)
		if err != nil {
			t.Fatalf("keyFromSeed: %v", err)
		}
		pubs[i] = p
	}
	keys := []RootKey{
		rootKeyFor(pubs[0], "alice"), rootKeyFor(pubs[1], "bob"), rootKeyFor(pubs[2], "carol"),
	}
	tr := &TrustRoot{V: 1, Role: roleReferenceRoot, Threshold: 2, Keys: keys,
		Expires: "2030-01-01T00:00:00Z"}
	pre := canonTrustRoot(tr)
	for i := 0; i < 3; i++ {
		sig, _ := signRaw(seeds[i], pre)
		tr.Sigs = append(tr.Sigs, RootSig{KeyID: keys[i].KeyID, Sig: sig})
	}

	fp1 := Fingerprint{Provider: "openai", Model: "gpt-4o-mini", Precision: "reference",
		PromptPoolHash: "pool-v1", SamplingParamsHash: "std-v1", SamplesDigest: "dig-fp1",
		NSamples: 250, CollectedAt: "2026-05-31T00:00:00Z", CollectionMethod: "official-api-direct"}
	fp2 := fp1
	fp2.Model = "gpt-4o"
	fp2.SamplesDigest = "dig-fp2"

	mk := func(fp Fingerprint, idx int) *Statement {
		st := &Statement{V: StatementVersion, Fingerprint: fp, SignerID: keys0name(idx),
			SignedAt: "2026-05-31T00:00:00Z", ExpiresAt: "2030-01-01T00:00:00Z"}
		sig, _ := Sign(st, seeds[idx])
		st.Sig = sig
		return st
	}
	statements := []*Statement{
		mk(fp1, 0), // alice -> fp1
		mk(fp1, 1), // bob   -> fp1  => PASS (2 vetted)
		mk(fp2, 0), // alice -> fp2  => NO_QUORUM (1 vetted)
		mk(fp1, 3), // community -> fp1 (not counted)
	}

	now, _ := time.Parse(time.RFC3339, "2026-06-01T00:00:00Z")
	res, err := EvaluateQuorum(QuorumInput{Statements: statements, Root: tr, Now: now})
	if err != nil {
		t.Fatalf("EvaluateQuorum: %v", err)
	}
	expect := map[string]string{
		FingerprintID(&fp1): "PASS",
		FingerprintID(&fp2): "NO_QUORUM",
	}
	for fid, want := range expect {
		if res[fid] == nil || string(res[fid].Status) != want {
			t.Fatalf("fp %s: got %v want %s", fid[:12], res[fid], want)
		}
	}

	vec := map[string]any{
		"trust_root": tr,
		"statements": statements,
		"now_z":      "2026-06-01T00:00:00Z",
		"expected": map[string]any{
			FingerprintID(&fp1): map[string]any{"status": "PASS", "model": "gpt-4o-mini", "vetted": 2, "community": 1},
			FingerprintID(&fp2): map[string]any{"status": "NO_QUORUM", "model": "gpt-4o", "vetted": 1, "community": 0},
		},
	}
	path := filepath.Join("..", "..", "testdata", "quorum_vectors.json")
	if os.Getenv("UPDATE_VECTORS") == "1" {
		out, _ := json.MarshalIndent(vec, "", "  ")
		if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
			t.Fatalf("write quorum vectors: %v", err)
		}
		t.Logf("wrote %s", path)
	}
}

func keys0name(i int) string { return []string{"alice", "bob", "carol", "stranger"}[i] }
