package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"assay/internal/registry"
)

// runKey handles `assay key gen` — generate an Ed25519 signer keypair. The seed
// (secret) is written 0600; the public key is printed for sharing into trust
// stores. A contributor uses their key to sign genuine-model fingerprints.
func runKey(args []string) {
	if len(args) == 0 || args[0] != "gen" {
		fail("usage: assay key gen --out signer  (writes signer.key [0600] + signer.pub)")
	}
	fs := flag.NewFlagSet("key gen", flag.ExitOnError)
	out := fs.String("out", "signer", "output basename (.key seed + .pub public)")
	id := fs.String("id", "", "human signer label (informational; trust is the pubkey)")
	_ = fs.Parse(args[1:])

	pub, seed, err := registry.GenerateKey()
	if err != nil {
		fail("key gen: " + err.Error())
	}
	if err := os.WriteFile(*out+".key", []byte(seed+"\n"), 0o600); err != nil {
		fail("write seed: " + err.Error())
	}
	pubLine := pub
	if *id != "" {
		pubLine = pub + " " + *id
	}
	if err := os.WriteFile(*out+".pub", []byte(pubLine+"\n"), 0o644); err != nil {
		fail("write pub: " + err.Error())
	}
	fmt.Fprintf(os.Stderr, "wrote %s.key (KEEP SECRET, 0600) and %s.pub\n", *out, *out)
	fmt.Println(pubLine)
}

// runReference handles `assay reference sign|verify`.
func runReference(args []string) {
	if len(args) == 0 {
		fail("usage: assay reference sign|verify ...")
	}
	switch args[0] {
	case "sign":
		runReferenceSign(args[1:])
	case "verify":
		runReferenceVerify(args[1:])
	case "quorum":
		runReferenceQuorum(args[1:])
	default:
		fail("assay reference: unknown subcommand " + args[0] + " (want sign|verify|quorum)")
	}
}

// runReferenceQuorum evaluates the curated M-of-N trust rule over a registry and
// reports, per fingerprint, the HONEST count (K distinct vetted of N) and a
// status — never a boolean "genuine". Exit codes let scripts distinguish
// fresh-quorum (0) from stale (10) from no-quorum (20) so stale is never treated
// as proven.
func runReferenceQuorum(args []string) {
	fs := flag.NewFlagSet("reference quorum", flag.ExitOnError)
	regPath := fs.String("registry", "", "registry.jsonl of signed statements (required)")
	rootPath := fs.String("trust-root", "", "trust_root.json curated keyring (required)")
	revPath := fs.String("revocations", "", "optional revocations.json")
	model := fs.String("model", "", "optional: only report this model")
	_ = fs.Parse(args)

	if *regPath == "" || *rootPath == "" {
		fail("reference quorum: --registry and --trust-root are required")
	}
	root, err := registry.LoadTrustRoot(*rootPath)
	if err != nil {
		fail("quorum: " + err.Error())
	}
	stmts, err := registry.LoadRegistry(*regPath)
	if err != nil {
		fail("quorum: " + err.Error())
	}
	var revs *registry.Revocations
	if *revPath != "" {
		revs, err = registry.LoadRevocations(*revPath)
		if err != nil {
			fail("quorum: " + err.Error())
		}
	}
	now := time.Now().UTC()
	// Verify+filter revocations (under-signed ones are ignored, fail-safe).
	if revs != nil {
		eff, _, verr := registry.VerifyTrustRoot(root, now)
		if verr == nil {
			if vr, rerr := registry.VerifyRevocations(revs, root, eff, now); rerr != nil {
				fmt.Fprintf(os.Stderr, "⚠️  %v\n", rerr)
				revs = nil
			} else {
				revs = vr
			}
		}
	}
	results, err := registry.EvaluateQuorum(registry.QuorumInput{
		Statements: stmts, Root: root, Revocations: revs, Now: now,
	})
	if err != nil {
		fail("quorum: " + err.Error())
	}

	worst := 0 // 0 fresh-pass, 10 stale, 20 no-quorum
	any := false
	for _, fq := range results {
		if *model != "" && fq.Fingerprint.Model != *model {
			continue
		}
		any = true
		icon := map[registry.QuorumStatus]string{
			registry.QuorumPass: "✅", registry.QuorumStale: "⚠️ ", registry.QuorumNone: "❌",
		}[fq.Status]
		fmt.Printf("%s %s  %s/%s  K=%d of %d vetted (quorum>=%d)",
			icon, fq.Status, fq.Fingerprint.Provider, fq.Fingerprint.Model,
			len(fq.VettedSigners), len(root.Keys), fq.Threshold)
		if len(fq.CommunitySigners) > 0 {
			fmt.Printf("  +%d community (not counted)", len(fq.CommunitySigners))
		}
		if len(fq.ExpiredVetted) > 0 {
			fmt.Printf("  [%d expired]", len(fq.ExpiredVetted))
		}
		fmt.Printf("  fp %s…\n", fq.FingerprintID[:16])
		if fq.Status == registry.QuorumStale && worst < 10 {
			worst = 10
		}
		if fq.Status == registry.QuorumNone && worst < 20 {
			worst = 20
		}
	}
	if !any {
		fmt.Println("no fingerprints in registry" + modelSuffix(*model))
		worst = 20
	}
	fmt.Fprintln(os.Stderr,
		"note: quorum = K vetted KEYS signed the identical fingerprint. assay cannot verify the "+
			"humans behind the keys are independent; collusion or a shared poisoned upstream defeats "+
			"this. ATTESTATION, not proof of genuineness.")
	os.Exit(worst)
}

