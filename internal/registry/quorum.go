package registry

import (
	"sort"
	"time"
)

// The quorum algorithm: given a set of signed statements + a verified trust root
// + a revocation list, decide whether a fingerprint is community-attested at
// quorum. It NEVER returns a boolean "genuine" — it returns the honest count
// (K distinct vetted pubkeys of N) and a status, and the caller surfaces the
// attestation-not-proof framing.
//
// Redteam fixes baked in: distinctness is on the FULL 32-byte pubkey (not the
// truncated keyid); timestamps parse via the frozen RFC3339Z grammar; community
// (non-root) signatures are counted SEPARATELY and never toward K.

// QuorumStatus is the outcome for one fingerprint.
type QuorumStatus string

const (
	QuorumPass  QuorumStatus = "PASS"      // >= threshold distinct vetted signers, all fresh
	QuorumStale QuorumStatus = "STALE"     // would pass but some/all signatures expired
	QuorumNone  QuorumStatus = "NO_QUORUM" // below threshold of fresh vetted signers
)

// FingerprintQuorum is the per-fingerprint verdict.
type FingerprintQuorum struct {
	FingerprintID    string
	Fingerprint      Fingerprint
	Status           QuorumStatus
	Threshold        int
	VettedSigners    []string // distinct vetted pubkeys (fresh) that signed
	ExpiredVetted    []string // vetted pubkeys whose signature expired
	CommunitySigners []string // distinct non-root pubkeys (DISPLAY ONLY, never counted)
	Warnings         []string
}

// QuorumInput bundles the verification context.
type QuorumInput struct {
	Statements  []*Statement
	Root        *TrustRoot
	Revocations *Revocations
	Now         time.Time
}

// EvaluateQuorum runs the trust rule over all statements and returns one verdict
// per distinct FingerprintID. rootKeys must already be the VERIFIED effective
// root (from VerifyTrustRoot), minus revoked keyids.
func EvaluateQuorum(in QuorumInput) (map[string]*FingerprintQuorum, error) {
	effective, _, err := VerifyTrustRoot(in.Root, in.Now)
	if err != nil {
		return nil, err
	}
	// Build trusted pubkey set, minus revoked keyids.
	revokedKey := map[string]bool{}
	revokedFp := map[string]bool{}
	if in.Revocations != nil {
		for _, kid := range in.Revocations.RevokedKeyIDs {
			revokedKey[kid] = true
		}
		for _, fp := range in.Revocations.RevokedFingerprintIDs {
			revokedFp[fp] = true
		}
	}
	trustedPub := map[string]bool{}
	for pub, k := range effective {
		if !revokedKey[k.KeyID] {
			trustedPub[pub] = true
		}
	}

	out := map[string]*FingerprintQuorum{}
	for _, st := range in.Statements {
		fpID := FingerprintID(&st.Fingerprint)
		if revokedFp[fpID] {
			continue // fingerprint explicitly revoked
		}
		if err := Verify(st); err != nil {
			continue // bad signature — ignore the statement entirely
		}
		fq := out[fpID]
		if fq == nil {
			fq = &FingerprintQuorum{FingerprintID: fpID, Fingerprint: st.Fingerprint,
				Threshold: in.Root.Threshold}
			out[fpID] = fq
		}
		fresh := true
		if st.ExpiresAt != "" {
			exp, perr := parseRFC3339Z(st.ExpiresAt)
			if perr != nil {
				fq.Warnings = appendUniq(fq.Warnings, "statement with malformed expires_at ignored")
				continue
			}
			if in.Now.After(exp) {
				fresh = false
			}
		}
		if trustedPub[st.SignerKey] {
			if fresh {
				fq.VettedSigners = appendUniq(fq.VettedSigners, st.SignerKey)
			} else {
				fq.ExpiredVetted = appendUniq(fq.ExpiredVetted, st.SignerKey)
			}
		} else {
			fq.CommunitySigners = appendUniq(fq.CommunitySigners, st.SignerKey)
		}
	}

	for _, fq := range out {
		sort.Strings(fq.VettedSigners)
		sort.Strings(fq.ExpiredVetted)
		sort.Strings(fq.CommunitySigners)
		switch {
		case len(fq.VettedSigners) >= fq.Threshold:
			fq.Status = QuorumPass
		case len(fq.VettedSigners)+len(fq.ExpiredVetted) >= fq.Threshold:
			fq.Status = QuorumStale // would pass but for expiry
		default:
			fq.Status = QuorumNone
		}
	}
	return out, nil
}

func appendUniq(s []string, v string) []string {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}
