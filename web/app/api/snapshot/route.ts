/**
 * GET /api/snapshot — initial paint payload.
 *
 * Returns { records, verdicts, aggregates, chainStatus, lag, source, breakAt }.
 * Live if data/evidence.jsonl is non-empty, else Demo. The TopBar may force a
 * source with ?source=demo|live; the demo BREAK toggle is ?break=1[&seq=N].
 *
 * Strictly local: reads only the two JSONL files (or the in-process demo). No
 * external calls, ever.
 */

import { NextRequest } from "next/server";
import { buildSnapshot } from "@/lib/server/source";
import type { DataSource } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache; reflects files on each load
export const revalidate = 0;

function parseSource(req: NextRequest): DataSource | undefined {
  const s = req.nextUrl.searchParams.get("source");
  return s === "demo" || s === "live" ? s : undefined;
}

function parseBreak(req: NextRequest): boolean | number {
  const sp = req.nextUrl.searchParams;
  const seq = sp.get("seq");
  if (seq !== null && /^\d+$/.test(seq)) return Number(seq);
  const b = sp.get("break");
  return b === "1" || b === "true";
}

export async function GET(req: NextRequest) {
  try {
    const snapshot = await buildSnapshot({
      force: parseSource(req),
      demoBreak: parseBreak(req),
    });
    return Response.json(snapshot, {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    return Response.json(
      { error: "snapshot_failed", message: String(err) },
      { status: 500 },
    );
  }
}
