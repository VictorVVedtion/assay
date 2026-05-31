"""Analysis-plane runner: read evidence → run checks → write verdicts.

Two entry points share one deterministic core (:func:`derive_verdicts`):

  * ``replay`` — re-derive ALL verdicts from an evidence file from scratch. This
    is the reproducibility guarantee: anyone can run it and get byte-identical
    verdicts (modulo the ``ts`` stamp) to a live run (PHASE0.md §9).
  * ``run`` — tail the live evidence file and append verdicts as records arrive
    (poll-based; inotify is unreliable on Docker Desktop FUSE — PHASE0.md §8).

Both verify the hash chain as they read (interior break → hard error; torn tail
→ skipped). cache_replay state is rebuilt deterministically so ``run`` and
``replay`` converge.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Iterator

from . import evidence as ev
from . import probe as probe_mod
from . import reference as ref_mod
from .checks import (
    CacheReplayState,
    check_cache_replay,
    check_exposure,
    check_model_identity,
    check_provenance,
    check_throughput,
    check_token_recount,
)


def derive_verdicts(
    records: Iterator[dict],
    cfg: dict[str, Any],
    cache_state: CacheReplayState,
    *,
    stamp_ts: bool = False,
) -> Iterator[dict]:
    """Run all per-record checks over records in order, yielding verdicts.
    Deterministic except for the optional ts stamp (kept out of the reproducible
    identity). PROBE records are skipped here — they are synthetic, not the
    buyer's real traffic, and are consumed as a batch by model_identity."""
    tr_cfg = cfg.get("token_recount", {})
    cr_cfg = cfg.get("cache_replay", {})
    tp_cfg = cfg.get("throughput", {})
    pv_cfg = cfg.get("provenance", {})
    ex_cfg = cfg.get("exposure", {})

    for rec in records:
        if probe_mod.is_probe(rec):
            continue  # synthetic probe — handled by derive_batch_verdicts
        verdicts = [
            check_token_recount(rec, tr_cfg),
            check_provenance(rec, pv_cfg),
            check_exposure(rec, ex_cfg),
            check_cache_replay(rec, cache_state, cr_cfg),
            check_throughput(rec, tp_cfg),
        ]
        for v in verdicts:
            if stamp_ts:
                v["ts"] = _now_iso()
            yield v


def _resolve_reference(batch: dict[str, Any], references: dict[str, dict]) -> dict | None:
    """Find the reference(s) matching a probe batch's model. Returns the MMD
    reference mapping {precision_label: {prompt_id: [text,...]}} or None.

    references: {ref_name: loaded_reference_blob}. A batch matches a reference by
    model name; multiple precisions of the same model compose the composite null.
    """
    model = batch.get("model")
    matched = {}
    for name, blob in references.items():
        if blob.get("model") == model:
            label = blob.get("precision", name)
            matched[label] = ref_mod.reference_samples(blob)
    return matched or None


def derive_batch_verdicts(
    records: list[dict],
    cfg: dict[str, Any],
    references: dict[str, dict],
    *,
    stamp_ts: bool = False,
) -> Iterator[dict]:
    """Group probe records into batches and emit one model_identity verdict per
    batch. Deterministic given the same records + references."""
    mi_cfg = cfg.get("model_identity", {})
    batches = probe_mod.group_probe_batches(records)
    for set_id in sorted(batches):
        batch = batches[set_id]
        batch["reference"] = _resolve_reference(batch, references)
        v = check_model_identity(batch, mi_cfg)
        if stamp_ts:
            v["ts"] = _now_iso()
        yield v


def replay(evidence_path: str, cfg: dict[str, Any],
           references: dict[str, dict] | None = None) -> list[dict]:
    """Re-derive all verdicts from scratch (in-memory cache index). Includes
    batch model_identity verdicts when references are provided."""
    cache_state = CacheReplayState(":memory:")
    try:
        records = list(ev.iter_evidence(evidence_path, verify=True))
        out = list(derive_verdicts(iter(records), cfg, cache_state, stamp_ts=False))
        if any(probe_mod.is_probe(r) for r in records):
            out.extend(derive_batch_verdicts(records, cfg, references or {}, stamp_ts=False))
        return out
    finally:
        cache_state.close()


def run(cfg: dict[str, Any], poll_interval: float = 0.5) -> None:
    """Tail evidence and append verdicts live. Resumable via a seq checkpoint."""
    an = cfg.get("analyzer", cfg)
    evidence_path = cfg["evidence"]["path"] if "evidence" in cfg else an["evidence_path"]
    verdicts_path = an["verdicts_path"]
    checkpoint_path = an.get("checkpoint_path", verdicts_path + ".checkpoint")
    index_db = an.get("index_db", ":memory:")

    last_seq = _load_checkpoint(checkpoint_path)
    cache_state = CacheReplayState(index_db)

    # Rebuild cache index deterministically up to the checkpoint so live ==
    # replay (PHASE0.md §8). For :memory: this means replaying history each
    # start; for a file DB it persists.
    print(f"assay-analyzer: tailing {evidence_path} (resume after seq {last_seq})", flush=True)

    heartbeat_path = an.get("heartbeat_path", verdicts_path + ".status")
    try:
        while True:
            head_seq = _process_new(
                evidence_path, verdicts_path, cfg, cache_state, last_seq_box := [last_seq]
            )
            last_seq = last_seq_box[0]
            _write_heartbeat(heartbeat_path, last_seq, head_seq)
            _save_checkpoint(checkpoint_path, last_seq)
            time.sleep(poll_interval)
    except KeyboardInterrupt:
        print("\nassay-analyzer: stopped", flush=True)
    finally:
        cache_state.close()


def _process_new(
    evidence_path: str,
    verdicts_path: str,
    cfg: dict[str, Any],
    cache_state: CacheReplayState,
    last_seq_box: list[int],
) -> int:
    """Process records with seq > last_seq; append their verdicts. Returns the
    evidence head seq seen (for lag reporting)."""
    if not os.path.exists(evidence_path):
        return last_seq_box[0]

    last_seq = last_seq_box[0]
    head_seq = last_seq
    new_records: list[dict] = []
    for rec in ev.iter_evidence(evidence_path, verify=True):
        head_seq = rec["seq"]
        if rec["seq"] > last_seq:
            new_records.append(rec)

    if new_records:
        with open(verdicts_path, "a", encoding="utf-8") as out:
            for v in derive_verdicts(iter(new_records), cfg, cache_state, stamp_ts=True):
                out.write(json.dumps(v, ensure_ascii=False) + "\n")
        last_seq_box[0] = new_records[-1]["seq"]
    return head_seq


def _load_checkpoint(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("last_seq", -1)
    except (FileNotFoundError, json.JSONDecodeError):
        return -1


def _save_checkpoint(path: str, last_seq: int) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"last_seq": last_seq}, f)
    os.replace(tmp, path)


def _write_heartbeat(path: str, last_seq: int, head_seq: int) -> None:
    tmp = path + ".tmp"
    payload = {
        "last_processed_seq": last_seq,
        "evidence_head_seq": head_seq,
        "lag_records": max(0, head_seq - last_seq),
        "updated_at": _now_iso(),
    }
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, path)


def _now_iso() -> str:
    # Wall-clock stamp for humans; deliberately excluded from verdict identity.
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