func modelSuffix(m string) string {
	if m == "" {
		return ""
	}
	return " for model " + m
}

// runReferenceSign turns a genuine reference blob (from `assay calibrate` +
// `assay-analyzer build-reference`) into a signed fingerprint statement. The
// signature commits to the model identity, the sampling protocol, and a content
// digest of the exact samples — so the blob cannot be swapped after signing.
func runReferenceSign(args []string) {
	fs := flag.NewFlagSet("reference sign", flag.ExitOnError)
	refPath := fs.String("reference", "", "path to the reference blob to attest (required)")
	keyPath := fs.String("key", "", "path to the signer seed (.key) (required)")
	out := fs.String("out", "", "output statement path (default <reference>.stmt.json)")
	signerID := fs.String("id", "", "human signer label")
	collectedAt := fs.String("collected-at", time.Now().UTC().Format("2006-01-02"),
		"date the genuine samples were collected (RFC3339 date)")
	method := fs.String("method", "official-api-direct", "collection method")
	expiresDays := fs.Int("expires-days", 90, "signature validity window in days (0 = no expiry)")
	_ = fs.Parse(args)

	if *refPath == "" || *keyPath == "" {
		fail("reference sign: --reference and --key are required")
	}
	seedBytes, err := os.ReadFile(*keyPath)
	if err != nil {
		fail("read key: " + err.Error())
	}
	seed := trimLine(string(seedBytes))

	fp, _, err := registry.FingerprintFromReferenceFile(*refPath, *collectedAt, *method)
	if err != nil {
		fail("reference sign: " + err.Error())
	}
	now := time.Now().UTC()
	expires := ""
	if *expiresDays > 0 {
		expires = now.AddDate(0, 0, *expiresDays).Format(time.RFC3339)
	}
	st := &registry.Statement{
		V: registry.StatementVersion, Fingerprint: *fp,
		SignerID: *signerID, SignedAt: now.Format(time.RFC3339), ExpiresAt: expires,
	}
	sig, err := registry.Sign(st, seed)
	if err != nil {
		fail("reference sign: " + err.Error())
	}
	st.Sig = sig

	outPath := *out
	if outPath == "" {
		outPath = *refPath + ".stmt.json"
	}
	if err := registry.SaveStatement(st, outPath); err != nil {
		fail("write statement: " + err.Error())
	}
	fmt.Fprintf(os.Stderr, "signed %s for %s/%s by %s\n  fingerprint_id %s\n  -> %s\n",
		*refPath, fp.Provider, fp.Model, st.SignerKey[:12]+"…",
		registry.FingerprintID(fp)[:16]+"…", outPath)
}

// runReferenceVerify checks a statement's signature AND (if --reference given)
// that the reference blob's content matches the signed fingerprint. This is the
// signature layer only — it confirms WHO signed WHAT, not whether that signer is
// TRUSTED (that is the quorum/trust-store layer, built next).
func runReferenceVerify(args []string) {
	fs := flag.NewFlagSet("reference verify", flag.ExitOnError)
	stmtPath := fs.String("statement", "", "path to the signed statement (required)")
	refPath := fs.String("reference", "", "optional: reference blob to check against the fingerprint")
	_ = fs.Parse(args)

	if *stmtPath == "" {
		fail("reference verify: --statement is required")
	}
	st, err := registry.LoadStatement(*stmtPath)
	if err != nil {
		fail("reference verify: " + err.Error())
	}
	if err := registry.Verify(st); err != nil {
		fmt.Fprintf(os.Stderr, "❌ signature INVALID: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("✅ signature valid — signer %s… attests %s/%s (fingerprint %s…)\n",
		st.SignerKey[:12], st.Fingerprint.Provider, st.Fingerprint.Model,
		registry.FingerprintID(&st.Fingerprint)[:16])
	if st.ExpiresAt != "" {
		if exp, perr := time.Parse(time.RFC3339, st.ExpiresAt); perr == nil && time.Now().After(exp) {
			fmt.Printf("⚠️  this attestation EXPIRED at %s\n", st.ExpiresAt)
		}
	}
	if *refPath != "" {
		if err := registry.VerifyReferenceMatchesFingerprint(*refPath, &st.Fingerprint); err != nil {
			fmt.Fprintf(os.Stderr, "❌ reference does NOT match signed fingerprint: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("✅ reference content matches the signed fingerprint")
	}
	fmt.Fprintln(os.Stderr,
		"note: a valid signature proves WHO signed WHAT, not that the signer is trusted "+
			"or the model genuine — that needs a quorum of trusted signers (assay reference quorum).")
}

func trimLine(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == ' ') {
		s = s[:len(s)-1]
	}
	return s
}
