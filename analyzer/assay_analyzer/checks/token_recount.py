"""token_recount — independently recompute OpenAI usage with tiktoken and compare
against the relay-reported numbers (PHASE0.md §6.1).

Hardened against the red-team's measured false positives:

  * Reasoning models (o1/o3/o4/gpt-5, or any response carrying
    ``reasoning_tokens``) bill hidden thinking tokens that are NEVER delivered,
    so visible-text recompute UNDER-counts by 50-99%. We treat the recompute as
    a one-sided FLOOR: flag only genuine OVER-claim where visible tokens exceed
    billed tokens — reasoning can only ever explain recomputed < claimed, never
    the reverse.
  * tools/function-calls and multimodal inputs add untracked tokens → estimate
    only (warn ceiling), never a hard accusation.
  * Unknown / non-OpenAI models, non-chat surfaces, truncated or incomplete
    captures, and streams without usage → skip (never guess).
  * Honest limit, surfaced in the verdict: a relay can pad the prompt it forwards
    UPSTREAM; we recompute against YOUR request, so prompt-side inflation by the
    relay is invisible here.
"""

from __future__ import annotations

import json
from typing import Any

from .. import evidence as ev
from .base import Verdict, new_verdict

CHECK = "token_recount"

# Cache of loaded tiktoken encodings, keyed by encoding name. Loading is cached
# both to avoid repeated disk/BPE work and to make load failures robust: tiktoken
# lazily imports its encoding plugins via importlib on first touch, and in some
# interpreter states (observed after a subprocess call) that first touch raises a
# transient "module 'inspect' has no attribute 'getmodulename'" — a known
# import-machinery race. A one-time retry clears it. Discovered when validating
# against genuine api.openai.com traffic (synthetic tests imported tiktoken
# earlier, so they never hit the race).
_ENC_CACHE: dict[str, object] = {}


def _load_encoding(encoding: str):
    """Load (and cache) a tiktoken encoding, retrying once past the transient
    lazy-import race. Returns the encoding or raises the second failure."""
    if encoding in _ENC_CACHE:
        return _ENC_CACHE[encoding]
    import tiktoken

    last_exc = None
    for _ in range(2):
        try:
            enc = tiktoken.get_encoding(encoding)
            _ENC_CACHE[encoding] = enc
            return enc
        except (AttributeError, ImportError) as e:
            last_exc = e  # transient import-machinery race; retry once
    raise last_exc


# Ordered prefix → tiktoken encoding. Data-driven so new models are a config/data
# change, never a code change (PHASE0.md §6.4). Unknown → skip.
_ENCODING_PREFIXES: list[tuple[str, str]] = [
    ("o1", "o200k_base"), ("o3", "o200k_base"), ("o4", "o200k_base"),
    ("gpt-5", "o200k_base"), ("gpt-4.1", "o200k_base"), ("gpt-4o", "o200k_base"),
    ("chatgpt-4o", "o200k_base"),
    ("gpt-4", "cl100k_base"), ("gpt-3.5", "cl100k_base"),
    ("text-embedding-3", "cl100k_base"), ("text-embedding-ada", "cl100k_base"),
]

_REASONING_PREFIXES = ("o1", "o3", "o4", "gpt-5")

# Chat framing constants (PHASE0.md §6.1). Per-model overridable via config.
_TOKENS_PER_MESSAGE = 3
_TOKENS_PER_NAME = 1
_REPLY_PRIMING = 3


def _encoding_for(model: str | None) -> str | None:
    if not model:
        return None
    m = model.lower()
    for prefix, enc in _ENCODING_PREFIXES:
        if m.startswith(prefix):
            return enc
    return None


def _is_reasoning(model: str | None, rec: dict) -> bool:
    if ev.reasoning_tokens(rec) is not None:
        return True
    if not model:
        return False
    return model.lower().startswith(_REASONING_PREFIXES)


def _request_has_tools_or_multimodal(req_raw: str) -> bool:
    try:
        body = json.loads(req_raw)
    except (json.JSONDecodeError, TypeError):
        return False
    if body.get("tools") or body.get("functions") or body.get("tool_choice"):
        return True
    mods = body.get("modalities")
    if isinstance(mods, list) and any(x != "text" for x in mods):
        return True
    for msg in body.get("messages", []) or []:
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") in {
                    "image_url", "input_audio", "image", "file", "input_image",
                }:
                    return True
    return False


