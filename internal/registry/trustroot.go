package registry

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"
)

// trust_root.json — the curated, vetted signer set (TUF root role). This is the
// trust anchor: a community reference is accepted only if >= threshold DISTINCT
// vetted keys cross-signed the identical fingerprint. It ships INSIDE the assay
// release (go:embed), so a fetched registry can never add to it; the buyer's
// trust reduces to how they obtained the release (disclosed, not cryptographic).
//
// Curated M-of-N (not M-of-N-from-anyone) is what defeats Sybil (anonymous keys
// aren't in the set) and consensus capture (a market-default substitute signed
// by 10,000 randoms is worthless — none are root keys). It does NOT defeat full
// collusion of M roots or a shared poisoned upstream — those are disclosed limits.

const (
	roleReferenceRoot = "reference-root"
	domainTrustRoot   = "assay-trust-root-v1"
)

// RootKey is one vetted signer in the trust root.
type RootKey struct {
	KeyID          string `json:"keyid"`           // sha256(pubkey)[:16] hex — human label only
	Pubkey         string `json:"pubkey"`          // 32-byte Ed25519 hex — the actual trust anchor
	Owner          string `json:"owner"`           // handle
	OfficialAccess string `json:"official_access"` // documented independent access path
	AddedAt        string `json:"added_at"`        // RFC3339Z
}

// TrustRoot is the signed keyring. sigs are by >= threshold of its OWN keys
// (self-attesting, like TUF root), so a root update is verifiable against the
// prior root the buyer already trusts.
type TrustRoot struct {
	V         int       `json:"v"`
	Role      string    `json:"role"`
	Threshold int       `json:"threshold"`
	Keys      []RootKey `json:"keys"`
	Expires   string    `json:"expires"` // RFC3339Z
	Sigs      []RootSig `json:"sigs"`
}

// RootSig is a signature over the trust root by one of its keys.
type RootSig struct {
	KeyID string `json:"keyid"`
	Sig   string `json:"sig"` // hex Ed25519 over canonTrustRoot
}

// KeyIDForPubkey derives the human keyid from a hex pubkey. Distinctness for
// quorum is on the FULL pubkey, never this truncation (redteam major).
func KeyIDForPubkey(pubkeyHex string) string {
	raw, err := hex.DecodeString(pubkeyHex)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])[:16]
}

// canonTrustRoot is the signed preimage of the trust root (excludes Sigs). New
// domain tag so a root signature can't be replayed as any other artifact.
func canonTrustRoot(tr *TrustRoot) []byte {
	buf := make([]byte, 0, 512)
	putS(&buf, domainTrustRoot)
	putU64(&buf, uint64(tr.V))
	putS(&buf, tr.Role)
	putU64(&buf, uint64(tr.Threshold))
	// keys in a frozen order: sort by pubkey
	keys := append([]RootKey(nil), tr.Keys...)
	sort.Slice(keys, func(i, j int) bool { return keys[i].Pubkey < keys[j].Pubkey })
	putU64(&buf, uint64(len(keys)))
	for _, k := range keys {
		putS(&buf, k.Pubkey)
		putS(&buf, k.Owner)
		putS(&buf, k.OfficialAccess)
		putS(&buf, k.AddedAt)
	}
	putS(&buf, tr.Expires)
	return buf
}

// VerifyTrustRoot checks the root is internally consistent and self-attested by
// >= threshold of its OWN distinct keys. Returns the set of effective (verified)
// pubkeys. It does NOT establish that the buyer SHOULD trust this root — that is
// the out-of-band release-verification step (disclosed limit).
func VerifyTrustRoot(tr *TrustRoot, now time.Time) (effective map[string]RootKey, warnings []string, err error) {
	if tr.Role != roleReferenceRoot {
		return nil, nil, fmt.Errorf("trust root: wrong role %q", tr.Role)
	}
	if tr.Threshold < 1 {
		return nil, nil, fmt.Errorf("trust root: threshold must be >= 1")
	}
	byPub := map[string]RootKey{}
	for _, k := range tr.Keys {
		if want := KeyIDForPubkey(k.Pubkey); want != k.KeyID {
			return nil, nil, fmt.Errorf("trust root: keyid %s does not match pubkey (want %s)", k.KeyID, want)
		}
		byPub[k.Pubkey] = k
	}
	preimage := canonTrustRoot(tr)
	verified := map[string]RootKey{}
	for _, sg := range tr.Sigs {
		// find the key by keyid, verify its sig over the canonical root
		for pub, k := range byPub {
			if k.KeyID != sg.KeyID {
				continue
			}
			if ed25519VerifyHex(pub, preimage, sg.Sig) {
				verified[pub] = k
			}
		}
	}
	if len(verified) < tr.Threshold {
		return nil, nil, fmt.Errorf("trust root self-attestation: only %d of required %d valid root signatures",
			len(verified), tr.Threshold)
	}
	if tr.Expires != "" {
		exp, perr := parseRFC3339Z(tr.Expires)
		if perr != nil {
			return nil, nil, fmt.Errorf("trust root: bad expires %q: %w", tr.Expires, perr)
		}
		if now.After(exp) {
			warnings = append(warnings, fmt.Sprintf("trust root EXPIRED at %s — fetch a fresh release", tr.Expires))
		}
	}
	return byPub, warnings, nil
}

// LoadTrustRoot reads + parses a trust root file (no verification).
func LoadTrustRoot(path string) (*TrustRoot, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var tr TrustRoot
	if err := json.Unmarshal(b, &tr); err != nil {
		return nil, fmt.Errorf("parse trust root: %w", err)
	}
	return &tr, nil
}
