/**
 * BodyViewer — renders a captured request/response part of an EvidenceRecord in
 * the drawer. One component, two roles (kind="request" | "response").
 *
 * It is faithful to exactly what the proxy stored:
 *   - headers: lowercase map → values; an exact "REDACTED" value (Authorization /
 *     x-api-key / cookie, scrubbed before storage) renders as a RedactionMark,
 *     never silently hidden. headers are tagged UNTRUSTED on the response side.
 *   - body: respects raw_encoding.
 *       • base64  → "binary, not shown" note (we never re-encode/guess bytes).
 *       • utf8    → if it parses as JSON, a collapsible JsonView; otherwise text.
 *       • stream  → parsed SSE events (delta text + terminal usage) via parseSSE,
 *                   with a toggle to the raw concatenated SSE text.
 *   - [assay-redacted:TYPE] markers inside a utf8 body are surfaced distinctly
 *     (a secret was scrubbed from OUR stored copy before it was ever written —
 *     the real bytes were forwarded upstream; honesty + privacy).
 *   - truncated: a clear banner — the capture hit the proxy cap; bytes past it
 *     are uncounted, so anything derived from this body is a lower bound.
 *
 * Client component (JsonView + local toggles).
 */

"use client";

import { Fragment, useMemo, useState } from "react";
import type { Headers as HeaderMap, RequestPart, ResponsePart } from "@/lib/types";
import { JsonView } from "@/components/ui/JsonView";
import { RedactionMark } from "@/components/ui/RedactionMark";
import { fmtBytes } from "@/lib/format";
import { cn } from "@/lib/cn";
import { parseSSE } from "./sse";

type Part = RequestPart | ResponsePart;

export interface BodyViewerProps {
  kind: "request" | "response";
  part: Part;
  /** response only: whether the body is an SSE stream (route/response.stream). */
  stream?: boolean;
  className?: string;
}

const UNTRUSTED_TITLE = "UNTRUSTED — relay-reported, forgeable";
/** matches [assay-redacted:TYPE] markers in a scrubbed body. Build a fresh
 *  RegExp where iteration is needed; never reuse a global regex's lastIndex. */
const REDACTED_MARKER_SRC = "\\[assay-redacted:([a-z_]+)\\]";
function hasRedactionMarker(s: string): boolean {
  return s.includes("[assay-redacted:");
}

export function BodyViewer({ kind, part, stream, className }: BodyViewerProps) {
  const headersUntrusted = kind === "response"; // response headers are relay-controlled

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <HeadersBlock headers={part.headers} untrusted={headersUntrusted} />
      <BodyBlock part={part} stream={!!stream} />
    </div>
  );
}

/* ============================================================================
   Headers
   ========================================================================== */

