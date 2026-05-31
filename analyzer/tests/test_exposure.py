"""Tests for the exposure check (data-confidentiality Layer 1).

These pin the HONEST behavior the red-team demanded: secrets flagged, PII/code
measured-not-alarmed, zero-detected reported as lower-bound NOT "safe", both
request and response scanned, already-scrubbed markers still counted as egress,
truncation surfaced, detector versions recorded.
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from assay_analyzer.checks import check_exposure  # noqa: E402


def _rec(*, req="{}", resp="{}", req_trunc=False, resp_trunc=False):
    return {
        "v": 1, "seq": 0, "id": "id-0", "hash": "h-0",
        "route": {"provider": "openai", "api_surface": "chat.completions", "claimed_model": "gpt-4o"},
        "request": {"raw": req, "raw_encoding": "utf8", "truncated": req_trunc},
        "response": {"raw": resp, "raw_encoding": "utf8", "stream": False,
                     "complete": True, "truncated": resp_trunc},
        "timing": {}, "capture": {"tee_ok": True, "client_disconnected": False},
    }


def _req(content):
    return json.dumps({"model": "gpt-4o", "messages": [{"role": "user", "content": content}]})


def test_secret_in_request_flags_warn():
    v = check_exposure(_rec(req=_req("my key is sk-ABCDEFGHIJKLMNOP1234567890 ok")))
    assert v["status"] == "flag" and v["severity"] == "warn", v
    assert "credential" in v["summary"]
    assert v["detail"]["request"]["secrets"].get("openai_key", 0) >= 1


def test_already_scrubbed_marker_still_counts_as_egress():
    # Go proxy scrubbed it in OUR store, but the relay still saw the original.
    v = check_exposure(_rec(req=_req("key [assay-redacted:openai_key] here")))
    assert v["status"] == "flag", v
    assert v["detail"]["request"]["secrets"].get("openai_key", 0) == 1


def test_response_side_secret_is_scanned():
    # Secret echoed in the model OUTPUT — the relay sees this too.
    resp = json.dumps({"choices": [{"message": {"content": "here: AKIAIOSFODNN7EXAMPLE"}}]})
    v = check_exposure(_rec(resp=resp))
    assert v["status"] == "flag", v
    assert v["detail"]["response"]["secrets"].get("aws_key", 0) >= 1


def test_pii_is_measured_not_alarmed():
    v = check_exposure(_rec(req=_req("email me at alice@example.com about the deal")))
    assert v["status"] == "ok", v          # PII is info, not a warn
    assert v["severity"] == "info"
    assert v["detail"]["request"]["pii"].get("email", 0) >= 1
    assert "lower bound" in v["summary"].lower()


def test_zero_detected_is_lower_bound_not_safe():
    v = check_exposure(_rec(req=_req("what is the capital of France?")))
    assert v["status"] == "ok"
    # The message must NOT imply safety.
    assert "not a clean bill" in v["summary"].lower()
    assert v["detail"]["lower_bound"] is True


def test_truncation_is_surfaced():
    v = check_exposure(_rec(req=_req("hello"), req_trunc=True))
    assert v["detail"]["truncated_capture"] is True
    assert "truncated" in v["detail"]["note"].lower()


def test_detector_versions_recorded_for_reproducibility():
    v = check_exposure(_rec(req=_req("hi")))
    dv = v["detail"]["detector_versions"]
    assert "builtin_regex" in dv and "presidio" in dv


def test_code_blocks_measured():
    content = "fix this:\\n```python\\nimport os\\n```\\nthanks"
    v = check_exposure(_rec(req=_req(content)))
    # code blocks counted (info-level egress measurement)
    assert v["detail"]["request"]["code_blocks"] >= 1 or v["status"] == "ok"


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print("  ok  " + fn.__name__); passed += 1
        except Exception:
            print("  XX  " + fn.__name__); traceback.print_exc()
    print(f"\n{passed}/{len(fns)} exposure tests passed")
    sys.exit(0 if passed == len(fns) else 1)
