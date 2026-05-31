"""Shared verdict construction for checks (PHASE0.md §5)."""

from __future__ import annotations

from typing import Any, Literal

from .. import __version__

Status = Literal["ok", "flag", "skip", "error"]
Severity = Literal["info", "warn", "critical"]

Verdict = dict[str, Any]


def new_verdict(
    rec: dict,
    check: str,
    status: Status,
    severity: Severity,
    summary: str,
    detail: dict[str, Any],
    *,
    ts: str = "",
) -> Verdict:
    """Build a VerdictRecord bound to the exact evidence record (record_hash),
    so it is reproducible and tamper-evident by reference."""
    return {
        "v": 1,
        "record_id": rec["id"],
        "record_seq": rec["seq"],
        "record_hash": rec["hash"],
        "check": check,
        "analyzer_version": __version__,
        "ts": ts,  # filled by the runner; kept out of reproducible identity
        "status": status,
        "severity": severity,
        "summary": summary,
        "detail": detail,
    }
