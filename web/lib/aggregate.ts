/**
 * lib/aggregate.ts — pure, deterministic derivation of dashboard aggregates
 * from records + verdicts. Shared by the server (snapshot) and the client store
 * (incremental re-derive on ingest). No I/O, no randomness.
 *
 * Mirrors the MEANING of report.py's scorecard tally: per-check ok/flag/skip/
 * error counts, the flags list bucketed by severity, provider mix, % skipped.
 * Adds the overview-only metrics (req/min series, exposure lower bound).
 *
 * HONEST-BOUNDARY NOTE for the StatRow agent: `exposure_secret_lower_bound` is
 * a LOWER BOUND ("at least N"). Never present it as a risk score; 0 ≠ safe.
 */

import type {
  Aggregates,
  CheckName,
  CheckTally,
  EvidenceRecord,
  Provider,
  ProviderMix,
  RatePoint,
  Severity,
  SeverityCounts,
  VerdictRecord,
} from "./types.ts";
import type { ExposureDetail } from "./types.ts";

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

function worse(a: Severity | "none", b: Severity): Severity {
  if (a === "none") return b;
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

function emptyTally(): CheckTally {
  return { ok: 0, flag: 0, skip: 0, error: 0, total: 0, worst: "none" };
}

/** epoch-ms → start of its minute bucket (epoch ms). */
function minuteBucket(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * Build the req/min series over a trailing window. We bucket evidence records
 * by ts_start minute. The series is dense (zero-filled) from the first bucket
 * present to the latest, capped to `windowMinutes` most-recent buckets so the
 * sparkline stays readable.
 */
function rateSeries(records: EvidenceRecord[], windowMinutes = 30): RatePoint[] {
  if (records.length === 0) return [];
  const counts = new Map<number, number>();
  let maxBucket = -Infinity;
  for (const r of records) {
    const t = Date.parse(r.ts_start);
    if (Number.isNaN(t)) continue;
    const b = minuteBucket(t);
    counts.set(b, (counts.get(b) ?? 0) + 1);
    if (b > maxBucket) maxBucket = b;
  }
  if (!Number.isFinite(maxBucket)) return [];
  const out: RatePoint[] = [];
  const start = maxBucket - (windowMinutes - 1) * 60_000;
  for (let b = start; b <= maxBucket; b += 60_000) {
    out.push({ t: b, count: counts.get(b) ?? 0 });
  }
  return out;
}

function exposureLowerBound(verdicts: VerdictRecord[]): number {
  let total = 0;
  for (const v of verdicts) {
    if (v.check !== "exposure") continue;
    const d = v.detail as ExposureDetail;
    const reqSecrets = d.request?.secrets ?? {};
    const respSecrets = d.response?.secrets ?? {};
    for (const n of Object.values(reqSecrets)) total += n;
    for (const n of Object.values(respSecrets)) total += n;
  }
  return total;
}

/** Compute the full aggregate snapshot. Deterministic in record/verdict order. */
export function computeAggregates(
  records: EvidenceRecord[],
  verdicts: VerdictRecord[],
): Aggregates {
  const provider_mix: ProviderMix = {
    openai: 0,
    anthropic: 0,
    gemini: 0,
    unknown: 0,
  };
  for (const r of records) {
    const p = (r.route?.provider ?? "unknown") as Provider;
    if (p in provider_mix) provider_mix[p] += 1;
    else provider_mix.unknown += 1;
  }

  const severity: SeverityCounts = { info: 0, warn: 0, critical: 0 };
  const by_check: Partial<Record<CheckName, CheckTally>> = {};
  let skipCount = 0;

  for (const v of verdicts) {
    const tally = (by_check[v.check] ??= emptyTally());
    tally[v.status] += 1;
    tally.total += 1;
    if (v.status === "flag") {
      severity[v.severity] += 1;
      tally.worst = worse(tally.worst, v.severity);
    }
    if (v.status === "skip") skipCount += 1;
  }

  return {
    total_requests: records.length,
    rate_series: rateSeries(records),
    severity,
    provider_mix,
    skipped_pct:
      verdicts.length === 0
        ? 0
        : Math.round((skipCount / verdicts.length) * 1000) / 10,
    exposure_secret_lower_bound: exposureLowerBound(verdicts),
    by_check,
    verdict_count: verdicts.length,
  };
}

/** A zeroed aggregate, for the store's initial state before any snapshot. */
export function emptyAggregates(): Aggregates {
  return {
    total_requests: 0,
    rate_series: [],
    severity: { info: 0, warn: 0, critical: 0 },
    provider_mix: { openai: 0, anthropic: 0, gemini: 0, unknown: 0 },
    skipped_pct: 0,
    exposure_secret_lower_bound: 0,
    by_check: {},
    verdict_count: 0,
  };
}
