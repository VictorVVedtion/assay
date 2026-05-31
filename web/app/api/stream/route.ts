/**
 * GET /api/stream — Server-Sent Events feed of new evidence + verdicts.
 *
 *   event: meta      data: { chainStatus, lag, source, breakAt }   (on connect + periodically)
 *   event: evidence  data: <EvidenceRecord>
 *   event: verdict   data: <VerdictRecord>
 *   event: ping      data: <iso ts>                                 (keep-alive)
 *
 * Live:  tails data/evidence.jsonl + data/verdicts.jsonl (lib/server/tail) and
 *        emits each complete new line. A periodic meta refresh re-verifies the
 *        chain + recomputes lag so the TopBar pills stay live.
 * Demo:  deterministically "plays" the bundled story — replays the records and
 *        their verdicts on a gentle cadence so the console animates with zero
 *        setup, then idles (re-sending meta) so reconnects are cheap.
 *
 * All watchers/timers are torn down when the client disconnects (request.signal
 * abort) or the stream is cancelled. Strictly local — no external calls.
 */

import { NextRequest } from "next/server";
import { tailFile } from "@/lib/server/tail";
import { evidencePath, verdictsPath } from "@/lib/server/paths";
import { resolveSource, verifyOnly, buildSnapshot } from "@/lib/server/source";
import { buildDemoSource, DEMO_BREAK_SEQ } from "@/lib/server/demo";
import type { DataSource } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PING_MS = 15_000;
const META_REFRESH_MS = 4_000;
const DEMO_STEP_MS = 900;

function sse(event: string, data: unknown): Uint8Array {
  const payload =
    typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${payload}\n\n`);
}

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
  const force = parseSource(req);
  const demoBreakRaw = parseBreak(req);
  const source = await resolveSource(force);
  const signal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const timers: ReturnType<typeof setInterval>[] = [];
      const stoppers: Array<() => void> = [];

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        for (const s of stoppers) {
          try {
            s();
          } catch {
            /* ignore */
          }
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      if (signal.aborted) {
        cleanup();
        return;
      }
      signal.addEventListener("abort", cleanup, { once: true });

      // keep-alive ping
      timers.push(
        setInterval(() => safeEnqueue(sse("ping", new Date().toISOString())), PING_MS),
      );

      if (source === "demo") {
        // Initial meta from the full snapshot (chain reflects the BREAK toggle).
        const snap = await buildSnapshot({ force: "demo", demoBreak: demoBreakRaw });
        safeEnqueue(
          sse("meta", {
            chainStatus: snap.chainStatus,
            lag: snap.lag,
            source: "demo",
            breakAt: snap.breakAt ?? null,
          }),
        );

        // Play the story: interleave each record then its verdicts.
        const breakAt =
          demoBreakRaw === true
            ? DEMO_BREAK_SEQ
            : typeof demoBreakRaw === "number"
              ? demoBreakRaw
              : null;
        const { records, verdicts } = await buildDemoSource(breakAt);
        const verdictsBySeq = new Map<number, typeof verdicts>();
        for (const v of verdicts) {
          const arr = verdictsBySeq.get(v.record_seq) ?? [];
          arr.push(v);
          verdictsBySeq.set(v.record_seq, arr);
        }

        let i = 0;
        const step = () => {
          if (closed) return;
          if (i < records.length) {
            const rec = records[i];
            safeEnqueue(sse("evidence", rec));
            for (const v of verdictsBySeq.get(rec.seq) ?? []) {
              safeEnqueue(sse("verdict", v));
            }
            i++;
          } else {
            // story told — idle, refreshing meta so the live dot stays warm.
            safeEnqueue(
              sse("meta", {
                chainStatus: snap.chainStatus,
                lag: snap.lag,
                source: "demo",
                breakAt: snap.breakAt ?? null,
              }),
            );
          }
        };
        // first step immediately, then on a cadence
        step();
        timers.push(setInterval(step, DEMO_STEP_MS));
        return;
      }

      // ----- LIVE -----
      // Initial meta.
      try {
        const { result, breakAt } = await verifyOnly({ force: "live" });
        const snap = await buildSnapshot({ force: "live" });
        safeEnqueue(
          sse("meta", {
            chainStatus: result,
            lag: snap.lag,
            source: "live",
            breakAt: breakAt ?? null,
          }),
        );
      } catch {
        /* tolerate a transient read error; meta refresh will retry */
      }

      // Tail both files from the END (snapshot already painted history).
      const evTail = tailFile(evidencePath(), { fromStart: false, signal });
      const vdTail = tailFile(verdictsPath(), { fromStart: false, signal });
      stoppers.push(evTail.stop, vdTail.stop);

      (async () => {
        for await (const line of evTail.lines) {
          if (closed) break;
          try {
            const rec = JSON.parse(line);
            safeEnqueue(sse("evidence", rec));
          } catch {
            /* skip unparseable line */
          }
        }
      })();

      (async () => {
        for await (const line of vdTail.lines) {
          if (closed) break;
          try {
            const v = JSON.parse(line);
            safeEnqueue(sse("verdict", v));
          } catch {
            /* skip unparseable line */
          }
        }
      })();

      // Periodic meta refresh (re-verify chain + lag).
      timers.push(
        setInterval(async () => {
          if (closed) return;
          try {
            const { result, breakAt } = await verifyOnly({ force: "live" });
            const snap = await buildSnapshot({ force: "live" });
            safeEnqueue(
              sse("meta", {
                chainStatus: result,
                lag: snap.lag,
                source: "live",
                breakAt: breakAt ?? null,
              }),
            );
          } catch {
            /* ignore transient errors */
          }
        }, META_REFRESH_MS),
      );
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
