"""assay report - turn verdicts into a buyer-readable scorecard.

The red-team's most important non-code finding: a buyer who points base_url at
assay and sees green checks will assume the model is genuine. Phase 0 does NOT
verify model identity. So the scorecard LEADS with that scope statement, every
time (PHASE0.md S9).

Output is encoding-safe: it uses plain ASCII status markers ([OK]/[FLAG]/...) so
it renders identically in any terminal, pipe, or CI log. Emoji are avoided on
purpose - they corrupt non-UTF-8 sinks and add nothing a buyer needs.
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

SCOPE_BANNER = (
    "SCOPE & HONEST LIMITS (read this -- a clean report is NOT a clean bill of health):\n"
    "  - MODEL IDENTITY is NOT verified: a downgraded/quantized/tao-ke (套壳) model is\n"
    "    not detected here (Phase 1: LLMmap / MMD). provenance only checks upstream\n"
    "    headers, which are FORGEABLE -- 'consistent with', never 'proven genuine'.\n"
    "  - DATA EXPOSURE is MEASURED, not PREVENTED: assay CANNOT stop the relay reading\n"
    "    what you send (it must decrypt to forward -- the MITM reality). The exposure\n"
    "    count is a LOWER BOUND ('at least N'); zero detected != safe.\n"
    "  - token_recount compares against YOUR request (prompt padding the relay adds\n"
    "    UPSTREAM is invisible) and SKIPS Claude/Gemini (no public tokenizer)."
)

_BAR = "=" * 68
_SEP = "-" * 68


def load_verdicts(path: str) -> list[dict]:
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def build_report(
    verdicts: list[dict],
    *,
    chain_status: str | None = None,
    lag: dict[str, Any] | None = None,
) -> str:
    lines: list[str] = []
    lines.append(_BAR)
    lines.append("assay (zhao-yao-jing 照妖镜) -- Phase 0 scorecard")
    lines.append(_BAR)
    lines.append(SCOPE_BANNER)
    lines.append(_SEP)

    if chain_status:
        marker = {"VALID": "[OK]", "EMPTY": "[--]", "TORN_TAIL": "[WARN]", "BREAK": "[TAMPER]"}.get(
            chain_status, "[?]"
        )
        lines.append(f"Evidence chain: {marker} {chain_status}")
        if chain_status == "BREAK":
            lines.append("  !! EVIDENCE TAMPERED -- verdicts below cannot be trusted.")
    if lag:
        lr = lag.get("lag_records", 0)
        state = "current" if lr == 0 else f"{lr} records behind"
        lines.append(f"Analyzer: {state} (last seq {lag.get('last_processed_seq')})")
    if chain_status or lag:
        lines.append(_SEP)

    by_check: dict[str, Counter] = {}
    flags: list[dict] = []
    for v in verdicts:
        by_check.setdefault(v["check"], Counter())[v["status"]] += 1
        if v["status"] == "flag":
            flags.append(v)

    order = ["token_recount", "provenance", "exposure", "cache_replay", "throughput"]
    labels = {
        "token_recount": "Token usage (tiktoken recount)",
        "provenance": "Upstream provenance (headers)",
        "exposure": "Data exposure (egress lower bound)",
        "cache_replay": "Cache-replay tripwire",
        "throughput": "Throughput (telemetry only)",
    }
    for check in order:
        c = by_check.get(check)
        if not c:
            continue
        total = sum(c.values())
        flag_n = c.get("flag", 0)
        marker = "[FLAG]" if flag_n else "[ OK ]"
        summary = (
            f"ok={c.get('ok', 0)} flag={flag_n} "
            f"skip={c.get('skip', 0)} err={c.get('error', 0)}"
        )
        lines.append(f"{marker} {labels[check]:<32} {summary}  ({total} rec)")

    lines.append(_SEP)
    if flags:
        lines.append(f"{len(flags)} flag(s):")
        for v in flags[:50]:
            sev = v["severity"].upper()
            lines.append(f"  [{sev}] {v['check']} seq {v['record_seq']}: {v['summary']}")
        if len(flags) > 50:
            lines.append(f"  ... and {len(flags) - 50} more")
    else:
        lines.append("No flags raised (within Phase 0's limited scope above).")
    lines.append(_BAR)
    return "\n".join(lines)
