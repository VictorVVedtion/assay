"""End-to-end (analysis-plane) test of the model_identity BATCH pipeline:
probe-tagged evidence records -> group_probe_batches -> derive_batch_verdicts,
using the REAL OpenAI fixture. Proves the runner wiring, reference resolution,
and that per-record checks correctly skip probe records.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from assay_analyzer import probe as probe_mod  # noqa: E402
from assay_analyzer import reference as ref_mod  # noqa: E402
from assay_analyzer.runner import derive_batch_verdicts, derive_verdicts  # noqa: E402
from assay_analyzer.checks import CacheReplayState  # noqa: E402

FIXTURE = pathlib.Path(__file__).resolve().parents[2] / "testdata" / "mmd_real_openai.json"


def _fix():
    return json.loads(FIXTURE.read_text())


def _probe_records(set_id: str, model: str, samples: dict[str, list[str]]):
    """Build evidence-shaped probe records (non-stream chat) tagged for a batch."""
    recs = []
    seq = 0
    for pid_str, comps in samples.items():
        pid = int(pid_str)
        for c in comps:
            body = json.dumps({"choices": [{"message": {"content": c}}],
                               "usage": {"prompt_tokens": 5, "completion_tokens": 3}})
            h = hashlib.sha256(f"{set_id}:{pid}:{seq}".encode()).hexdigest()
            recs.append({
                "v": 1, "seq": seq, "id": f"id-{seq}", "hash": h,
                "route": {"provider": "openai", "api_surface": "chat.completions",
                          "claimed_model": model},
                "request": {"raw": "{}", "raw_encoding": "utf8", "truncated": False},
                "response": {"raw": body, "raw_encoding": "utf8", "stream": False,
                             "complete": True, "truncated": False, "claimed_usage": None},
                "timing": {}, "capture": {"tee_ok": True, "client_disconnected": False,
                                          "note": probe_mod.make_probe_note(set_id, pid)},
            })
            seq += 1
    return recs


def _reference_blob(model, samples):
    d = _fix()
    return ref_mod.build_reference(
        provider="openai", model=model, prompts=d["meta"]["prompts"],
        samples={int(k): v for k, v in samples.items()},
        temperature=d["meta"]["temperature"], max_tokens=d["meta"]["max_tokens"],
        n=d["meta"]["n_per_prompt"])


def test_batch_pipeline_flags_swap():
    d = _fix()
    ref = _reference_blob("gpt-4o-mini", d["ref_A"]["samples"])
    # probe batch = the SWAP (gpt-3.5 served while we asked for gpt-4o-mini)
    recs = _probe_records("batch-swap", "gpt-4o-mini", d["test_swap"]["samples"])
    verdicts = list(derive_batch_verdicts(recs, {"model_identity": {"permutations": 200}},
                                          {"ref": ref}))
    assert len(verdicts) == 1, verdicts
    v = verdicts[0]
    assert v["check"] == "model_identity"
    assert v["status"] == "flag", v["summary"]
    assert "differs from ALL" in v["summary"]


def test_batch_pipeline_passes_same_model():
    d = _fix()
    ref = _reference_blob("gpt-4o-mini", d["ref_A"]["samples"])
    recs = _probe_records("batch-same", "gpt-4o-mini", d["test_same"]["samples"])
    verdicts = list(derive_batch_verdicts(recs, {"model_identity": {"permutations": 200}},
                                          {"ref": ref}))
    assert verdicts[0]["status"] == "ok", verdicts[0]["summary"]


def test_no_reference_skips():
    d = _fix()
    recs = _probe_records("batch-x", "gpt-4o-mini", d["test_same"]["samples"])
    verdicts = list(derive_batch_verdicts(recs, {"model_identity": {}}, {}))
    assert verdicts[0]["status"] == "skip"
    assert "no genuine reference" in verdicts[0]["summary"].lower()


def test_per_record_checks_skip_probes():
    # Probe records must NOT produce per-record verdicts (they're synthetic).
    d = _fix()
    recs = _probe_records("batch-x", "gpt-4o-mini", {"0": d["test_same"]["samples"]["0"]})
    cs = CacheReplayState(":memory:")
    try:
        per_record = list(derive_verdicts(iter(recs), {}, cs))
    finally:
        cs.close()
    assert per_record == [], f"probe records should be skipped by per-record checks, got {len(per_record)}"


def test_probe_tag_parses_setid_with_colon_and_scrub_note():
    # set_id with a ':' and an appended scrub note (';') must still parse; the
    # prompt_id is the last field (rsplit), and the scrub note is ignored.
    rec = {"capture": {"note": "assay-probe:run:2026:05:7; scrubbed 1 credential"}}
    tag = probe_mod.parse_probe_tag(rec)
    assert tag == ("run:2026:05", 7), tag


def test_reference_param_mismatch_is_detectable():
    d = _fix()
    ref = _reference_blob("gpt-4o-mini", d["ref_A"]["samples"])
    # a different prompt pool hash must be catchable
    try:
        ref_mod.verify_params(ref, "deadbeef" * 8, ref["sampling_params_hash"])
        assert False, "expected ParamMismatch"
    except ref_mod.ParamMismatch:
        pass


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print("  ok  " + fn.__name__); passed += 1
        except Exception:
            print("  XX  " + fn.__name__); traceback.print_exc()
    print(f"\n{passed}/{len(fns)} probe-pipeline tests passed")
    sys.exit(0 if passed == len(fns) else 1)