function HeadersBlock({ headers, untrusted }: { headers: HeaderMap; untrusted: boolean }) {
  const keys = Object.keys(headers).sort();
  return (
    <section>
      <SubHead
        label="headers"
        right={
          untrusted ? (
            <span className="micro" style={{ color: "var(--sev-warn)" }} title={UNTRUSTED_TITLE}>
              ⚠ UNTRUSTED
            </span>
          ) : null
        }
      />
      {keys.length === 0 ? (
        <div className="micro" style={{ color: "var(--text-faint)" }}>
          (none captured)
        </div>
      ) : (
        <div className="well p-2 flex flex-col gap-0.5">
          {keys.map((k) => {
            const values = headers[k] ?? [];
            const isRedacted = values.length === 1 && values[0] === "REDACTED";
            return (
              <div key={k} className="flex items-baseline gap-2 min-w-0">
                <span
                  className="mono data-sm shrink-0"
                  style={{ color: "var(--text-dim)", minWidth: 130 }}
                >
                  {k}
                </span>
                <span className="min-w-0" style={{ wordBreak: "break-word" }}>
                  {isRedacted ? (
                    <RedactionMark
                      title="scrubbed before storage — the real header was forwarded upstream, never written to evidence"
                    />
                  ) : (
                    <span className="mono data-sm" style={{ color: "var(--text)" }}>
                      {values.join(", ")}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ============================================================================
   Body — encoding-aware
   ========================================================================== */

function BodyBlock({ part, stream }: { part: Part; stream: boolean }) {
  const sizeNote = (
    <span className="micro mono" style={{ color: "var(--text-faint)" }}>
      {fmtBytes(part.bytes)}
      {part.truncated ? " · truncated" : ""}
    </span>
  );

  return (
    <section>
      <SubHead label="body" right={sizeNote} />
      {part.truncated && (
        <div
          className="micro"
          style={{
            color: "var(--sev-warn)",
            background: "var(--sev-warn-bg)",
            border: "1px solid var(--sev-warn-border)",
            borderRadius: "var(--r-sm)",
            padding: "4px 8px",
            marginBottom: 6,
            lineHeight: 1.45,
          }}
        >
          截断 · capture hit the proxy size cap — bytes past the cap are uncounted;
          anything derived from this body is a lower bound.
        </div>
      )}
      <BodyContent part={part} stream={stream} />
    </section>
  );
}

function BodyContent({ part, stream }: { part: Part; stream: boolean }) {
  // binary / base64: we never guess or re-decode bytes.
  if (part.raw_encoding === "base64") {
    return (
      <div className="well p-3">
        <div className="micro" style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
          二进制（base64）· binary body — not shown. Stored as base64 because the
          captured bytes were not valid UTF-8. The integrity hash still covers
          these exact bytes.
        </div>
        <div className="mt-1.5 mono data-sm" style={{ color: "var(--text-faint)", wordBreak: "break-all" }}>
          {part.raw.slice(0, 96)}
          {part.raw.length > 96 ? "…" : ""}
        </div>
      </div>
    );
  }

  if (part.raw.length === 0) {
    return (
      <div className="micro" style={{ color: "var(--text-faint)" }}>
        (empty body)
      </div>
    );
  }

  if (stream) {
    return <SseBody raw={part.raw} />;
  }

  return <Utf8Body raw={part.raw} />;
}

/* ---- non-stream utf8: JSON tree if parseable, else marker-aware text ---- */

function Utf8Body({ raw }: { raw: string }) {
  const parsed = useMemo(() => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }, [raw]);

  const hasMarker = hasRedactionMarker(raw);

  if (parsed !== undefined) {
    return (
      <div className="well p-2">
        {hasMarker && <ScrubbedNote />}
        <JsonView
          data={parsed}
          defaultExpandDepth={2}
          untrustedKeys={["claimed_usage", "claimed_model", "system_fingerprint", "headers"]}
        />
      </div>
    );
  }

  // not JSON → show text, but render [assay-redacted:TYPE] markers distinctly
  return (
    <div className="well p-2">
      {hasMarker && <ScrubbedNote />}
      <pre
        className="mono data-sm"
        style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text)", margin: 0, lineHeight: 1.5 }}
      >
        <MarkerText text={raw} />
      </pre>
    </div>
  );
}

/* ---- stream: parsed SSE events with raw toggle ---- */

function SseBody({ raw }: { raw: string }) {
  const [view, setView] = useState<"events" | "raw">("events");
  const result = useMemo(() => parseSSE(raw), [raw]);

  return (
    <div className="flex flex-col gap-2">
      {/* reconstructed delivered text — what actually streamed to the client */}
      {result.text && (
        <div className="well p-2">
          <SubHead
            label="reconstructed text"
            right={
              <span className="micro mono" style={{ color: "var(--text-faint)" }}>
                {result.dataEvents} chunks{result.sawDone ? " · [DONE]" : " · no [DONE]"}
              </span>
            }
          />
          <div
            className="data-sm"
            style={{ color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5 }}
          >
            {result.text}
          </div>
          <div className="micro mt-1" style={{ color: "var(--text-faint)" }}>
            重建自 SSE delta · reassembled from delta events (for comparison with
            billed usage); the stored bytes below are authoritative.
          </div>
        </div>
      )}

      {/* terminal relay-reported usage, if the stream carried it */}
      {result.usage && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="micro" style={{ color: "var(--sev-warn)" }} title={UNTRUSTED_TITLE}>
            ⚠ usage (UNTRUSTED)
          </span>
          <span className="mono data-sm" style={{ color: "var(--text-dim)" }}>
            prompt {fmtNum(result.usage.prompt_tokens)} · completion{" "}
            {fmtNum(result.usage.completion_tokens)} · total {fmtNum(result.usage.total_tokens)}
          </span>
        </div>
      )}

      {/* events / raw toggle */}
      <div className="flex items-center gap-2">
        <Toggle active={view === "events"} onClick={() => setView("events")}>
          events ({result.events.length})
        </Toggle>
        <Toggle active={view === "raw"} onClick={() => setView("raw")}>
          raw SSE
        </Toggle>
      </div>

      {view === "events" ? (
        <div className="well p-2 flex flex-col gap-1" style={{ maxHeight: 320, overflow: "auto" }}>
          {result.events.map((ev) => (
            <div key={ev.index} className="flex gap-2 items-start min-w-0">
              <span
                className="micro mono shrink-0"
                style={{ color: "var(--text-ghost)", width: 26, textAlign: "right" }}
              >
                {ev.index}
              </span>
              <EventKindTag kind={ev.kind} />
              <span className="min-w-0 flex-1" style={{ wordBreak: "break-word" }}>
                {ev.done ? (
                  <span className="mono data-sm" style={{ color: "var(--sev-ok)" }}>
                    [DONE]
                  </span>
                ) : ev.json !== null && typeof ev.json === "object" ? (
                  <JsonView data={ev.json} defaultExpandDepth={1} maxStringLen={160} />
                ) : (
                  <span className="mono data-sm" style={{ color: "var(--text-dim)" }}>
                    {ev.raw}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="well p-2" style={{ maxHeight: 320, overflow: "auto" }}>
          <pre
            className="mono data-sm"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-dim)", margin: 0, lineHeight: 1.5 }}
          >
            {raw}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   Small bits
   ========================================================================== */

function SubHead({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-1">
      <span className="eyebrow">{label}</span>
      {right}
    </div>
  );
}

function ScrubbedNote() {
  return (
    <div className="micro mb-1.5" style={{ color: "var(--text-faint)", lineHeight: 1.45 }}>
      含 <span style={{ color: "var(--sev-warn)" }}>[assay-redacted:TYPE]</span> 标记 — a
      secret was scrubbed from OUR stored copy before it was written; the real
      bytes were forwarded upstream (privacy + honesty).
    </div>
  );
}

/** Render text, highlighting [assay-redacted:TYPE] markers as inline chips. */
function MarkerText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(REDACTED_MARKER_SRC, "g");
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>);
    parts.push(
      <span
        key={i++}
        className="chip mono"
        style={{
          color: "var(--sev-warn)",
          background: "var(--sev-warn-bg)",
          borderColor: "var(--sev-warn-border)",
          margin: "0 1px",
        }}
        title="a secret of this type was scrubbed from the stored body before write"
      >
        ▚ {m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={i++}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}

function EventKindTag({ kind }: { kind: "delta" | "usage" | "done" | "other" }) {
  const map = {
    delta: { label: "δ", color: "var(--accent)", title: "delta — assistant text chunk" },
    usage: { label: "Σ", color: "var(--sev-warn)", title: "usage — relay-reported token counts (untrusted)" },
    done: { label: "✓", color: "var(--sev-ok)", title: "stream end" },
    other: { label: "·", color: "var(--text-ghost)", title: "other event" },
  } as const;
  const t = map[kind];
  return (
    <span
      className="mono micro shrink-0"
      style={{ color: t.color, width: 12, textAlign: "center" }}
      title={t.title}
      aria-hidden
    >
      {t.label}
    </span>
  );
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="chip mono"
      style={{
        cursor: "pointer",
        color: active ? "var(--accent)" : "var(--text-dim)",
        background: active ? "var(--accent-ghost)" : "transparent",
        borderColor: active ? "var(--accent-dim)" : "var(--line)",
      }}
    >
      {children}
    </button>
  );
}

function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n);
}
