/**
 * lib/server/jsonl.ts — read + parse evidence.jsonl / verdicts.jsonl. SERVER ONLY.
 *
 * Tolerant of a torn last line (a crash artifact, not tamper — PHASE0.md §4,
 * mirroring evidence.py iter_evidence): if the file does not end in "\n", the
 * final partial line is dropped. Interior unparseable lines are skipped with a
 * recorded warning rather than throwing, so a single bad line never blanks the
 * console (the chain-verify route is the authority on tamper).
 */

import { readFile, stat } from "node:fs/promises";
import type { EvidenceRecord, VerdictRecord } from "../types.ts";

export interface ReadResult<T> {
  rows: T[];
  /** the line was present but had no trailing newline (torn tail dropped). */
  tornTail: boolean;
  /** byte length read (offset to resume a tailer from). */
  byteLength: number;
  /** lines that were newline-terminated but failed to parse (interior). */
  badLines: number;
  /** true if the file does not exist. */
  missing: boolean;
}

/** Split a buffer into complete, newline-terminated lines; report a torn tail. */
export function splitCompleteLines(buf: Buffer): {
  lines: string[];
  tornTail: boolean;
} {
  if (buf.length === 0) return { lines: [], tornTail: false };
  const endsWithNewline = buf[buf.length - 1] === 0x0a;
  const text = buf.toString("utf8");
  const parts = text.split("\n");
  // A trailing "\n" yields a final "" element; a torn tail yields a final
  // partial line. Either way the last element is not a complete line.
  parts.pop();
  return { lines: parts, tornTail: !endsWithNewline };
}

async function readJsonl<T>(
  filePath: string,
  validate?: (obj: unknown) => obj is T,
): Promise<ReadResult<T>> {
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { rows: [], tornTail: false, byteLength: 0, badLines: 0, missing: true };
    }
    throw err;
  }

  const { lines, tornTail } = splitCompleteLines(buf);
  const rows: T[] = [];
  let badLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (!validate || validate(obj)) rows.push(obj as T);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { rows, tornTail, byteLength: buf.length, badLines, missing: false };
}

function looksLikeEvidence(o: unknown): o is EvidenceRecord {
  if (typeof o !== "object" || o === null) return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.seq === "number" &&
    typeof r.id === "string" &&
    typeof r.hash === "string" &&
    typeof r.prev_hash === "string" &&
    typeof r.route === "object"
  );
}

function looksLikeVerdict(o: unknown): o is VerdictRecord {
  if (typeof o !== "object" || o === null) return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.record_id === "string" &&
    typeof r.check === "string" &&
    typeof r.status === "string"
  );
}

export function readEvidence(filePath: string): Promise<ReadResult<EvidenceRecord>> {
  return readJsonl<EvidenceRecord>(filePath, looksLikeEvidence);
}

export function readVerdicts(filePath: string): Promise<ReadResult<VerdictRecord>> {
  return readJsonl<VerdictRecord>(filePath, looksLikeVerdict);
}

/** True if a file exists and has non-zero size (used to pick Live vs Demo). */
export async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}
