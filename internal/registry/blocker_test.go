package registry

import "testing"

// Blocker #3: two independent collectors of the SAME genuine model whose
// completions differ only by NFC form / surrounding whitespace MUST converge on
// the same SamplesDigest (hence the same FingerprintID), or the quorum silently
// collapses to single-signer references.
func TestSamplesDigestConvergesUnderNormalization(t *testing.T) {
	// "café" composed (e + combining acute) vs precomposed, plus stray whitespace.
	collectorA := map[int][]string{
		0: {"café", "  hello world  "},
		1: {"answer"},
	}
	collectorB := map[int][]string{
		0: {"café", "hello world"},
		1: {"answer\n"},
	}
	if SamplesDigest(collectorA) != SamplesDigest(collectorB) {
		t.Fatalf("collectors must converge after NFC+strip:\n A=%s\n B=%s",
			SamplesDigest(collectorA), SamplesDigest(collectorB))
	}
	// But genuinely different content must still differ.
	collectorC := map[int][]string{0: {"cafe", "hello world"}, 1: {"answer"}}
	if SamplesDigest(collectorA) == SamplesDigest(collectorC) {
		t.Fatal("distinct content must digest differently")
	}
}

// Blocker #2: prompt-id keys must parse strictly. Non-canonical keys that the old
// fmt.Sscanf("%d") collapsed to the same int must be REJECTED.
func TestParsePromptIDStrict(t *testing.T) {
	good := map[string]int{"0": 0, "1": 1, "42": 42, "1000": 1000}
	for k, want := range good {
		got, err := parsePromptID(k)
		if err != nil || got != want {
			t.Errorf("parsePromptID(%q) = %d,%v; want %d,nil", k, got, err, want)
		}
	}
	for _, bad := range []string{"01", "+1", " 1", "1 ", "1x", "١" /* Arabic-Indic 1 */, "", "-0", "1.0"} {
		if _, err := parsePromptID(bad); err == nil {
			t.Errorf("parsePromptID(%q) must be rejected as non-canonical", bad)
		}
	}
}

func TestSamplesFromBlobRejectsDuplicateAndBadKeys(t *testing.T) {
	// duplicate canonical id is impossible via a JSON object (unique keys), but a
	// bad key must hard-error rather than silently conflate.
	rb := &refBlob{Samples: map[string][]string{"01": {"x"}}}
	if _, _, err := samplesFromBlob(rb); err == nil {
		t.Fatal("samplesFromBlob must reject non-canonical key 01")
	}
	ok := &refBlob{Samples: map[string][]string{"0": {"x"}, "1": {"y"}}}
	if _, n, err := samplesFromBlob(ok); err != nil || n != 2 {
		t.Fatalf("samplesFromBlob clean case: n=%d err=%v", n, err)
	}
}
