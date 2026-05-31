/**
 * JsonView — a compact, collapsible, syntax-tinted JSON tree for machine data
 * (the raw EvidenceRecord, verdict.detail, captured bodies parsed as JSON).
 * Mono, tabular, forensic. No deps.
 *
 *   - Objects/arrays are collapsible; depth ≤ `defaultExpandDepth` start open.
 *   - Keys listed in `untrustedKeys` get a small "UNTRUSTED" tag (claimed_usage,
 *     claimed_model, system_fingerprint, headers) — honesty rule.
 *   - Long strings truncate with a click-to-expand.
 *   - Values are tinted: strings, numbers, booleans, null each get a token color.
 *
 * Client component (local expand state per node).
 */

"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export interface JsonViewProps {
  data: unknown;
  /** nodes at depth < this start expanded (default 1). */
  defaultExpandDepth?: number;
  /** keys to flag as UNTRUSTED wherever they appear. */
  untrustedKeys?: string[];
  className?: string;
  /** max chars before a string value is truncated (default 120). */
  maxStringLen?: number;
}

const C = {
  key: "var(--text-dim)",
  string: "#8fd6c8",
  number: "#e0b072",
  boolean: "#b58bd6",
  null: "var(--text-faint)",
  punct: "var(--text-faint)",
  untrusted: "var(--sev-warn)",
};

export function JsonView({
  data,
  defaultExpandDepth = 1,
  untrustedKeys = [],
  className,
  maxStringLen = 120,
}: JsonViewProps) {
  const untrusted = new Set(untrustedKeys);
  return (
    <div className={cn("mono data-sm", className)} style={{ lineHeight: 1.55 }}>
      <Node
        value={data}
        depth={0}
        defaultExpandDepth={defaultExpandDepth}
        untrusted={untrusted}
        maxStringLen={maxStringLen}
        keyName={null}
        isLast
      />
    </div>
  );
}

interface NodeProps {
  value: unknown;
  depth: number;
  defaultExpandDepth: number;
  untrusted: Set<string>;
  maxStringLen: number;
  keyName: string | null;
  isLast: boolean;
}

function Node({
  value,
  depth,
  defaultExpandDepth,
  untrusted,
  maxStringLen,
  keyName,
  isLast,
}: NodeProps) {
  const isObject = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < defaultExpandDepth);

  const keyEl =
    keyName !== null ? (
      <>
        <span style={{ color: C.key }}>&quot;{keyName}&quot;</span>
        {untrusted.has(keyName) && (
          <span
            className="micro"
            style={{ color: C.untrusted, marginLeft: 4, marginRight: 2 }}
            title="UNTRUSTED — relay-reported, forgeable"
          >
            ⚠UNTRUSTED
          </span>
        )}
        <span style={{ color: C.punct }}>: </span>
      </>
    ) : null;

  if (!isObject) {
    return (
      <div style={{ paddingLeft: depth * 12 }}>
        {keyEl}
        <Leaf value={value} maxStringLen={maxStringLen} />
        {!isLast && <span style={{ color: C.punct }}>,</span>}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const openB = isArray ? "[" : "{";
  const closeB = isArray ? "]" : "}";
  const empty = entries.length === 0;

  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <span
        onClick={() => !empty && setOpen((o) => !o)}
        style={{ cursor: empty ? "default" : "pointer", userSelect: "none" }}
      >
        {keyEl}
        {!empty && (
          <span style={{ color: "var(--text-faint)", marginRight: 3 }}>
            {open ? "▾" : "▸"}
          </span>
        )}
        <span style={{ color: C.punct }}>{openB}</span>
        {!open && !empty && (
          <span style={{ color: "var(--text-ghost)" }}>
            {" "}
            {entries.length} {isArray ? "items" : "keys"}{" "}
          </span>
        )}
        {(!open || empty) && <span style={{ color: C.punct }}>{closeB}</span>}
        {(!open || empty) && !isLast && <span style={{ color: C.punct }}>,</span>}
      </span>

      {open && !empty && (
        <>
          {entries.map(([k, v], i) => (
            <Node
              key={k}
              value={v}
              depth={depth + 1}
              defaultExpandDepth={defaultExpandDepth}
              untrusted={untrusted}
              maxStringLen={maxStringLen}
              keyName={isArray ? null : k}
              isLast={i === entries.length - 1}
            />
          ))}
          <div style={{ paddingLeft: depth * 12 }}>
            <span style={{ color: C.punct }}>{closeB}</span>
            {!isLast && <span style={{ color: C.punct }}>,</span>}
          </div>
        </>
      )}
    </div>
  );
}

function Leaf({ value, maxStringLen }: { value: unknown; maxStringLen: number }) {
  const [expanded, setExpanded] = useState(false);

  if (value === null) return <span style={{ color: C.null }}>null</span>;
  if (typeof value === "boolean")
    return <span style={{ color: C.boolean }}>{String(value)}</span>;
  if (typeof value === "number")
    return <span style={{ color: C.number }} className="tnum">{value}</span>;

  const s = String(value);
  const isLong = s.length > maxStringLen;
  const shown = expanded || !isLong ? s : s.slice(0, maxStringLen) + "…";
  return (
    <span
      style={{ color: C.string, cursor: isLong ? "pointer" : "text", wordBreak: "break-word" }}
      onClick={() => isLong && setExpanded((e) => !e)}
      title={isLong ? (expanded ? "click to collapse" : `${s.length} chars — click to expand`) : undefined}
    >
      &quot;{shown}&quot;
    </span>
  );
}
