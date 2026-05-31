/**
 * lib/server/tail.ts — follow an append-only JSONL file and yield complete new
 * lines as they arrive. SERVER ONLY. Used by the Live /api/stream route.
 *
 * Design (mirrors the analyzer's tail discipline, PHASE0.md §8):
 *   - Only emit lines that end in "\n" (a torn trailing line is a crash
 *     artifact; we hold it in a carry buffer until its newline arrives).
 *   - Track a byte offset; on each change read only the new bytes.
 *   - Rotation / truncation aware: if the file shrinks (size < offset) or its
 *     inode changes, reset the offset to 0 and re-read from the top.
 *   - fs.watch is unreliable across platforms/FUSE, so we use it as a *hint*
 *     and ALSO poll on a modest interval — whichever fires first triggers a
 *     drain. Either way we only ever read the delta.
 *   - Fully cancellable: stop() removes the watcher and clears the timer.
 *
 * This is an async generator so the route can `for await (const line of …)`.
 */

import { open, stat, watch as fsWatch } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export interface TailHandle {
  /** async iterator of complete (newline-terminated, newline stripped) lines. */
  lines: AsyncGenerator<string, void, void>;
  /** stop watching and release resources. */
  stop: () => void;
}

interface TailOptions {
  /** start at end of file (true) or replay from the top (false). */
  fromStart?: boolean;
  /** poll interval ms as a safety net behind fs.watch. */
  pollMs?: number;
  /** abort signal (e.g. request close). */
  signal?: AbortSignal;
}

/**
 * Tail one file. Resolves quickly even if the file does not yet exist (it will
 * begin emitting once it appears). Lines already present are emitted only if
 * fromStart is true.
 */
export function tailFile(filePath: string, opts: TailOptions = {}): TailHandle {
  const pollMs = opts.pollMs ?? 500;
  const fromStart = opts.fromStart ?? false;

  let stopped = false;
  let offset = 0;
  let inode: number | null = null;
  let carry = ""; // partial trailing line without a newline yet
  let wake: (() => void) | null = null;
  let watcherAbort: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const signalWake = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const onExternalAbort = () => stop();
  if (opts.signal) {
    if (opts.signal.aborted) stopped = true;
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  function stop() {
    if (stopped) {
      signalWake();
      return;
    }
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (watcherAbort) watcherAbort.abort();
    watcherAbort = null;
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
    signalWake();
  }

  // Start the fs.watch hint (best-effort) and the poll safety net.
  async function startWatcher() {
    watcherAbort = new AbortController();
    try {
      const watcher = fsWatch(filePath, { signal: watcherAbort.signal });
      for await (const _ of watcher) {
        void _;
        if (stopped) break;
        signalWake();
      }
    } catch {
      // file may not exist yet, or platform threw — the poll loop covers us.
    }
  }

  async function readDelta(): Promise<string[]> {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      return []; // not present yet
    }
    // rotation / truncation detection
    if (inode === null) {
      inode = st.ino;
      offset = fromStart ? 0 : st.size;
    } else if (st.ino !== inode || st.size < offset) {
      // rotated or truncated → start over from the top
      inode = st.ino;
      offset = 0;
      carry = "";
    }
    if (st.size <= offset) return [];

    let fh: FileHandle | null = null;
    try {
      fh = await open(filePath, "r");
      const length = st.size - offset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      offset += bytesRead;
      const chunk = carry + buf.subarray(0, bytesRead).toString("utf8");
      const parts = chunk.split("\n");
      carry = parts.pop() ?? ""; // keep the (possibly partial) trailing piece
      return parts;
    } catch {
      return [];
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  async function* generate(): AsyncGenerator<string, void, void> {
    // kick off watcher + poll
    void startWatcher();
    timer = setInterval(signalWake, pollMs);

    try {
      // initial drain
      for (const line of await readDelta()) {
        if (line.trim()) yield line;
      }
      while (!stopped) {
        // wait for a wake (watch event, poll tick, or stop)
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (stopped) resolve();
        });
        if (stopped) break;
        const lines = await readDelta();
        for (const line of lines) {
          if (stopped) break;
          if (line.trim()) yield line;
        }
      }
    } finally {
      stop();
    }
  }

  return { lines: generate(), stop };
}
