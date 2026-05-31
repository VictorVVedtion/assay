/**
 * GET /api/verify — chain verification status (VALID / EMPTY / TORN_TAIL / BREAK).
 *
 * Recomputes every record's hash with lib/digest (Web Crypto SHA-256) and
 * checks prev_hash linkage IN TYPESCRIPT — it does NOT shell out to the Go
 * binary. This is the same "anyone can recompute" guarantee the EvidenceDrawer
 * shows per-record, applied to the whole file.
 *
 * Returns the VerifyResult (status, records, break_seq, detail, warnings,
 * head_hash) plus { source, breakAt } for the demo BREAK toggle.
 */

import { NextRequest } from "next/server";
import { verifyOnly } from "@/lib/server/source";
import type { DataSource } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
    const { result, source, breakAt } = await verifyOnly({
      force: parseSource(req),
      demoBreak: parseBreak(req),
    });
    return Response.json(
      { ...result, source, breakAt },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { error: "verify_failed", message: String(err) },
      { status: 500 },
    );
  }
}
