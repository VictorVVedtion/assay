package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"
)

// revocations.json — a POSITIVE, root-signed revocation list. Positive (signed
// presence) because under the offline constraint, absence-of-signature can't be
// trusted and a silently-dropped revocation must not read as "not revoked". A
// verifier applies revocations only if the list is signed by >= threshold root
// keys; an unsigned/under-signed list is IGNORED (fail-safe: better to not
// revoke than to let an attacker forge revocations of honest keys).

const domainRevocation = "assay-revocation-v1"

// Revocations lists revoked signer keyids and fingerprint ids.
type Revocations struct {
	V                     int       `json:"v"`
	Role                  string    `json:"role"`
	RevokedKeyIDs         []string  `json:"revoked_keyids"`
	RevokedFingerprintIDs []string  `json:"revoked_fingerprint_ids"`
	IssuedAt              string    `json:"issued_at"`
	Sigs                  []RootSig `json:"sigs"`
}

func canonRevocation(r *Revocations) []byte {
	buf := make([]byte, 0, 256)
	putS(&buf, domainRevocation)
	putU64(&buf, uint64(r.V))
	kids := append([]string(nil), r.RevokedKeyIDs...)
	sort.Strings(kids)
	putU64(&buf, uint64(len(kids)))
	for _, k := range kids {
		putS(&buf, k)
	}
	fps := append([]string(nil), r.RevokedFingerprintIDs...)
	sort.Strings(fps)
	putU64(&buf, uint64(len(fps)))
	for _, f := range fps {
		putS(&buf, f)
	}
	putS(&buf, r.IssuedAt)
	return buf
}

// VerifyRevocations returns the revocation list ONLY if it is signed by >=
// threshold distinct verified root keys; otherwise returns nil (ignored,
// fail-safe). effectiveRoot is the verified root key set (pubkey -> RootKey).
func VerifyRevocations(r *Revocations, root *TrustRoot, effectiveRoot map[string]RootKey, now time.Time) (*Revocations, error) {
	if r == nil {
		return nil, nil
	}
	if r.Role != "revocation" {
		return nil, fmt.Errorf("revocations: wrong role %q", r.Role)
	}
	if r.IssuedAt != "" && !ValidTimestamp(r.IssuedAt) {
		return nil, fmt.Errorf("revocations: issued_at %q not canonical RFC3339Z", r.IssuedAt)
	}
	preimage := canonRevocation(r)
	verified := map[string]bool{}
	for _, sg := range r.Sigs {
		for pub, k := range effectiveRoot {
			if k.KeyID == sg.KeyID && ed25519VerifyHex(pub, preimage, sg.Sig) {
				verified[pub] = true
			}
		}
	}
	if len(verified) < root.Threshold {
		// Under-signed: IGNORE (do not let a forged list revoke honest keys).
		return nil, fmt.Errorf("revocations under-signed (%d of %d root sigs) — ignored",
			len(verified), root.Threshold)
	}
	return r, nil
}

// LoadRevocations reads + parses a revocation file (no verification).
func LoadRevocations(path string) (*Revocations, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var r Revocations
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("parse revocations: %w", err)
	}
	return &r, nil
}
