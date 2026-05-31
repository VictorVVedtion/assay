"""Cross-language registry test: Python must reproduce the Go canonical signing
bytes AND verify a real Go-generated Ed25519 signature (testdata/registry_vectors.json).
This pins the trust-moat crypto: a buyer's Python verify == a contributor's Go sign.
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from assay_analyzer.registry import (  # noqa: E402
    canon_statement,
    ed25519_verify,
    evaluate_quorum,
    fingerprint_id,
    samples_digest,
    verify_statement,
    verify_trust_root,
)

VEC = pathlib.Path(__file__).resolve().parents[2] / "testdata" / "registry_vectors.json"
QVEC = pathlib.Path(__file__).resolve().parents[2] / "testdata" / "quorum_vectors.json"


def _vec():
    return json.loads(VEC.read_text())


def test_python_canon_matches_go():
    v = _vec()
    got = canon_statement(v["statement"]).hex()
    assert got == v["canon_hex"], f"canon drift:\n got={got}\nwant={v['canon_hex']}"


def test_python_verifies_go_signature():
    v = _vec()
    s = dict(v["statement"])
    s["sig"] = v["sig_hex"]
    s["signer_key"] = v["signer_key"]
    assert verify_statement(s), "Python must verify the Go-generated Ed25519 signature"


def test_fingerprint_id_matches_go():
    v = _vec()
    assert fingerprint_id(v["statement"]["fingerprint"]) == v["fingerprint_id"]


def test_samples_digest_matches_go():
    v = _vec()
    ex = v["samples_example"]
    samples = {int(k): val for k, val in ex["samples"].items()}
    assert samples_digest(samples) == ex["digest"]


def test_tamper_breaks_verification():
    v = _vec()
    s = dict(v["statement"]); s["sig"] = v["sig_hex"]; s["signer_key"] = v["signer_key"]
    s = json.loads(json.dumps(s))  # deep copy
    s["fingerprint"]["model"] = "gpt-4o"  # not what was signed
    assert not verify_statement(s), "altered fingerprint must fail verification"


def test_lifted_signature_rejected():
    v = _vec()
    s = dict(v["statement"]); s["sig"] = v["sig_hex"]
    s["signer_key"] = "00" * 32  # wrong key
    assert not verify_statement(s)


def test_rfc8032_known_vector():
    # RFC 8032 §7.1 Test 1 (the canonical empty-message vector): pins the vendored
    # verifier against the standard, independent of assay's own Go generator.
    pub = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a"
                        "0ee172f3daa62325af021a68f707511a")
    msg = b""
    sig = bytes.fromhex(
        "e5564300c360ac729086e2cc806e828a"
        "84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46b"
        "d25bf5f0595bbe24655141438e7a100b")
    assert ed25519_verify(pub, msg, sig), "must verify the RFC 8032 test-1 vector"
    # flip one signature byte -> must fail
    bad = bytearray(sig); bad[0] ^= 0x01
    assert not ed25519_verify(pub, msg, bytes(bad))


def test_rejects_non_canonical_point():
    # Blocker #1: a public key whose y-coordinate >= q is non-canonical; Go's
    # crypto/ed25519 rejects it and so must the vendored verifier (else a verify
    # divergence over the identical file). y = q is encoded little-endian; any
    # signature against it must be rejected at decode, returning False (not raise).
    q = 2 ** 255 - 19
    noncanon_pub = (q).to_bytes(32, "little")  # y=q, non-canonical
    assert not ed25519_verify(noncanon_pub, b"x", b"\x00" * 64)
    # y = q+1 (still >= q) likewise rejected
    noncanon_pub2 = (q + 1).to_bytes(32, "little")
    assert not ed25519_verify(noncanon_pub2, b"x", b"\x00" * 64)


def test_quorum_matches_go():
    # Python evaluate_quorum must reproduce Go's per-fingerprint verdict exactly
    # (cross-language trust-rule agreement — the moat must not be language-dependent).
    qv = json.loads(QVEC.read_text())
    got = evaluate_quorum(qv["statements"], qv["trust_root"], None, qv["now_z"])
    for fid, exp in qv["expected"].items():
        assert fid in got, f"fingerprint {fid[:12]} missing from Python quorum"
        g = got[fid]
        assert g["status"] == exp["status"], f"{exp['model']}: got {g['status']} want {exp['status']}"
        assert len(g["vetted"]) == exp["vetted"], f"{exp['model']}: vetted {len(g['vetted'])} != {exp['vetted']}"
        assert len(g["community"]) == exp["community"]


def test_quorum_trust_root_self_verifies():
    qv = json.loads(QVEC.read_text())
    assert verify_trust_root(qv["trust_root"]) is not None


def test_quorum_under_threshold_root_rejected():
    qv = json.loads(QVEC.read_text())
    tr = json.loads(json.dumps(qv["trust_root"]))  # deep copy
    tr["sigs"] = tr["sigs"][:1]  # only 1 sig, threshold is 2
    assert verify_trust_root(tr) is None
    assert evaluate_quorum(qv["statements"], tr, None, qv["now_z"]) == {}


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print("  ok  " + fn.__name__); passed += 1
        except Exception:
            print("  XX  " + fn.__name__); traceback.print_exc()
    print(f"\n{passed}/{len(fns)} registry tests passed")
    sys.exit(0 if passed == len(fns) else 1)
