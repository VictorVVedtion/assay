"""Tests for the provenance check, grounded in REAL captured evidence shapes.

The genuine-Anthropic fixtures mirror exactly what assay captured from a live
new-api-based relay (anthropic-ratelimit-*, anthropic-organization-id,
request-id req_..., body id msg_...). The masquerade fixtures strip those.
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from assay_analyzer.checks import check_provenance  # noqa: E402


def _rec(*, model, headers, body, stream=False, complete=True, provider="openai",
         surface="chat.completions"):
    return {
        "v": 1, "seq": 0, "id": "id-0", "hash": "h-0",
        "route": {"provider": provider, "api_surface": surface, "claimed_model": model},
        "request": {"raw": "{}", "raw_encoding": "utf8", "truncated": False},
        "response": {
            "raw": body, "raw_encoding": "utf8", "stream": stream,
            "complete": complete, "truncated": False, "headers": headers,
            "claimed_usage": None,
        },
        "timing": {"ttft_us": None, "total_us": None, "stream_chunks": 0},
        "capture": {"tee_ok": True, "client_disconnected": False},
    }


# Real shape captured from a live new-api relay (genuine Anthropic upstream)
GENUINE_ANTHROPIC_HEADERS = {
    "anthropic-organization-id": ["27d05362-4059-4566-82b1-f0069e6ed551"],
    "anthropic-ratelimit-requests-limit": ["20000"],
    "anthropic-ratelimit-input-tokens-limit": ["4000000"],
    "request-id": ["req_011CbaHUW7C4CXHkQSoeukHm"],
    "x-new-api-version": ["v1.0.0-rc.6"],
    "x-oneapi-request-id": ["202605310753133152533648268d9d6sxXww2yu"],
    "content-type": ["application/json"],
}
GENUINE_ANTHROPIC_BODY = json.dumps({
    "id": "msg_01Hn5gbS6ZhCZjCVcHx95tCh", "model": "claude-haiku-4-5-20251001",
    "object": "chat.completion",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "Tokyo"}}],
    "usage": {"prompt_tokens": 17, "completion_tokens": 4, "total_tokens": 21,
              "usage_source": "anthropic", "usage_semantic": "openai"},
})


def test_genuine_anthropic_passes_with_high_score():
    v = check_provenance(_rec(model="claude-haiku-4-5-20251001",
                              headers=GENUINE_ANTHROPIC_HEADERS,
                              body=GENUINE_ANTHROPIC_BODY))
    assert v["status"] == "ok", v
    d = v["detail"]
    assert d["expected_upstream"] == "anthropic"
    assert d["score"] >= 5, d
    # The relay-stack tells must be surfaced (new-api fingerprint + usage_source).
    assert any("new-api" in t for t in d["relay_stack_tells"]), d["relay_stack_tells"]
    assert any("usage_source=anthropic" in t for t in d["relay_stack_tells"]), d["relay_stack_tells"]


def test_masquerade_no_anthropic_markers_flags():
    # Claimed claude-* but response carries ZERO genuine Anthropic fingerprint
    # (e.g. an open model wrapped in OpenAI JSON and a chatcmpl- id).
    fake_headers = {"content-type": ["application/json"], "server": ["nginx"]}
    fake_body = json.dumps({
        "id": "chatcmpl-fake123", "model": "claude-opus-4-8",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hi!"}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
    })
    v = check_provenance(_rec(model="claude-opus-4-8", headers=fake_headers, body=fake_body))
    assert v["status"] == "flag", v
    assert v["severity"] == "warn"
    assert v["detail"]["score"] == 0, v["detail"]
    assert "套壳" in v["summary"] or "masquerade" in v["summary"]


def test_partial_markers_weak_flag():
    # Only org-id present, ratelimit + ids stripped -> weak provenance flag.
    headers = {"anthropic-organization-id": ["x"], "content-type": ["application/json"]}
    body = json.dumps({"id": "chatcmpl-x", "choices": [{"message": {"content": "hi"}}]})
    v = check_provenance(_rec(model="claude-opus-4-8", headers=headers, body=body))
    assert v["status"] == "flag", v
    assert 0 < v["detail"]["score"] < v["detail"]["max_score"], v["detail"]


def test_genuine_openai_shape_passes():
    headers = {
        "openai-version": ["2020-10-01"], "openai-organization": ["org-x"],
        "openai-processing-ms": ["120"], "x-request-id": ["req_x"],
        "x-ratelimit-limit-requests": ["10000"],
    }
    body = json.dumps({"id": "chatcmpl-Abc123", "model": "gpt-4o",
                       "choices": [{"message": {"content": "ok"}}],
                       "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}})
    v = check_provenance(_rec(model="gpt-4o", headers=headers, body=body))
    assert v["status"] == "ok", v
    assert v["detail"]["expected_upstream"] == "openai"


def test_antimarker_rebuilt_envelope_flags_strongly():
    # Real shape from a relay serving native /v1/messages: id is a plain UUID
    # (not msg_...) AND a conversationId field genuine Anthropic never returns.
    # Even with no positive markers, this is a POSITIVE masquerade tell.
    headers = {"content-type": ["application/json"], "x-new-api-version": ["v0.13.1"]}
    body = json.dumps({
        "id": "cf95709c-1ce5-4167-898e-1da975a8e194",
        "conversationId": "cf95709c-1ce5-4167-898e-1da975a8e194",
        "model": "claude-opus-4-7", "type": "message", "role": "assistant",
        "content": [{"type": "text", "text": "PONG"}],
        "usage": {"input_tokens": 31, "output_tokens": 2},
    })
    v = check_provenance(_rec(model="claude-opus-4-7", headers=headers, body=body,
                              provider="anthropic", surface="messages"))
    assert v["status"] == "flag", v
    assert v["detail"]["antimarkers"], "expected anti-markers to fire"
    assert "REBUILT" in v["summary"] or "rebuilt" in v["summary"]
    # both the UUID-id and the forbidden conversationId should be detected
    assert any("conversationId" in a for a in v["detail"]["antimarkers"])
    assert any("msg_" in a for a in v["detail"]["antimarkers"])


def test_genuine_msg_id_does_not_trigger_antimarker():
    # A genuine msg_ id with normal fields must NOT be flagged as rebuilt, even
    # if a UUID appears elsewhere (e.g. inside content).
    headers = dict(GENUINE_ANTHROPIC_HEADERS)
    body = json.dumps({
        "id": "msg_01Hn5gbS6ZhCZjCVcHx95tCh", "model": "claude-haiku-4-5-20251001",
        "content": [{"type": "text", "text": "ref cf95709c-1ce5-4167-898e-1da975a8e194"}],
        "usage": {"input_tokens": 5, "output_tokens": 3},
    })
    v = check_provenance(_rec(model="claude-haiku-4-5-20251001", headers=headers, body=body,
                              provider="anthropic", surface="messages"))
    assert not v["detail"]["antimarkers"], v["detail"]["antimarkers"]
    assert v["status"] == "ok", v


def test_deepseek_has_no_signature_lib_skips():
    v = check_provenance(_rec(model="deepseek-chat", headers={}, body="{}"))
    assert v["status"] == "skip"
    assert "deepseek" in v["detail"]["reason"]


def test_incomplete_skips():
    v = check_provenance(_rec(model="claude-opus-4-8", headers={}, body="", complete=False))
    assert v["status"] == "skip"


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print("  ok  " + fn.__name__); passed += 1
        except Exception:
            print("  XX  " + fn.__name__); traceback.print_exc()
    print(f"\n{passed}/{len(fns)} provenance tests passed")
    sys.exit(0 if passed == len(fns) else 1)
