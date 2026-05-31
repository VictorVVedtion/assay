/**
 * MonoHash — render machine data (hash, id, fingerprint, prev_hash) in mono with
 * tabular-nums, truncated to head…tail, click-to-copy, and an optional expand
 * toggle to reveal the full value inline. The copy affordance embodies the
 * project's "anyone can recompute" ethos — the buyer can grab the exact bytes.
 *
 * Client component (uses clipboard + local expand state).
 */

"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export interface MonoHashProps {
  value: string;
  /** chars to show from the head when truncated (default 8). */
  head?: number;
  /** chars to show from the tail when truncated (default 6). 0 = head only. */
  tail?: number;
  /** allow click to expand to the full value (default true). */
  expandable?: boolean;
  /** enable click-to-copy (default true). */
  copyable?: boolean;
  /** color the text with the accent (e.g. the matching/verified hash). */
  tone?: "default" | "accent" | "ok" | "critical" | "dim";
  className?: string;
  /** label prefix shown faint before the value, e.g. "sha256". */
  prefix?: string;
}

const TONE_COLOR: Record<NonNullable<MonoHashProps["tone"]>, string> = {
  default: "var(--text)",
  accent: "var(--accent)",
  ok: "var(--sev-ok)",
  critical: "var(--sev-critical)",
  dim: "var(--text-dim)",
};

export function MonoHash({
  value,
  head = 8,
  tail = 6,
  expandable = true,
  copyable = true,
  tone = "default",
  className,
  prefix,
}: MonoHashProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const isLong = value.length > head + tail + 1;
  const display =
    expanded || !isLong
      ? value
      : tail > 0
        ? `${value.slice(0, head)}…${value.slice(-tail)}`
        : `${value.slice(0, head)}…`;

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch {
      /* clipboard unavailable */
    }
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (expandable && isLong) setExpanded((v) => !v);
  };

  return (
    <span
      className={cn("mono data-sm inline-flex items-center gap-1 align-middle", className)}
      style={{ color: TONE_COLOR[tone], maxWidth: "100%" }}
    >
      {prefix && (
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          {prefix}
        </span>
      )}
      <span
        onClick={toggle}
        style={{
          cursor: expandable && isLong ? "pointer" : "default",
          wordBreak: expanded ? "break-all" : "normal",
          whiteSpace: expanded ? "normal" : "nowrap",
        }}
        title={isLong ? (expanded ? "click to collapse" : value) : value}
      >
        {display}
      </span>
      {copyable && (
        <button
          type="button"
          onClick={copy}
          className="shrink-0"
          aria-label={copied ? "copied" : "copy to clipboard"}
          style={{
            color: copied ? "var(--accent-bright)" : "var(--text-faint)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: "11px",
            lineHeight: 1,
            padding: "1px 2px",
          }}
          title={copied ? "copied" : "copy"}
        >
          {copied ? "✓" : "⧉"}
        </button>
      )}
    </span>
  );
}
