package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// refBlob mirrors the reference JSON produced by `assay-analyzer build-reference`
// (analyzer/assay_analyzer/reference.py). We read it to derive the signed
// Fingerprint — the signature commits to the model identity + sampling protocol
// + a content digest of these exact samples, so a tampered reference blob no
// longer matches its signed fingerprint.
type refBlob struct {
	V                  int                 `json:"v"`
	Provider           string              `json:"provider"`
	Model              string              `json:"model"`
	ModelSnapshot      string              `json:"model_snapshot"`
	Precision          string              `json:"precision"`
	PromptPoolHash     string              `json:"prompt_pool_hash"`
	SamplingParamsHash string              `json:"sampling_params_hash"`
	Samples            map[string][]string `json:"samples"`
}

// FingerprintFromReferenceFile loads a reference blob and builds the Fingerprint
// to be signed. collectedAt/method describe provenance of the genuine samples.
func FingerprintFromReferenceFile(path, collectedAt, method string) (*Fingerprint, *refBlob, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("read reference: %w", err)
	}
	var rb refBlob
	if err := json.Unmarshal(b, &rb); err != nil {
		return nil, nil, fmt.Errorf("parse reference: %w", err)
	}
	if rb.Provider == "" || rb.Model == "" || rb.PromptPoolHash == "" {
		return nil, nil, fmt.Errorf("reference missing provider/model/prompt_pool_hash")
	}
	samples := map[int][]string{}
	n := 0
	for k, v := range rb.Samples {
		pid := 0
		if _, err := fmt.Sscanf(k, "%d", &pid); err != nil {
			return nil, nil, fmt.Errorf("non-integer prompt id %q in reference", k)
		}
		samples[pid] = v
		n += len(v)
	}
	fp := &Fingerprint{
		Provider: rb.Provider, Model: rb.Model, ModelSnapshot: rb.ModelSnapshot,
		Precision:      orDefault(rb.Precision, "reference"),
		PromptPoolHash: rb.PromptPoolHash, SamplingParamsHash: rb.SamplingParamsHash,
		SamplesDigest: SamplesDigest(samples), NSamples: uint64(n),
		CollectedAt: collectedAt, CollectionMethod: orDefault(method, "official-api-direct"),
	}
	return fp, &rb, nil
}

// VerifyReferenceMatchesFingerprint recomputes the samples digest of a reference
// blob and checks it equals the signed fingerprint's — so a buyer can confirm the
// reference file they hold is exactly what was attested, not a swapped body.
func VerifyReferenceMatchesFingerprint(path string, fp *Fingerprint) error {
	_, rb, err := FingerprintFromReferenceFile(path, fp.CollectedAt, fp.CollectionMethod)
	if err != nil {
		return err
	}
	samples := map[int][]string{}
	for k, v := range rb.Samples {
		pid := 0
		_, _ = fmt.Sscanf(k, "%d", &pid)
		samples[pid] = v
	}
	if got := SamplesDigest(samples); got != fp.SamplesDigest {
		return fmt.Errorf("reference samples digest %s… does not match signed fingerprint %s…",
			short(got), short(fp.SamplesDigest))
	}
	if rb.PromptPoolHash != fp.PromptPoolHash || rb.SamplingParamsHash != fp.SamplingParamsHash {
		return fmt.Errorf("reference prompt-pool/sampling params do not match signed fingerprint")
	}
	return nil
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// LoadStatement / SaveStatement persist a single signed statement as JSON.
func LoadStatement(path string) (*Statement, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s Statement
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("parse statement: %w", err)
	}
	return &s, nil
}

func SaveStatement(s *Statement, path string) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

// SortedStatements returns statements ordered by signer key then signed_at, for
// stable registry output.
func SortedStatements(sts []*Statement) []*Statement {
	out := append([]*Statement(nil), sts...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].SignerKey != out[j].SignerKey {
			return out[i].SignerKey < out[j].SignerKey
		}
		return out[i].SignedAt < out[j].SignedAt
	})
	return out
}
