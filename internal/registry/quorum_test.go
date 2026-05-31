package registry

import (
	"testing"
	"time"
)

// buildSignedStatement makes a statement over fp signed by seedHex.
func buildSignedStatement(t *testing.T, fp Fingerprint, signerID, seedHex, expires string) *Statement {
	t.Helper()
	st := &Statement{V: StatementVersion, Fingerprint: fp, SignerID: signerID,
		SignedAt: "2026-05-31T00:00:00Z", ExpiresAt: expires}
	sig, err := Sign(st, seedHex)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	st.Sig = sig
	return st
}

func rootKeyFor(pubHex, owner string) RootKey {
	return RootKey{KeyID: KeyIDForPubkey(pubHex), Pubkey: pubHex, Owner: owner,
		OfficialAccess: "test-direct", AddedAt: "2026-01-01T00:00:00Z"}
}

// buildTrustRoot makes a threshold-M root self-signed by the given keys.
func buildTrustRoot(t *testing.T, threshold int, keys []RootKey, seeds map[string]string, expires string) *TrustRoot {
	t.Helper()
	tr := &TrustRoot{V: 1, Role: roleReferenceRoot, Threshold: threshold, Keys: keys, Expires: expires}
	preimage := canonTrustRoot(tr)
	for _, k := range keys {
		s, e := signRaw(seeds[k.Pubkey], preimage)
		if e != nil {
			t.Fatalf("root sign: %v", e)
		}
		tr.Sigs = append(tr.Sigs, RootSig{KeyID: k.KeyID, Sig: s})
	}
	return tr
}

func TestQuorumTrustFlow(t *testing.T) {
	// 3 vetted signers, threshold 2.
	pubA, seedA, _ := GenerateKey()
	pubB, seedB, _ := GenerateKey()
	pubC, seedC, _ := GenerateKey()
	seeds := map[string]string{pubA: seedA, pubB: seedB, pubC: seedC}
	keys := []RootKey{rootKeyFor(pubA, "alice"), rootKeyFor(pubB, "bob"), rootKeyFor(pubC, "carol")}
	root := buildTrustRoot(t, 2, keys, seeds, "2027-01-01T00:00:00Z")

	now, _ := time.Parse(time.RFC3339, "2026-06-01T00:00:00Z")
	if _, _, err := VerifyTrustRoot(root, now); err != nil {
		t.Fatalf("trust root must self-verify: %v", err)
	}

	fp := Fingerprint{Provider: "openai", Model: "gpt-4o-mini", Precision: "reference",
		PromptPoolHash: "pool1", SamplingParamsHash: "params1", SamplesDigest: "dig1",
		NSamples: 250, CollectedAt: "2026-05-31T00:00:00Z", CollectionMethod: "official-api-direct"}
	future := "2027-01-01T00:00:00Z"

	// Case 1: ONE vetted signer -> NO_QUORUM.
	one := []*Statement{buildSignedStatement(t, fp, "alice", seedA, future)}
	r1, _ := EvaluateQuorum(QuorumInput{Statements: one, Root: root, Now: now})
	fq1 := r1[FingerprintID(&fp)]
	if fq1 == nil || fq1.Status != QuorumNone {
		t.Fatalf("1 signer must be NO_QUORUM, got %+v", fq1)
	}

	// Case 2: TWO distinct vetted signers of the SAME fingerprint -> PASS.
	two := []*Statement{
		buildSignedStatement(t, fp, "alice", seedA, future),
		buildSignedStatement(t, fp, "bob", seedB, future),
	}
	r2, _ := EvaluateQuorum(QuorumInput{Statements: two, Root: root, Now: now})
	fq2 := r2[FingerprintID(&fp)]
	if fq2.Status != QuorumPass || len(fq2.VettedSigners) != 2 {
		t.Fatalf("2 distinct vetted signers must PASS, got %+v", fq2)
	}

	// Case 3: same signer twice (dup) -> still NO_QUORUM (distinctness on pubkey).
	dup := []*Statement{
		buildSignedStatement(t, fp, "alice", seedA, future),
		buildSignedStatement(t, fp, "alice", seedA, future),
	}
	r3, _ := EvaluateQuorum(QuorumInput{Statements: dup, Root: root, Now: now})
	if r3[FingerprintID(&fp)].Status != QuorumNone {
		t.Fatal("duplicate signer must NOT reach quorum (distinct-pubkey rule)")
	}

	// Case 4: a non-root (community) key does NOT count toward quorum.
	_, seedX, _ := GenerateKey()
	mixed := []*Statement{
		buildSignedStatement(t, fp, "alice", seedA, future),
		buildSignedStatement(t, fp, "stranger", seedX, future),
	}
	r4, _ := EvaluateQuorum(QuorumInput{Statements: mixed, Root: root, Now: now})
	fq4 := r4[FingerprintID(&fp)]
	if fq4.Status != QuorumNone || len(fq4.CommunitySigners) != 1 {
		t.Fatalf("community key must not count toward quorum, got %+v", fq4)
	}

	// Case 5: revoke bob's key -> 2 signers drop to 1 vetted -> NO_QUORUM.
	revs := &Revocations{V: 1, Role: "revocation", RevokedKeyIDs: []string{keys[1].KeyID},
		IssuedAt: "2026-06-01T00:00:00Z"}
	eff, _, _ := VerifyTrustRoot(root, now)
	preimage := canonRevocation(revs)
	for _, k := range keys[:2] { // signed by alice+bob (>=threshold)
		s, _ := signRaw(seeds[k.Pubkey], preimage)
		revs.Sigs = append(revs.Sigs, RootSig{KeyID: k.KeyID, Sig: s})
	}
	vr, rerr := VerifyRevocations(revs, root, eff, now)
	if rerr != nil {
		t.Fatalf("revocations must verify: %v", rerr)
	}
	r5, _ := EvaluateQuorum(QuorumInput{Statements: two, Root: root, Revocations: vr, Now: now})
	if r5[FingerprintID(&fp)].Status != QuorumNone {
		t.Fatal("revoking one of two signers must drop below quorum")
	}

	// Case 6: expired signatures -> STALE, not PASS.
	past := "2026-01-01T00:00:00Z"
	expired := []*Statement{
		buildSignedStatement(t, fp, "alice", seedA, past),
		buildSignedStatement(t, fp, "bob", seedB, past),
	}
	r6, _ := EvaluateQuorum(QuorumInput{Statements: expired, Root: root, Now: now})
	if r6[FingerprintID(&fp)].Status != QuorumStale {
		t.Fatalf("expired-but-would-pass must be STALE, got %s", r6[FingerprintID(&fp)].Status)
	}
}

func TestTrustRootBelowThresholdFails(t *testing.T) {
	pubA, seedA, _ := GenerateKey()
	pubB, _, _ := GenerateKey()
	keys := []RootKey{rootKeyFor(pubA, "alice"), rootKeyFor(pubB, "bob")}
	// threshold 2 but only alice signs -> self-verify must fail.
	tr := &TrustRoot{V: 1, Role: roleReferenceRoot, Threshold: 2, Keys: keys, Expires: "2027-01-01T00:00:00Z"}
	s, _ := signRaw(seedA, canonTrustRoot(tr))
	tr.Sigs = []RootSig{{KeyID: keys[0].KeyID, Sig: s}}
	now, _ := time.Parse(time.RFC3339, "2026-06-01T00:00:00Z")
	if _, _, err := VerifyTrustRoot(tr, now); err == nil {
		t.Fatal("trust root with sigs below threshold must fail self-verification")
	}
}
