/**
 * lib/server/verify.ts — TypeScript chain verification, faithful to
 * internal/evidence/verify.go (VerifyFile). SERVER-leaning but pure: it works
 * on an in-memory record list + a torn-tail flag, so it serves both the file
 * route and the demo source. Recompute is done with lib/digest.ts — we do NOT
 * shell out to the Go binary (the whole point is independent recompute).
 *
 * Classification (PHASE0.md §4):
 *   VALID     — every record's seq increments from 0, prev_hash links, hash
 *               recomputes; clean newline-terminated EOF.
 *   EMPTY     — zero records and no torn tail.
 *   TORN_TAIL — the trailing line had no newline (recoverable crash artifact,
 *               NOT tamper). Earlier records still verified.
 *   BREAK     — an interior inconsistency (seq gap, prev_hash mismatch, hash
 *               mismatch, or an unparseable interior line) = tamper signal.
 *
 * A non-decreasing ts_start is a non-fatal warning (a full rewriter can forge
 * it; only external anchoring defends — PHASE0.md §4.1).
 */

import { computeHash, GENESIS_PREV_HASH } from "../digest.ts";
import type { EvidenceRecord, VerifyResult } from "../types.ts";

export interface VerifyInput {
  records: EvidenceRecord[];
  /** the source's last line was torn (no trailing newline). */
  tornTail: boolean;
}

export async function verifyChain(input: VerifyInput): Promise<VerifyResult> {
  const { records, tornTail } = input;
  const res: VerifyResult = {
    status: "VALID",
    records: 0,
    break_seq: null,
    detail: "",
    warnings: [],
    head_hash: GENESIS_PREV_HASH,
  };

  let expected = 0;
  let prevHash = GENESIS_PREV_HASH;
  let lastTs: number | null = null;

  for (const rec of records) {
    if (rec.seq !== expected) {
      res.status = "BREAK";
      res.break_seq = rec.seq;
      res.detail = `seq gap: expected ${expected}, got ${rec.seq} (record deletion or reorder)`;
      return res;
    }
    if (rec.prev_hash !== prevHash) {
      res.status = "BREAK";
      res.break_seq = rec.seq;
      res.detail = `prev_hash mismatch at seq ${rec.seq}`;
      return res;
    }
    const got = await computeHash(rec);
    if (got !== rec.hash) {
      res.status = "BREAK";
      res.break_seq = rec.seq;
      res.detail = `hash mismatch at seq ${rec.seq} (record altered): stored=${rec.hash} computed=${got}`;
      return res;
    }

    const ts = Date.parse(rec.ts_start);
    if (!Number.isNaN(ts)) {
      if (lastTs !== null && ts < lastTs) {
        res.warnings.push(`timestamp regression at seq ${rec.seq}`);
      }
      lastTs = ts;
    }

    prevHash = rec.hash;
    res.head_hash = rec.hash;
    res.records++;
    expected = rec.seq + 1;
  }

  if (tornTail) {
    res.status = "TORN_TAIL";
    res.detail = `trailing line without newline after seq ${expected - 1} (recoverable crash artifact, not tamper)`;
    return res;
  }

  if (res.records === 0) {
    res.status = "EMPTY";
    res.detail = "no evidence records yet";
  }
  return res;
}