def _response_has_tool_calls(rec: dict) -> bool:
    raw = rec.get("response", {}).get("raw", "")
    if rec.get("response", {}).get("stream"):
        return '"tool_calls"' in raw or '"function_call"' in raw
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return False
    for ch in body.get("choices", []) or []:
        msg = ch.get("message") or {}
        if msg.get("tool_calls") or msg.get("function_call"):
            return True
    return False


def _reconstruct_assistant_text(rec: dict, encoding) -> str | None:
    """Best-effort delivered assistant text for completion recompute."""
    resp = rec.get("response", {})
    raw = resp.get("raw", "")
    if resp.get("raw_encoding") != "utf8":
        return None
    if resp.get("stream"):
        # Reconstruct from SSE delta.content (mirror of Go ParseSSE).
        text_parts: list[str] = []
        for line in raw.replace("\r\n", "\n").split("\n"):
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].lstrip(" ")
            if payload == "[DONE]":
                continue
            try:
                ev_obj = json.loads(payload)
            except json.JSONDecodeError:
                continue
            for ch in ev_obj.get("choices", []) or []:
                delta = ch.get("delta") or {}
                if isinstance(delta.get("content"), str):
                    text_parts.append(delta["content"])
            if ev_obj.get("type") == "response.output_text.delta":
                if isinstance(ev_obj.get("delta"), str):
                    text_parts.append(ev_obj["delta"])
        return "".join(text_parts)
    # non-stream
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    parts: list[str] = []
    for ch in body.get("choices", []) or []:
        msg = ch.get("message") or {}
        if isinstance(msg.get("content"), str):
            parts.append(msg["content"])
    return "".join(parts) if parts else ""


def _count_prompt_tokens(req_raw: str, enc) -> int | None:
    """Replicate the Chat Completions framing math over the request messages."""
    try:
        body = json.loads(req_raw)
    except (json.JSONDecodeError, TypeError):
        return None
    messages = body.get("messages")
    if not isinstance(messages, list):
        return None
    total = 0
    for msg in messages:
        total += _TOKENS_PER_MESSAGE
        for key, value in msg.items():
            if not isinstance(value, str):
                # non-text content handled by estimate_only upstream; skip here
                continue
            total += len(enc.encode(value))
            if key == "name":
                total += _TOKENS_PER_NAME
    total += _REPLY_PRIMING
    return total


