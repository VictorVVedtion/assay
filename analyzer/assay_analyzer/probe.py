"""Probe-tag parsing for the analysis plane (PHASE0.md Phase 1).

Synthetic probe requests (injected by the Go probe plane for model_identity) are
marked by a structured prefix in the evidence record's ``capture.note`` field —
chosen because note is already covered by the hash digest and needs no schema or
digest change. Format:

    assay-probe:<set_id>:<prompt_id>

  set_id    — groups all completions of one calibration/audit batch
  prompt_id — which fixed prompt this completion answers (int)

Per-record checks (token_recount, exposure, ...) SKIP probe records: they are
synthetic, not the buyer's real traffic, and would pollute exposure/cache stats.
model_identity consumes them as a batch instead.
"""

from __future__ import annotations

from typing import Any

PROBE_PREFIX = "assay-probe:"


def parse_probe_tag(rec: dict) -> tuple[str, int] | None:
    """Return (set_id, prompt_id) if rec is a probe record, else None.

    Tolerant: the note may carry other text after a ';' (e.g. a scrub note), so
    we scan semicolon-separated fragments for the probe tag."""
    note = (rec.get("capture") or {}).get("note")
    if not note:
        return None
    for frag in note.split(";"):
        frag = frag.strip()
        if frag.startswith(PROBE_PREFIX):
            rest = frag[len(PROBE_PREFIX):]
            # prompt_id is the LAST colon-separated field; split from the right so
            # a set_id containing ':' still parses (the Go side also sanitizes
            # set_id, but parse defensively here too).
            head, _, last = rest.rpartition(":")
            if not head:
                return None
            try:
                prompt_id = int(last)
            except ValueError:
                return None
            return head, prompt_id
    return None


def is_probe(rec: dict) -> bool:
    return parse_probe_tag(rec) is not None


def make_probe_note(set_id: str, prompt_id: int) -> str:
    """The note string the Go injector writes (kept here so both sides agree)."""
    return f"{PROBE_PREFIX}{set_id}:{prompt_id}"


def _assistant_text(rec: dict) -> str:
    """Extract delivered assistant text from a probe response (non-stream or
    stream), reusing token_recount's reconstruction for consistency."""
    from .checks.token_recount import _reconstruct_assistant_text

    txt = _reconstruct_assistant_text(rec, None)
    return txt or ""


def group_probe_batches(records: list[dict]) -> dict[str, dict[str, Any]]:
    """Group probe records by set_id into {set_id: batch} where batch =
    {samples:{prompt_id:[text,...]}, member_record_hashes:[...], anchor_record,
     model}. The anchor is the lowest-seq member (stable, for record_hash bind)."""
    batches: dict[str, dict[str, Any]] = {}
    for rec in records:
        tag = parse_probe_tag(rec)
        if tag is None:
            continue
        set_id, prompt_id = tag
        b = batches.setdefault(set_id, {
            "set_id": set_id, "samples": {}, "member_record_hashes": [],
            "anchor_record": rec, "model": (rec.get("route") or {}).get("claimed_model"),
            "_anchor_seq": rec.get("seq"),
        })
        # only count complete, non-truncated, successful probe responses — a
        # truncated body would feed a shortened completion into MMD.
        resp = rec.get("response") or {}
        if not resp.get("complete", False) or resp.get("truncated", False):
            continue
        text = _assistant_text(rec)
        if not text:
            continue
        b["samples"].setdefault(prompt_id, []).append(text)
        b["member_record_hashes"].append(rec.get("hash", ""))
        if rec.get("seq", 1 << 62) < b["_anchor_seq"]:
            b["anchor_record"] = rec
            b["_anchor_seq"] = rec.get("seq")
    return batches
