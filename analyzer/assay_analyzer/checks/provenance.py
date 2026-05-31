"""provenance - assess whether a relay genuinely proxied to the CLAIMED upstream
(Anthropic / OpenAI / Gemini) or is masquerading / 套壳 (PHASE0.md, Phase 0.5).

WHY THIS EXISTS: token_recount is strong only for OpenAI (public tokenizer) and
SKIPS for Claude/Gemini/DeepSeek -- which dominate the 中转站 market. This check
fills exactly that gap, and it is PASSIVE (no extra cost): it reads response
headers and body markers we already capture and scores how much genuine
upstream-infrastructure fingerprint is present.

GROUNDED IN REAL EVIDENCE: captured from a live new-api-based relay proxying
Claude. A genuine Anthropic-backed response carried, even after the relay
re-wrapped the body in OpenAI format:
  - anthropic-ratelimit-* headers
  - anthropic-organization-id
  - request-id: req_011C...           (Anthropic's native request id format)
  - body id: msg_01...                (Anthropic's native message id format)
and new-api leaked its own transcode tells: usage.usage_source="anthropic",
x-new-api-version, x-oneapi-request-id.

HONEST BOUNDARY (must be in the verdict, not hidden):
  * PRESENCE of genuine upstream markers is POSITIVE evidence the relay really
    hit that upstream -- but every marker is FORGEABLE. A motivated relay can
    hand-craft anthropic-ratelimit-* headers and msg_ ids. So a "pass" is
    "consistent with genuine upstream", NEVER "proven genuine".
  * ABSENCE of markers is a WARN, not proof of fraud: the relay may strip
    upstream headers for its own reasons. It raises suspicion; it does not
    convict.
  * This check says NOTHING about WHICH model served the request (a real
    Anthropic endpoint can still serve haiku when you asked for opus). Model
    identity is Phase 1 (LLMmap / MMD). provenance answers "did this touch
    Anthropic at all", not "did you get opus".
"""

from __future__ import annotations

import json
import re
from typing import Any

from .base import Verdict, new_verdict

CHECK = "provenance"

# Per-provider genuine-upstream signatures. Each entry: (signal_name, weight,
# predicate over (headers_lower, body_text, body_obj)). Weights are evidence
# strength, not probabilities. Header keys are matched lowercased.
_REQUEST_ID_ANTHROPIC = re.compile(r"^req_[0-9A-Za-z]{8,}")
_MSG_ID_ANTHROPIC = re.compile(r'"id"\s*:\s*"msg_[0-9A-Za-z]{8,}"')
_CHATCMPL_ID_OPENAI = re.compile(r'"id"\s*:\s*"chatcmpl-[0-9A-Za-z]')
_RESP_ID_OPENAI = re.compile(r'"id"\s*:\s*"resp_[0-9A-Za-z]')

# Anti-markers: fields/shapes genuine upstreams NEVER emit. These are STRONGER
# evidence than an absent header, because a faithful pass-through proxy returns
# the upstream's envelope verbatim -- so a forbidden field proves the relay
# REBUILT the response itself (a 套壳/masquerade tell). Grounded in a real relay
# observed serving a native /v1/messages response with a plain-UUID `id` (not
# msg_...) and a conversationId field that Anthropic's API never returns.
_ANTHROPIC_NATIVE_ID_PRESENT = re.compile(r'"(?:id|message)"\s*:\s*"[a-f0-9]{8}-[a-f0-9]{4}-')  # UUID-shaped id
_ANTHROPIC_FORBIDDEN_FIELDS = ("conversationId", "conversation_id")


def _has_header_prefix(headers: dict, prefix: str) -> bool:
    return any(k.startswith(prefix) for k in headers)


def _header_eq(headers: dict, key: str) -> str | None:
    v = headers.get(key)
    if isinstance(v, list):
        return v[0] if v else None
    return v


def _anthropic_signals(h: dict, body: str) -> list[tuple[str, int, bool]]:
    rid = _header_eq(h, "request-id") or ""
    return [
        ("anthropic-ratelimit-* headers", 3, _has_header_prefix(h, "anthropic-ratelimit")),
        ("anthropic-organization-id header", 3, "anthropic-organization-id" in h),
        ("native request-id (req_...)", 2, bool(_REQUEST_ID_ANTHROPIC.match(rid))),
        ("native message id (msg_...)", 2, bool(_MSG_ID_ANTHROPIC.search(body))),
        ("anthropic-version / x-anthropic header", 1,
         any(k.startswith("anthropic-") and k != "anthropic-organization-id"
             and not k.startswith("anthropic-ratelimit") for k in h)),
    ]


