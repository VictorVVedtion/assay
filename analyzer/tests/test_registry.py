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
    fingerprint_id,
    samples_digest,
    verify_statement,
)

VEC = pathlib.Path(__file__).resolve().parents[2] / "testdata" / "registry_vectors.json"


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
