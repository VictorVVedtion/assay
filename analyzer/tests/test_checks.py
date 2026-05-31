"""Unit tests for the Phase 0 checks, fed synthetic evidence records.

Deterministic and process-free — this is where check logic is pinned, separate
from the e2e wiring test.
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from assay_analyzer.checks import (  # noqa: E402
    CacheReplayState,
    check_cache_replay,
    check_throughput,
    check_token_recount,
)

PARIS = ("The capital of France is Paris. It has been the capital for centuries "
         "and remains the political and cultural heart of the country today.")


def _rec(seq=0, *, model="gpt-4o", req_messages=None, resp_content=PARIS,
         claimed_completion=None, claimed_prompt=20, reasoning=None,
         stream=False, complete=True, temperature=None, ttft_us=None, total_us=None,
         provider="openai", surface="chat.completions"):
    import json

    if req_messages is None:
        req_messages = [{"role": "user", "content": "What is the capital of France?"}]
    req_body = {"model": model, "messages": req_messages}
    if stream:
        req_body["stream"] = True
        req_body["stream_options"] = {"include_usage": True}
    if temperature is not None:
        req_body["temperature"] = temperature

    usage = None
    if claimed_completion is not None:
        usage = {"prompt_tokens": claimed_prompt, "completion_tokens": claimed_completion,
                 "total_tokens": claimed_prompt + claimed_completion}
        if reasoning is not None:
            usage["completion_tokens_details"] = {"reasoning_tokens": reasoning}

    if stream:
        chunks = []
        for w in resp_content.split():
            ev = {"choices": [{"delta": {"content": w + " "}}]}
            chunks.append("data: " + json.dumps(ev) + "\n\n")
        if usage:
            chunks.append("data: " + json.dumps({"choices": [], "usage": usage}) + "\n\n")
        chunks.append("data: [DONE]\n\n")
        resp_raw = "".join(chunks)
    else:
        body = {"model": model, "choices": [{"message": {"role": "assistant", "content": resp_content}}]}
        if usage:
            body["usage"] = usage
        resp_raw = json.dumps(body)

    return {
        "v": 1, "seq": seq, "id": f"id-{seq}", "hash": f"hash-{seq}",
        "route": {"provider": provider, "api_surface": surface, "claimed_model": model},
        "request": {"raw": json.dumps(req_body), "raw_encoding": "utf8", "truncated": False},
        "response": {"raw": resp_raw, "raw_encoding": "utf8", "stream": stream,
                     "complete": complete, "truncated": False,
                     "claimed_usage": usage},
        "timing": {"ttft_us": ttft_us, "total_us": total_us, "stream_chunks": 0},
        "capture": {"tee_ok": True, "client_disconnected": False},
    }


def test_token_recount_survives_subprocess_then_load():
    # Regression: tiktoken's lazy plugin import can raise a transient
    # "inspect has no attribute getmodulename" right after a subprocess call if
    # it hasn't been imported yet. The cached loader retries once. Reproduce the
    # condition by clearing the encoding cache and calling after a subprocess.
    import subprocess
    from assay_analyzer.checks import token_recount as tr

    tr._ENC_CACHE.clear()
    subprocess.run(["true"], capture_output=True)
    import tiktoken
    honest = len(tiktoken.get_encoding("o200k_base").encode(PARIS))
    v = check_token_recount(_rec(claimed_completion=honest), {"tolerance_pct": 4.0})
    assert v["status"] != "error", v


def test_token_recount_honest_within_tolerance():
    # tiktoken counts PARIS at ~28 tokens; claim a close, honest number.
    import tiktoken
    enc = tiktoken.get_encoding("o200k_base")
    honest = len(enc.encode(PARIS))
    v = check_token_recount(_rec(claimed_completion=honest), {"tolerance_pct": 4.0})
    assert v["status"] == "ok", v
    assert not v["detail"]["estimate_only"]


def test_token_recount_reasoning_not_falsely_flagged():
    # Reasoning model bills 500 completion (mostly hidden); visible ~28.
    # Must NOT hard-flag (one-sided floor); estimate_only must be set.
    v = check_token_recount(_rec(model="o3", claimed_completion=500, reasoning=472),
                            {"tolerance_pct": 4.0})
    assert v["status"] != "flag", v
    assert v["detail"]["estimate_only"] is True
    assert "reasoning_tokens_unverifiable" in v["detail"]["estimate_reasons"]


def test_token_recount_visible_exceeds_billed_is_flagged():
    # Honest text is ~28 tokens; relay UNDER-claims completion as 5 -> impossible.
    v = check_token_recount(_rec(claimed_completion=5), {"tolerance_pct": 4.0, "min_abs_tokens": 5})
    assert v["status"] == "flag", v
    assert v["severity"] == "critical"


def test_token_recount_billed_exceeds_visible_on_plain_model_warns():
    # Non-reasoning gpt-4o billing 500 for ~28 visible tokens IS the core
    # inflation fraud — warn flag (not critical: an unknown edge could explain a
    # smaller gap, but ~95% on plain gpt-4o must surface).
    v = check_token_recount(_rec(claimed_completion=500), {"tolerance_pct": 4.0})
    assert v["status"] == "flag", v
    assert v["severity"] == "warn", v
    assert "billed_exceeds_visible_pct" in v["detail"]


def test_token_recount_skips_non_openai():
    v = check_token_recount(_rec(model="claude-3-5-sonnet", provider="anthropic",
                                 surface="messages", claimed_completion=100), {})
    assert v["status"] == "skip"


def test_token_recount_skips_unknown_model():
    v = check_token_recount(_rec(model="totally-unknown-model", claimed_completion=100), {})
    assert v["status"] == "skip"


def test_cache_replay_flags_repeat_across_distinct_prompts():
    st = CacheReplayState(":memory:")
    v1 = check_cache_replay(_rec(seq=0, req_messages=[{"role": "user", "content": "Capital of France?"}]),
                            st, {"min_normalized_len": 64})
    v2 = check_cache_replay(_rec(seq=1, req_messages=[{"role": "user", "content": "Explain quantum physics in depth."}]),
                            st, {"min_normalized_len": 64})
    assert v1["status"] == "ok"
    assert v2["status"] == "flag", v2
    assert v2["detail"]["distinct_request_count"] == 2


def test_cache_replay_zero_width_nonce_still_caught():
    # The measured free evasion: trailing zero-width space. Normalization must
    # neutralize it so the fingerprint still collides.
    st = CacheReplayState(":memory:")
    check_cache_replay(_rec(seq=0, req_messages=[{"role": "user", "content": "A?"}]),
                       st, {"min_normalized_len": 64})
    v2 = check_cache_replay(_rec(seq=1, resp_content=PARIS + "​",
                                 req_messages=[{"role": "user", "content": "B different?"}]),
                            st, {"min_normalized_len": 64})
    assert v2["status"] == "flag", "zero-width nonce should not defeat normalization"


def test_cache_replay_temp0_determinism_not_flagged():
    st = CacheReplayState(":memory:")
    check_cache_replay(_rec(seq=0, temperature=0, req_messages=[{"role": "user", "content": "A?"}]),
                       st, {"min_normalized_len": 64})
    v2 = check_cache_replay(_rec(seq=1, temperature=0, req_messages=[{"role": "user", "content": "B?"}]),
                            st, {"min_normalized_len": 64})
    assert v2["status"] == "skip", "temp=0 determinism must not be called fraud"


def test_throughput_skips_nonstream():
    v = check_throughput(_rec(claimed_completion=100), {})
    assert v["status"] == "skip"


def test_throughput_info_on_plausible_stream():
    v = check_throughput(_rec(stream=True, claimed_completion=100, ttft_us=100_000,
                              total_us=1_100_000), {"model_class_ceiling_tps": {"default": 2000}})
    assert v["status"] == "ok"
    assert v["detail"]["tokens_per_s"] == 100.0  # 100 tokens / 1.0s


if __name__ == "__main__":
    import traceback

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ✓ {fn.__name__}")
            passed += 1
        except Exception:
            print(f"  ✗ {fn.__name__}")
            traceback.print_exc()
    print(f"\n{passed}/{len(fns)} check tests passed")
    sys.exit(0 if passed == len(fns) else 1)
