/**
 * lib/server/paths.ts — resolve the local data directory and file paths.
 *
 * Data dir = env ASSAY_DATA_DIR, default "../data" relative to web/ (i.e. the
 * repo root /data). Resolved against process.cwd() per the brief. SERVER ONLY.
 *
 * The dashboard reads these two append-only JSONL files directly — no network,
 * ever. This module performs no I/O; it only computes absolute paths.
 */

import path from "node:path";

/** The configured data directory (absolute). */
export function dataDir(): string {
  const configured = process.env.ASSAY_DATA_DIR ?? "../data";
  return path.isAbsolute(configured)
    ? configured
    : // turbopackIgnore: the data dir is resolved at runtime (often "../data",
      // i.e. the repo root); without this, NFT traces the whole parent repo.
      path.join(/* turbopackIgnore: true */ process.cwd(), configured);
}

/** Absolute path to evidence.jsonl. */
export function evidencePath(): string {
  return path.join(dataDir(), "evidence.jsonl");
}

/** Absolute path to verdicts.jsonl. */
export function verdictsPath(): string {
  return path.join(dataDir(), "verdicts.jsonl");
}

/** Absolute path to the analyzer heartbeat (verdicts.jsonl.status), written by
 *  runner.py _write_heartbeat. Optional — absence ⇒ lag derived from seqs. */
export function heartbeatPath(): string {
  return verdictsPath() + ".status";
}

/** The env var name, surfaced in the manifest + onboarding card. */
export const DATA_DIR_ENV = "ASSAY_DATA_DIR";
