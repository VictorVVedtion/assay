/**
 * lib/server/source.ts — resolve the active data source and assemble a Snapshot.
 * SERVER ONLY. The single place that decides Live vs Demo:
 *
 *   - If both data files exist and evidence.jsonl is non-empty → Live (read them).
 *   - Otherwise → Demo (deterministic bundled story).
 *   - An explicit ?source=demo|live query overrides the auto-pick (so the
 *     TopBar toggle can force either; forcing Live with empty files yields an
 *     honest EMPTY chain + zero rows rather than silently showing Demo).
 *
 * Demo and Live produce the SAME Snapshot shape.
 */

import { readEvidence, readVerdicts, fileHasContent } from "./jsonl.ts";
import { evidencePath, verdictsPath, heartbeatPath } from "./paths.ts";
import { verifyChain } from "./verify.ts";
import { computeAggregates } from "../aggregate.ts";
import { buildDemoSource, DEMO_BREAK_SEQ } from "./demo.ts";
import { readFile } from "node:fs/promises";
import type {
  AnalyzerLag,
  DataSource,
  EvidenceRecord,
  Snapshot,
  VerdictRecord,
} from "../types.ts";

export interface SourceOptions {
  /** force a source; undefined = auto-pick. */
  force?: DataSource;
  /** demo BREAK injection: true → default seq; number → that seq; false/undef → none. */
  demoBreak?: boolean | number;
}

/** Decide which source to use given the files on disk + an optional override. */
export async function resolveSource(force?: DataSource): Promise<DataSource> {
  if (force) return force;
  const hasEvidence = await fileHasContent(evidencePath());
  return hasEvidence ? "live" : "demo";
}

/** Read the analyzer heartbeat file if present, else derive lag from seqs. */
async function readLag(
  records: EvidenceRecord[],
  verdicts: VerdictRecord[],
): Promise<AnalyzerLag> {
  // Prefer the runner.py heartbeat (verdicts.jsonl.status).
  try {
    const raw = await readFile(heartbeatPath(), "utf8");
    const hb = JSON.parse(raw) as Partial<AnalyzerLag>;
    if (typeof hb.last_processed_seq === "number") {
      return {
        last_processed_seq: hb.last_processed_seq,
        evidence_head_seq:
          hb.evidence_head_seq ?? headSeq(records),
        lag_records:
          hb.lag_records ??
          Math.max(0, headSeq(records) - hb.last_processed_seq),
        updated_at: hb.updated_at ?? null,
      };
    }
  } catch {
    /* no heartbeat — derive below */
  }
  // Derive: highest evidence seq vs highest seq that has any verdict.
  const head = headSeq(records);
  let processed = -1;
  for (const v of verdicts) if (v.record_seq > processed) processed = v.record_seq;
  return {
    last_processed_seq: processed,
    evidence_head_seq: head,
    lag_records: Math.max(0, head - processed),
    updated_at: null,
  };
}

function headSeq(records: EvidenceRecord[]): number {
  let h = -1;
  for (const r of records) if (r.seq > h) h = r.seq;
  return h;
}

function normalizeBreak(demoBreak: boolean | number | undefined): number | null {
  if (demoBreak === undefined || demoBreak === false) return null;
  if (demoBreak === true) return DEMO_BREAK_SEQ;
  return demoBreak;
}

/** Assemble the full Snapshot for the chosen source. */
export async function buildSnapshot(opts: SourceOptions = {}): Promise<Snapshot> {
  const source = await resolveSource(opts.force);

  if (source === "demo") {
    const breakAt = normalizeBreak(opts.demoBreak);
    const { records, verdicts, tornTail } = await buildDemoSource(breakAt);
    const chainStatus = await verifyChain({ records, tornTail });
    const aggregates = computeAggregates(records, verdicts);
    const lag = await deriveDemoLag(records, verdicts);
    return { records, verdicts, aggregates, chainStatus, lag, source, breakAt };
  }

  // Live
  const [ev, vd] = await Promise.all([
    readEvidence(evidencePath()),
    readVerdicts(verdictsPath()),
  ]);
  const records = ev.rows;
  const verdicts = vd.rows;
  const chainStatus = await verifyChain({
    records,
    tornTail: ev.tornTail,
  });
  const aggregates = computeAggregates(records, verdicts);
  const lag = await readLag(records, verdicts);
  return { records, verdicts, aggregates, chainStatus, lag, source };
}

/** Demo lag is "caught up" (all records have verdicts) unless a BREAK exists. */
async function deriveDemoLag(
  records: EvidenceRecord[],
  verdicts: VerdictRecord[],
): Promise<AnalyzerLag> {
  const head = headSeq(records);
  let processed = -1;
  for (const v of verdicts) if (v.record_seq > processed) processed = v.record_seq;
  return {
    last_processed_seq: processed,
    evidence_head_seq: head,
    lag_records: Math.max(0, head - processed),
    updated_at: records.length ? records[records.length - 1].ts_start : null,
  };
}

/** Just the chain-verify result for /api/verify (avoids recomputing aggregates). */
export async function verifyOnly(opts: SourceOptions = {}) {
  const source = await resolveSource(opts.force);
  if (source === "demo") {
    const breakAt = normalizeBreak(opts.demoBreak);
    const { records, tornTail } = await buildDemoSource(breakAt);
    const result = await verifyChain({ records, tornTail });
    return { result, source, breakAt };
  }
  const ev = await readEvidence(evidencePath());
  const result = await verifyChain({ records: ev.rows, tornTail: ev.tornTail });
  return { result, source, breakAt: null as number | null };
}
