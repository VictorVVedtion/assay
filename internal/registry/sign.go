package registry

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// Ed25519 signing/verification over the canonical Statement bytes. Go uses the
// crypto/ed25519 stdlib; the Python mirror (analyzer/assay_analyzer/registry.py)
// must produce/verify byte-identical signatures, pinned by shared test vectors.

// GenerateKey returns a new Ed25519 keypair as hex strings. The seed (RFC 8032
// 32-byte private key) is what a signer stores secretly; the public key (32
// bytes) is what goes in the trust store.
func GenerateKey() (pubHex, seedHex string, err error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	return hex.EncodeToString(pub), hex.EncodeToString(priv.Seed()), nil
}

// Sign signs the statement with the seed (hex 32-byte Ed25519 seed) and returns
// the hex signature. It also stamps SignerKey with the derived public key so the
// signature is bound to the key (Canon includes SignerKey).
func Sign(s *Statement, seedHex string) (sigHex string, err error) {
	seed, err := hex.DecodeString(seedHex)
	if err != nil || len(seed) != ed25519.SeedSize {
		return "", fmt.Errorf("invalid ed25519 seed (need %d hex bytes)", ed25519.SeedSize)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	s.SignerKey = hex.EncodeToString(pub) // bind sig to this key
	sig := ed25519.Sign(priv, Canon(s))
	return hex.EncodeToString(sig), nil
}

// Verify checks s.Sig against Canon(s) using s.SignerKey. It returns an error
// describing the exact failure (bad hex, wrong key size, signature mismatch) so
// callers can log precisely. A nil return means the signature is valid for the
// embedded public key — it does NOT mean the key is trusted (that is the
// trust-store / quorum layer's job).
func Verify(s *Statement) error {
	pub, err := hex.DecodeString(s.SignerKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid signer_key (need %d hex bytes)", ed25519.PublicKeySize)
	}
	sig, err := hex.DecodeString(s.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("invalid sig (need %d hex bytes)", ed25519.SignatureSize)
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), Canon(s), sig) {
		return fmt.Errorf("signature does not verify for signer_key %s…", short(s.SignerKey))
	}
	return nil
}

func short(h string) string {
	if len(h) > 12 {
		return h[:12]
	}
	return h
}
