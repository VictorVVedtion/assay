/**
 * components/stream/sse.ts — a tolerant, client-side SSE reconstructor for the
 * EvidenceDrawer's BodyViewer. It mirrors internal/proxy/sse.go ParseSSE: walk
 * the captured `response.raw` (the exact concatenated SSE text the proxy teed),
 * split it into events on blank lines, strip one optional leading space after
 * `data:`, ignore comment / `event:` / `id:` lines, and reassemble:
 *
 *   - the delivered assistant text (chat.completions choices[0].delta.content
 *     and responses-API "response.output_text.delta" events), and
 *   - the relay-reported terminal usage (chat include_usage top-level `usage`,
 *     or the responses-API nested `response.usage`).
 *
 * This is display-only — we never trust these bytes (the relay produced them) —
 * but reconstructing them lets the drawer show "here is what actually streamed"
 * next to the billed numbers, which is the whole point of token_recount.
 *
 * Pure, dependency-free, isomorphic. No "use client" needed (no state / DOM).
 */

import type { Usage } from "@/lib/types";

/** One parsed SSE `data:` event, kept in delivery order for the drawer. */
export interface SseEvent {
  /** zero-based index across all `data:` events (including [DONE]/usage-only). */
  index: number;
  /** the raw payload after `data:` (one optional leading space stripped). */
  raw: string;
  /** parsed JSON payload, or null for `[DONE]` / non-JSON keep-alives. */
  json: unknown;
  /** true for the terminal `data: [DONE]` sentinel. */
  done: boolean;
  /** the incremental assistant text this event contributed (if any). */
  delta: string;
  /** usage object carried by this event (terminal include_usage chunk), if any. */
  usage: Usage | null;
  /** a short classification for the row label. */
  kind: "delta" | "usage" | "done" | "other";
}

export interface SseParseResult {
  events: SseEvent[];
  /** concatenated delivered assistant text across all delta events. */
  text: string;
  /** count of events with non-empty choices (matches timing.stream_chunks). */
  dataEvents: number;
  /** saw the `[DONE]` sentinel — clean completion. */
  sawDone: boolean;
  /** last usage object seen (the billed numbers the relay reported). */
  usage: Usage | null;
}

/** Best-effort JSON parse; SSE payloads may be keep-alives or `[DONE]`. */
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function asUsage(u: unknown): Usage | null {
  if (u === null || typeof u !== "object") return null;
  // Trust the shape loosely; these are UNTRUSTED display values anyway.
  return u as Usage;
}

/**
 * extractEvent — derive delta text + usage + kind from one parsed payload,
 * faithful to sse.go consumeEvent (chat choices[0].delta.content, responses
 * output_text.delta, top-level usage, nested response.usage).
 */
function extractEvent(payload: unknown): {
  delta: string;
  usage: Usage | null;
  counted: boolean;
  kind: SseEvent["kind"];
} {
  if (payload === null || typeof payload !== "object") {
    return { delta: "", usage: null, counted: false, kind: "other" };
  }
  const ev = payload as Record<string, unknown>;

  // responses-API text delta event
  if (typeof ev.type === "string" && ev.type === "response.output_text.delta") {
    const delta = typeof ev.delta === "string" ? ev.delta : "";
    return { delta, usage: null, counted: delta.length > 0, kind: "delta" };
  }

  // usage may appear top-level (chat include_usage) ...
  let usage: Usage | null = asUsage(ev.usage);
  // ... or nested in a responses-API "response" object on the terminal event.
  if (!usage && ev.response && typeof ev.response === "object") {
    usage = asUsage((ev.response as Record<string, unknown>).usage);
  }

  // chat.completions: choices[].delta.content
  let delta = "";
  let counted = false;
  if (Array.isArray(ev.choices)) {
    if (ev.choices.length > 0) {
      counted = true; // a data event with non-empty choices → stream_chunk
      const first = ev.choices[0] as Record<string, unknown> | undefined;
      const d = first && (first.delta as Record<string, unknown> | undefined);
      const content = d && d.content;
      if (typeof content === "string") delta = content;
    }
    // choices:[] (terminal usage chunk) → not counted as a data event
  }

  const kind: SseEvent["kind"] = delta ? "delta" : usage ? "usage" : "other";
  return { delta, usage, counted, kind };
}

/**
 * parseSSE — reconstruct a captured SSE stream body for display. Tolerant of
 * \n / \r\n, comment lines, and multi-line `data:` fields.
 */
export function parseSSE(raw: string): SseParseResult {
  const events: SseEvent[] = [];
  let text = "";
  let dataEvents = 0;
  let sawDone = false;
  let lastUsage: Usage | null = null;

  // Normalize CRLF → LF, then split into SSE event blocks on blank lines.
  const norm = raw.replace(/\r\n/g, "\n");
  // A trailing "\n\n" produces an empty final block; filter blanks below.
  const blocks = norm.split(/\n\n+/);

  let index = 0;
  for (const block of blocks) {
    // Collect this block's `data:` lines (ignore :comment, event:, id:, retry:).
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        let d = line.slice("data:".length);
        if (d.startsWith(" ")) d = d.slice(1); // strip exactly one leading space
        dataLines.push(d);
      }
      // other SSE fields ignored for capture (matches sse.go)
    }
    if (dataLines.length === 0) continue;

    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      sawDone = true;
      events.push({
        index: index++,
        raw: payload,
        json: null,
        done: true,
        delta: "",
        usage: null,
        kind: "done",
      });
      continue;
    }

    const json = tryParse(payload);
    const { delta, usage, counted, kind } = extractEvent(json);
    if (delta) text += delta;
    if (counted) dataEvents += 1;
    if (usage) lastUsage = usage;

    events.push({
      index: index++,
      raw: payload,
      json: json === undefined ? null : json,
      done: false,
      delta,
      usage,
      kind,
    });
  }

  return { events, text, dataEvents, sawDone, usage: lastUsage };
}
