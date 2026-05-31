"""Evidence/verdict record helpers for the analysis plane.

Mirrors the Go structs in ``internal/evidence``; we parse the JSONL the data
plane writes. Chain verification here is independent of Go (it recomputes hashes
via :mod:`assay_analyzer.digest`), which is the whole point: anyone can reproduce
the verdict from raw bytes (PHASE0.md §4, §9).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterator

from .digest import record_hash

GENESIS_PREV_HASH = "0" * 64
SCHEMA_VERSION = 1


@dataclass
class ChainState:
    """Running state while streaming evidence records, so a tailer can verify
    the chain incrementally and skip torn trailing lines."""

    expected_seq: int = 0
    prev_hash: str = GENESIS_PREV_HASH


class ChainError(Exception):
    """Raised on an interior chain inconsistency (tamper signal)."""


def iter_evidence(path: str, *, verify: bool = True) -> Iterator[dict]:
    """Yield evidence records from a JSONL file in order.

    A torn trailing line (no newline / unparseable last chunk) is skipped
    silently — that's a crash artifact, not tamper. An interior parse failure or
    chain break raises :class:`ChainError` (PHASE0.md §4).
    """
    state = ChainState()
    with open(path, "rb") as f:
        raw = f.read()

    # Split keeping only complete newline-terminated lines.
    pending_partial = not raw.endswith(b"\n") if raw else False
    lines = raw.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()  # trailing newline produced an empty final element
    elif pending_partial and lines:
        lines.pop()  # drop the torn final line

    for i, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as e:
            raise ChainError(f"unparseable evidence at line {i} (seq~{state.expected_seq}): {e}") from e

        if verify:
            _verify_link(rec, state)
        state.expected_seq = rec["seq"] + 1
        state.prev_hash = rec["hash"]
        yield rec


def _verify_link(rec: dict, state: ChainState) -> None:
    if rec.get("seq") != state.expected_seq:
        raise ChainError(f"seq gap: expected {state.expected_seq}, got {rec.get('seq')} (deletion/reorder)")
    if rec.get("prev_hash") != state.prev_hash:
        raise ChainError(f"prev_hash mismatch at seq {rec.get('seq')}")
    computed = record_hash(rec)
    if computed != rec.get("hash"):
        raise ChainError(f"hash mismatch at seq {rec.get('seq')} (record altered)")


# --- usage helpers (the relay-reported, UNTRUSTED numbers) ---


def claimed(rec: dict) -> dict[str, Any] | None:
    return rec.get("response", {}).get("claimed_usage")


def claimed_completion(rec: dict) -> int | None:
    u = claimed(rec)
    return u.get("completion_tokens") if u else None


def claimed_prompt(rec: dict) -> int | None:
    u = claimed(rec)
    return u.get("prompt_tokens") if u else None


def reasoning_tokens(rec: dict) -> int | None:
    u = claimed(rec) or {}
    det = u.get("completion_tokens_details") or {}
    return det.get("reasoning_tokens")