def check_token_recount(rec: dict, cfg: dict[str, Any] | None = None) -> Verdict:
    cfg = cfg or {}
    tolerance_pct = float(cfg.get("tolerance_pct", 4.0))
    min_abs = int(cfg.get("min_abs_tokens", 5))

    route = rec.get("route", {})
    resp = rec.get("response", {})
    provider, surface = route.get("provider"), route.get("api_surface")
    model = route.get("claimed_model")

    def skip(reason: str) -> Verdict:
        return new_verdict(rec, CHECK, "skip", "info", f"skipped: {reason}",
                           {"reason": reason, "provider": provider, "api_surface": surface})

    # Eligibility gates ---------------------------------------------------
    if provider != "openai" or surface not in {"chat.completions", "responses"}:
        return skip(f"non-openai/unsupported surface ({provider}/{surface}); no public tokenizer")
    if not resp.get("complete", False):
        return skip("response incomplete (partial capture)")
    if resp.get("truncated") or rec.get("request", {}).get("truncated"):
        return skip("captured body truncated")

    encoding = _encoding_for(model)
    if encoding is None:
        return skip(f"unknown/non-openai model {model!r}")

    try:
        enc = _load_encoding(encoding)
    except Exception as e:  # noqa: BLE001 — tiktoken missing or encoding load failed
        return new_verdict(rec, CHECK, "error", "info", f"tiktoken unavailable: {e}",
                           {"reason": "tiktoken_error", "encoding": encoding})

    claimed_completion = ev.claimed_completion(rec)
    claimed_prompt = ev.claimed_prompt(rec)
    if claimed_completion is None and claimed_prompt is None:
        return skip("no usage reported (e.g. stream without include_usage)")

    # estimate-only conditions (warn ceiling, never hard accusation) -------
    req_raw = rec.get("request", {}).get("raw", "")
    estimate_only = False
    est_reasons: list[str] = []
    if _is_reasoning(model, rec):
        estimate_only = True
        est_reasons.append("reasoning_tokens_unverifiable")
    if _request_has_tools_or_multimodal(req_raw) or _response_has_tool_calls(rec):
        estimate_only = True
        est_reasons.append("tools_or_multimodal")

    # Recompute -----------------------------------------------------------
    recomputed: dict[str, int | None] = {"prompt": None, "completion": None}
    text = _reconstruct_assistant_text(rec, enc)
    if text is not None:
        recomputed["completion"] = len(enc.encode(text))
    recomputed["prompt"] = _count_prompt_tokens(req_raw, enc)

    detail: dict[str, Any] = {
        "provider": provider, "api_surface": surface, "encoding": encoding,
        "eligible": True, "estimate_only": estimate_only,
        "estimate_reasons": est_reasons,
        "claimed": {"prompt": claimed_prompt, "completion": claimed_completion},
        "recomputed": recomputed,
        "framing": {"tokens_per_message": _TOKENS_PER_MESSAGE, "reply_priming": _REPLY_PRIMING},
        "tolerance_pct": tolerance_pct, "min_abs_tokens": min_abs,
        "note": "recompute is a close estimate, not a byte-exact oracle; "
                "prompt-side padding the relay adds UPSTREAM is invisible here",
    }

    # Completion comparison. Two distinct signals:
    #   CRITICAL — visible text EXCEEDS billed completion. The visible recount is
    #     a lower bound on honest completion tokens, so visible > billed is
    #     physically impossible for an honest relay (capture error or under-bill).
    #   WARN — billed GREATLY exceeds visible, AND this is not a reasoning/tool
    #     response (those legitimately bill hidden tokens and are estimate_only).
    #     That is the core token-inflation fraud Phase 0 targets. WARN not
    #     CRITICAL because an unknown-reasoning model or framing edge could
    #     explain a smaller gap — the buyer should corroborate, but a ~95% gap on
    #     a plain gpt-4o is exactly what this check exists to surface.
    flags_critical: list[str] = []
    flags_warn: list[str] = []
    rc, cc = recomputed["completion"], claimed_completion
    if rc is not None and cc is not None and cc >= 0:
        over = rc - cc  # >0 => visible exceeds billed
        detail["completion_delta"] = over
        detail["completion_delta_pct"] = round(100.0 * over / cc, 2) if cc else None
        if over > min_abs and (cc == 0 or 100.0 * over / cc > tolerance_pct):
            flags_critical.append(
                f"visible completion {rc} exceeds billed {cc} by {over} "
                f"(impossible if honest — capture error or under-billing)"
            )
        elif not estimate_only and (cc - rc) > min_abs and cc > 0:
            under_pct = 100.0 * (cc - rc) / cc
            if under_pct > tolerance_pct:
                detail["billed_exceeds_visible_pct"] = round(under_pct, 2)
                flags_warn.append(
                    f"billed completion {cc} exceeds visible text {rc} by {cc - rc} "
                    f"({under_pct:.1f}%) on a non-reasoning, non-tool response — possible inflation"
                )

    # Prompt over-claim (relay reports MORE prompt tokens than your request has).
    # Kept as an observation, not a flag: prompt-side framing constants are
    # noisier and tool schemas legitimately inflate prompt tokens.
    rp, cp = recomputed["prompt"], claimed_prompt
    if not estimate_only and rp is not None and cp is not None and cp > 0:
        over_p = cp - rp
        over_pct = 100.0 * over_p / cp
        detail["prompt_delta"] = -over_p
        detail["prompt_delta_pct"] = round(-over_pct, 2)
        if over_p > min_abs and over_pct > tolerance_pct:
            detail.setdefault("observations", []).append(
                f"billed prompt {cp} exceeds recomputed {rp} by {over_p} ({over_pct:.1f}%); "
                "could be framing drift or prompt inflation"
            )

    if flags_critical:
        return new_verdict(rec, CHECK, "flag", "critical", "; ".join(flags_critical), detail)
    if flags_warn:
        return new_verdict(rec, CHECK, "flag", "warn", "; ".join(flags_warn), detail)

    sev_summary = "usage within tolerance"
    if estimate_only:
        sev_summary = f"usage plausible (estimate-only: {', '.join(est_reasons)})"
    return new_verdict(rec, CHECK, "ok", "info", sev_summary, detail)
