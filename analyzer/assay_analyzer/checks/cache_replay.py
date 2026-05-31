"""cache_replay — detect a relay serving one cached response for DIFFERENT
requests (PHASE0.md §6.2).

A weak tripwire, scoped honestly after the red-team:

  * Fingerprint the RECONSTRUCTED assistant text, not raw SSE bytes — a chunk
    boundary change otherwise breaks an exact hash for free.
  * Normalize (NFKC, strip zero-width/control chars, collapse whitespace) so the
    measured free nonces (trailing ZWSP/newline cost 0 tokens) don't defeat it.
  * Distinctness keyed on normalized REQUEST content (system+messages), NOT
    record identity — identical prompts legitimately yielding identical output
    (temperature 0, prompt caching) is NOT fraud.
  * temperature==0 or a fixed seed → downgrade to info (determinism expected).
  * Paraphrase/regeneration evasion is explicitly OUT of Phase 0 scope.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from typing import Any

from .token_recount import _reconstruct_assistant_text
from .base import Verdict, new_verdict

CHECK = "cache_replay"

_ZERO_WIDTH = dict.fromkeys(map(ord, ["​", "‌", "‍", "﻿"]), None)
_WS = re.compile(r"\s+")


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(_ZERO_WIDTH)
    # strip other control chars
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    return _WS.sub(" ", text).strip()


def _request_semantic_fingerprint(req_raw: str) -> str | None:
    """Hash only the semantic request content (model + messages), ignoring
    streaming flags / request ids so two genuinely-equal requests collapse."""
    try:
        body = json.loads(req_raw)
    except (json.JSONDecodeError, TypeError):
        return None
    sem = {"model": body.get("model"), "messages": body.get("messages"),
           "input": body.get("input")}
    blob = json.dumps(sem, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _request_temperature(req_raw: str) -> tuple[float | None, bool]:
    try:
        body = json.loads(req_raw)
    except (json.JSONDecodeError, TypeError):
        return None, False
    return body.get("temperature"), ("seed" in body)


class CacheReplayState:
    """SQLite-backed index of response fingerprint → distinct request set.
    Pure derived state: safe to delete and rebuild; ``replay`` rebuilds it from
    scratch so live and replay converge (PHASE0.md §8)."""

    def __init__(self, db_path: str = ":memory:") -> None:
        self.db = sqlite3.connect(db_path)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS cache_idx ("
            "  resp_fp TEXT NOT NULL,"
            "  req_fp TEXT NOT NULL,"
            "  first_seen_id TEXT NOT NULL,"
            "  normalized_len INTEGER NOT NULL,"
            "  PRIMARY KEY (resp_fp, req_fp))"
        )
        self.db.commit()

    def observe(self, resp_fp: str, req_fp: str, rec_id: str, norm_len: int) -> tuple[int, str]:
        """Record a (response, request) pairing; return (distinct_request_count,
        first_seen_record_id) for this response fingerprint."""
        row = self.db.execute(
            "SELECT first_seen_id FROM cache_idx WHERE resp_fp=? ORDER BY rowid LIMIT 1",
            (resp_fp,),
        ).fetchone()
        first_seen = row[0] if row else rec_id
        self.db.execute(
            "INSERT OR IGNORE INTO cache_idx VALUES (?,?,?,?)",
            (resp_fp, req_fp, first_seen, norm_len),
        )
        self.db.commit()
        count = self.db.execute(
            "SELECT COUNT(*) FROM cache_idx WHERE resp_fp=?", (resp_fp,)
        ).fetchone()[0]
        return count, first_seen

    def close(self) -> None:
        self.db.close()


def check_cache_replay(rec: dict, state: CacheReplayState, cfg: dict[str, Any] | None = None) -> Verdict:
    cfg = cfg or {}
    min_len = int(cfg.get("min_normalized_len", 64))

    resp = rec.get("response", {})
    if not resp.get("complete", False) or resp.get("truncated"):
        return new_verdict(rec, CHECK, "skip", "info", "skipped: incomplete/truncated capture",
                           {"reason": "incomplete_or_truncated"})

    text = _reconstruct_assistant_text(rec, None)
    if not text:
        return new_verdict(rec, CHECK, "skip", "info", "skipped: no assistant text",
                           {"reason": "no_text"})

    normalized = _normalize(text)
    if len(normalized) < min_len:
        return new_verdict(rec, CHECK, "skip", "info",
                           f"skipped: response too short ({len(normalized)} < {min_len})",
                           {"reason": "below_min_len", "normalized_len": len(normalized)})

    req_raw = rec.get("request", {}).get("raw", "")
    req_fp = _request_semantic_fingerprint(req_raw)
    if req_fp is None:
        return new_verdict(rec, CHECK, "skip", "info", "skipped: unparseable request",
                           {"reason": "bad_request"})

    resp_fp = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    count, first_seen = state.observe(resp_fp, req_fp, rec["id"], len(normalized))

    temp, has_seed = _request_temperature(req_raw)
    detail = {
        "resp_fingerprint": resp_fp, "normalized_len": len(normalized),
        "distinct_request_count": count, "first_seen_record_id": first_seen,
        "temperature": temp, "has_seed": has_seed,
        "note": "exact-replay tripwire only; paraphrase/regeneration evades (out of Phase 0 scope)",
    }

    if count >= 2:
        # Identical long output for >=2 DIFFERENT requests.
        if temp == 0 or has_seed:
            return new_verdict(rec, CHECK, "skip", "info",
                               "identical output across requests, but temperature=0/seed set (determinism expected)",
                               detail)
        return new_verdict(rec, CHECK, "flag", "warn",
                           f"same {len(normalized)}-char response served for {count} distinct requests "
                           f"(temp={temp}) — possible cache replay",
                           detail)
    return new_verdict(rec, CHECK, "ok", "info", "no replay collision", detail)