def _openai_signals(h: dict, body: str) -> list[tuple[str, int, bool]]:
    return [
        ("openai-* headers (openai-version/organization/processing-ms)", 3,
         _has_header_prefix(h, "openai-")),
        ("x-request-id header", 1, "x-request-id" in h),
        ("native chatcmpl-/resp- id", 2,
         bool(_CHATCMPL_ID_OPENAI.search(body) or _RESP_ID_OPENAI.search(body))),
        ("x-ratelimit-*-requests headers", 2, _has_header_prefix(h, "x-ratelimit-limit")),
    ]


# Anti-marker detectors return a list of (description, present) — present=True
# means a forbidden shape was seen (negative provenance evidence).
def _anthropic_antimarkers(h: dict, body: str, body_obj: dict | None) -> list[str]:
    hits = []
    # genuine Anthropic /v1/messages id is "msg_..."; a UUID-shaped id where no
    # msg_ id exists means the relay minted its own envelope.
    if not _MSG_ID_ANTHROPIC.search(body) and _ANTHROPIC_NATIVE_ID_PRESENT.search(body):
        hits.append("response 'id' is a UUID, not Anthropic's native msg_ format (envelope rebuilt by relay)")
    for f in _ANTHROPIC_FORBIDDEN_FIELDS:
        if body_obj is not None and f in body_obj:
            hits.append(f"response carries '{f}' which the genuine Anthropic API never returns")
        elif body_obj is None and f'"{f}"' in body:
            hits.append(f"response carries '{f}' which the genuine Anthropic API never returns")
    return hits


def _openai_antimarkers(h: dict, body: str, body_obj: dict | None) -> list[str]:
    hits = []
    # OpenAI chat ids are chatcmpl-/resp-; a UUID id where neither exists is a tell.
    if (not _CHATCMPL_ID_OPENAI.search(body) and not _RESP_ID_OPENAI.search(body)
            and re.search(r'"id"\s*:\s*"[a-f0-9]{8}-[a-f0-9]{4}-', body)):
        hits.append("response 'id' is a UUID, not OpenAI's chatcmpl-/resp- format (envelope rebuilt by relay)")
    return hits


_ANTIMARKERS = {
    "anthropic": _anthropic_antimarkers,
    "openai": _openai_antimarkers,
}


def _gemini_signals(h: dict, body: str) -> list[tuple[str, int, bool]]:
    return [
        ("usageMetadata block (Gemini native)", 3, '"usageMetadata"' in body),
        ("candidates[] block (Gemini native)", 2, '"candidates"' in body),
        ("google server / x-goog headers", 2,
         _has_header_prefix(h, "x-goog") or ("server" in h and "scaffolding" in (_header_eq(h, "server") or "").lower())),
    ]


# new-api / one-api transcode tells: the RELAY STACK's own leaked markers. These
# don't prove the UPSTREAM but confirm a new-api-class reseller and often leak
# which real backend it used (usage_source).
def _relay_stack_tells(h: dict, body_obj: dict | None) -> list[str]:
    tells = []
    if "x-new-api-version" in h:
        tells.append("x-new-api-version=" + (_header_eq(h, "x-new-api-version") or "?"))
    if "x-oneapi-request-id" in h:
        tells.append("x-oneapi-request-id present (one-api/new-api)")
    if body_obj:
        usage = body_obj.get("usage") or {}
        if isinstance(usage, dict):
            if usage.get("usage_source"):
                tells.append("usage.usage_source=" + str(usage["usage_source"]))
            if usage.get("usage_semantic"):
                tells.append("usage.usage_semantic=" + str(usage["usage_semantic"]))
    return tells


_PROVIDER_SIGNALS = {
    "anthropic": _anthropic_signals,
    "openai": _openai_signals,
    "gemini": _gemini_signals,
}


