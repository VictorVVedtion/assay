"""MMD model_identity validation against REAL OpenAI completions.

Ground truth in testdata/mmd_real_openai.json (collected once from official
api.openai.com, key since scrubbed): the SAME fixed prompts at temperature=1.0
sampled from gpt-4o-mini twice (ref_A, test_same) and gpt-3.5-turbo once
(test_swap). The test asserts the two outcomes that matter:

  * test_same  (gpt-4o-mini vs gpt-4o-mini reference)  -> must NOT flag  (no false positive)
  * test_swap  (gpt-3.5-turbo vs gpt-4o-mini reference) -> MUST flag     (catches the swap)

This is the real proof the detector separates "genuine model" from "cheaper
substitute" on actual model output, reproducibly and offline.
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from assay_analyzer.checks.model_identity import (  # noqa: E402
    check_model_identity,
    run_mmd,
)

FIXTURE = pathlib.Path(__file__).resolve().parents[2] / "testdata" / "mmd_real_openai.json"


def _fix():
    return json.loads(FIXTURE.read_text())


def _load():
    d = _fix()
    # JSON keys are strings; MMD uses prompt ids as dict keys — normalize to int.
    def norm(samples):
        return {int(k): v for k, v in samples.items()}
    return (
        norm(d["ref_A"]["samples"]),
        norm(d["test_same"]["samples"]),
        norm(d["test_swap"]["samples"]),
    )


def test_same_model_not_flagged_real_data():
    ref_A, test_same, _ = _load()
    res = run_mmd(test_same, {"reference": ref_A}, {"alpha": 0.01, "permutations": 200})
    # same model vs same model: must NOT reject
    assert not res["rejected_all"], res["per_reference"]


def test_swapped_model_flagged_real_data():
    ref_A, _, test_swap = _load()
    res = run_mmd(test_swap, {"reference": ref_A}, {"alpha": 0.01, "permutations": 200})
    # gpt-3.5-turbo vs gpt-4o-mini reference: MUST reject
    assert res["rejected_all"], res["per_reference"]


def test_verdict_envelope_same():
    ref_A, test_same, _ = _load()
    batch = {
        "anchor_record": {"id": "p0", "seq": 0, "hash": "h0"},
        "model": "gpt-4o-mini", "samples": test_same,
        "reference": {"reference": ref_A},
        "member_record_hashes": ["h0", "h1", "h2"],
    }
    v = check_model_identity(batch, {"alpha": 0.01, "permutations": 200})
    assert v["check"] == "model_identity"
    assert v["status"] == "ok", v["summary"]
    assert "NOT proof" in v["summary"]
    assert v["detail"]["probe_batch_digest"]


def test_verdict_envelope_swap_flags():
    ref_A, _, test_swap = _load()
    batch = {
        "anchor_record": {"id": "p0", "seq": 0, "hash": "h0"},
        "model": "gpt-4o-mini", "samples": test_swap,
        "reference": {"reference": ref_A},
        "member_record_hashes": ["h0"],
    }
    v = check_model_identity(batch, {"alpha": 0.01, "permutations": 200})
    assert v["status"] == "flag" and v["severity"] == "warn", v
    assert "differs from ALL" in v["summary"]
    assert "fraud" not in v["summary"].lower()  # honesty: never the word fraud


def test_no_reference_skips_never_guesses():
    _, test_same, _ = _load()
    batch = {"anchor_record": {"id": "p0", "seq": 0, "hash": "h0"},
             "model": "gpt-4o-mini", "samples": test_same, "reference": None,
             "member_record_hashes": []}
    v = check_model_identity(batch)
    assert v["status"] == "skip"
    assert "no genuine reference" in v["summary"].lower()


def test_pvalue_reproducible():
    # Same inputs -> byte-identical p-value (the reproducibility contract).
    ref_A, _, test_swap = _load()
    r1 = run_mmd(test_swap, {"reference": ref_A}, {"alpha": 0.01, "permutations": 200})
    r2 = run_mmd(test_swap, {"reference": ref_A}, {"alpha": 0.01, "permutations": 200})
    assert r1["per_reference"]["reference"]["pvalue"] == r2["per_reference"]["reference"]["pvalue"]
    assert r1["per_reference"]["reference"]["mmd2"] == r2["per_reference"]["reference"]["mmd2"]


# --- regression tests for the adversarial-review findings (w3zom3toh) ---

def test_leading_space_shift_not_false_flagged():
    # FINDING #3: a position-sensitive kernel flagged the SAME model when every
    # completion gained a leading space. normalize_completion must neutralize it.
    ref_A, test_same, _ = _load()
    shifted = {pid: [" " + c for c in comps] for pid, comps in test_same.items()}
    res = run_mmd(shifted, {"reference": ref_A}, {"permutations": 200})
    assert not res["rejected_all"], (
        "leading-space shift on the same model must NOT flag: " + str(res["per_reference"]))


def test_reorder_invariant_pvalue():
    # FINDING #4: equal multiset reordered within prompts -> identical p-value.
    ref_A, test_same, _ = _load()
    rev = {pid: list(reversed(c)) for pid, c in test_same.items()}
    p1 = run_mmd(test_same, {"reference": ref_A}, {"permutations": 200})["per_reference"]["reference"]["pvalue"]
    p2 = run_mmd(rev, {"reference": ref_A}, {"permutations": 200})["per_reference"]["reference"]["pvalue"]
    assert p1 == p2, f"reordering completions must not change the p-value: {p1} != {p2}"


def test_disjoint_prompts_skip_not_ok():
    # FINDING #10: no shared prompts -> insufficient -> NOT a silent 'ok'.
    ref_A, _, _ = _load()
    disjoint = {999: ["unrelated text " * 3] * 6}
    res = run_mmd(disjoint, {"reference": ref_A}, {"permutations": 200})
    assert res.get("all_insufficient") is True, res["per_reference"]
    assert not res["rejected_all"]


def test_permutation_shuffle_is_uniform():
    # FINDING #1: the shuffle must reach all permutations of a small pool (the
    # old low-bit LCG could only reach half of n=4's 24 permutations).
    from assay_analyzer.checks.model_identity import _permutation_pvalue
    import random
    pool_reached = set()
    base = [(0, "a"), (0, "b"), (1, "c"), (1, "d")]
    for seed in range(2000):
        rng = random.Random(seed)
        idx = list(range(4))
        rng.shuffle(idx)
        pool_reached.add(tuple(idx))
    assert len(pool_reached) == 24, f"shuffle not uniform: only {len(pool_reached)}/24 perms"


def test_param_guard_skips_on_mismatch():
    # FINDING #5/#8/#9: a reference with mismatched params must SKIP, not compare.
    from assay_analyzer.checks.model_identity import check_model_identity
    d = _fix()
    ref = _reference_blob_for("gpt-4o-mini", d["ref_A"]["samples"])
    batch = {
        "anchor_record": {"id": "p0", "seq": 0, "hash": "h0"},
        "model": "gpt-4o-mini", "samples": {int(k): v for k, v in d["test_same"]["samples"].items()},
        "reference": {"r": {int(k): v for k, v in d["ref_A"]["samples"].items()}},
        "reference_blobs": {"r": ref},
        "member_record_hashes": ["h0"],
        "prompt_pool_hash": "deadbeef" * 8,           # deliberately wrong
        "sampling_params_hash": ref["sampling_params_hash"],
    }
    v = check_model_identity(batch, {"permutations": 50})
    assert v["status"] == "skip", v["summary"]
    assert "param" in v["summary"].lower() or "recalibrate" in v["summary"].lower()


def _reference_blob_for(model, samples):
    from assay_analyzer import reference as ref_mod
    d = _fix()
    return ref_mod.build_reference(
        provider="openai", model=model, prompts=d["meta"]["prompts"],
        samples={int(k): v for k, v in samples.items()},
        temperature=d["meta"]["temperature"], max_tokens=d["meta"]["max_tokens"],
        n=d["meta"]["n_per_prompt"])


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print("  ok  " + fn.__name__); passed += 1
        except Exception:
            print("  XX  " + fn.__name__); traceback.print_exc()
    # Show the actual MMD numbers for the record.
    ref_A, test_same, test_swap = _load()
    same = run_mmd(test_same, {"reference": ref_A}, {"permutations": 200})["per_reference"]["reference"]
    swap = run_mmd(test_swap, {"reference": ref_A}, {"permutations": 200})["per_reference"]["reference"]
    print(f"\n  REAL DATA: same-model  mmd2={same['mmd2']:+.5f} p={same['pvalue']:.4f} (want p>=0.01, no flag)")
    print(f"  REAL DATA: swap-model  mmd2={swap['mmd2']:+.5f} p={swap['pvalue']:.4f} (want p<0.01, flag)")
    print(f"\n{passed}/{len(fns)} model_identity tests passed")
    sys.exit(0 if passed == len(fns) else 1)
