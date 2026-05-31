"""throughput — telemetry only (PHASE0.md §6.3).

The red-team is decisive here: tokens/s measured THROUGH the proxy reflects the
RELAY's pacing (it can buffer and re-emit at any cadence), not the model's decode
speed. So this check NEVER produces a critical verdict on its own. It records
tokens/s and TTFT for human/Phase-1 use, and flags only the physically absurd
(faster than any real hardware), which is also the most evadable case — hence
warn, not critical.

Skips non-stream responses (TTFT ≈ total → gen time ≈ 0 → garbage tokens/s) and
anything without enough timing resolution.
"""

from __future__ import annotations

from typing import Any

from .. import evidence as ev
from .base import Verdict, new_verdict

CHECK = "throughput"

_MIN_GEN_US = 50_000  # 50ms floor below which tokens/s is meaningless


def check_throughput(rec: dict, cfg: dict[str, Any] | None = None) -> Verdict:
    cfg = cfg or {}
    ceiling = float((cfg.get("model_class_ceiling_tps") or {}).get("default", 2000))

    resp = rec.get("response", {})
    timing = rec.get("timing", {})

    if not resp.get("stream") or not resp.get("complete"):
        return new_verdict(rec, CHECK, "skip", "info", "skipped: non-stream or incomplete",
                           {"reason": "non_stream_or_incomplete"})

    ttft = timing.get("ttft_us")
    total = timing.get("total_us")
    if ttft is None or total is None or total - ttft < _MIN_GEN_US:
        return new_verdict(rec, CHECK, "skip", "info", "skipped: insufficient timing resolution",
                           {"reason": "low_resolution", "ttft_us": ttft, "total_us": total})

    completion = ev.claimed_completion(rec)
    if not completion or completion <= 0:
        return new_verdict(rec, CHECK, "skip", "info", "skipped: no completion token count",
                           {"reason": "no_completion_count"})

    gen_us = total - ttft
    tps = completion * 1_000_000.0 / gen_us
    detail = {
        "completion_tokens_used": completion,
        "gen_us": gen_us, "ttft_us": ttft,
        "tokens_per_s": round(tps, 1),
        "ceiling_tps": ceiling,
        "stream_chunks": timing.get("stream_chunks"),
        "note": "measures relay pacing, not model speed; informational only",
    }
    if tps > ceiling:
        return new_verdict(rec, CHECK, "flag", "warn",
                           f"{tps:.0f} tok/s exceeds physical ceiling {ceiling:.0f} "
                           f"(buffered/replayed delivery hint — not proof)",
                           detail)
    return new_verdict(rec, CHECK, "ok", "info", f"{tps:.0f} tok/s", detail)