def _expected_upstream(model: str | None, provider_route: str) -> str:
    """The upstream the CLAIMED model implies (model name is buyer-supplied in
    the request, so this is what the buyer believes they bought)."""
    m = (model or "").lower()
    if m.startswith("claude") or "claude" in m:
        return "anthropic"
    if m.startswith("gemini") or "gemini" in m:
        return "gemini"
    if m.startswith(("gpt", "o1", "o3", "o4", "chatgpt", "text-embedding")):
        return "openai"
    # deepseek and others: no header-fingerprint library yet
    if "deepseek" in m:
        return "deepseek"
    return provider_route  # fall back to path-based classification


def check_provenance(rec: dict, cfg: dict[str, Any] | None = None) -> Verdict:
    cfg = cfg or {}
    resp = rec.get("response", {})
    route = rec.get("route", {})

    if not resp.get("complete", False):
        return new_verdict(rec, CHECK, "skip", "info", "skipped: incomplete response",
                           {"reason": "incomplete"})

    headers = {k.lower(): v for k, v in (resp.get("headers") or {}).items()}
    body = resp.get("raw", "") if resp.get("raw_encoding") == "utf8" else ""
    body_obj = None
    if body and not resp.get("stream"):
        try:
            body_obj = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            body_obj = None

    model = route.get("claimed_model")
    expected = _expected_upstream(model, route.get("provider", "unknown"))
    relay_tells = _relay_stack_tells(headers, body_obj)

    detail: dict[str, Any] = {
        "claimed_model": model,
        "expected_upstream": expected,
        "relay_stack_tells": relay_tells,
        "note": "presence = consistent with genuine upstream (markers are FORGEABLE, "
                "so never 'proven genuine'); absence = suspicion, not proof; says nothing "
                "about WHICH model served you (that is Phase 1).",
    }

    sigfn = _PROVIDER_SIGNALS.get(expected)
    if sigfn is None:
        detail["reason"] = f"no provenance signature library for upstream {expected!r}"
        return new_verdict(rec, CHECK, "skip", "info",
                           f"no provenance fingerprint for {expected}", detail)

    signals = sigfn(headers, body)
    present = [(name, w) for (name, w, ok) in signals if ok]
    absent = [name for (name, w, ok) in signals if not ok]
    score = sum(w for (_, w) in present)
    max_score = sum(w for (_, w, _) in signals)

    # Anti-markers: forbidden fields/shapes that prove the relay REBUILT the
    # envelope (stronger than absent headers, which a CDN can innocently strip).
    antifn = _ANTIMARKERS.get(expected)
    antimarkers = antifn(headers, body, body_obj) if antifn else []

    detail["signals_present"] = [n for (n, _) in present]
    detail["signals_absent"] = absent
    detail["antimarkers"] = antimarkers
    detail["score"] = score
    detail["max_score"] = max_score

    # Anti-markers dominate: a forbidden field is positive evidence of a rebuilt
    # envelope, regardless of how many positive markers also appear.
    if antimarkers:
        return new_verdict(
            rec, CHECK, "flag", "warn",
            f"{expected} envelope REBUILT by relay: {antimarkers[0]} "
            f"(positive masquerade tell -- a faithful proxy returns the upstream envelope "
            f"verbatim; still not proof of which model served you -- escalate to Phase 1)",
            detail)

    # Scoring bands (deliberately conservative; this is evidence, not proof).
    strong_floor = cfg.get("strong_floor", max(5, max_score // 2))
    if score >= strong_floor:
        return new_verdict(
            rec, CHECK, "ok", "info",
            f"consistent with genuine {expected} upstream "
            f"(provenance score {score}/{max_score}; markers forgeable, not proof)",
            detail)
    if score > 0:
        return new_verdict(
            rec, CHECK, "flag", "warn",
            f"weak {expected} provenance (score {score}/{max_score}): some native markers "
            f"present but others missing -- relay may strip headers (e.g. behind a CDN), or "
            f"may not genuinely proxy {expected}. Corroborate with Phase 1 model fingerprinting.",
            detail)
    return new_verdict(
        rec, CHECK, "flag", "warn",
        f"NO genuine {expected} markers found (score 0/{max_score}): response lacks every "
        f"native {expected} fingerprint. Suspicious of masquerade/套壳, but markers are "
        f"forgeable/strippable so this is not proof -- escalate to Phase 1.",
        detail)
