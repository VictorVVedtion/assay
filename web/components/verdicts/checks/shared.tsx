/**
 * components/verdicts/checks/shared.tsx — small composable bits shared by the
 * per-check detail renderers. Kept here so the honest-boundary framing (the
 * load-bearing caveat notes) renders identically everywhere and the detail
 * bodies stay dense + readable.
 *
 * Visual language: hairline-separated label/value rows (sans label, mono data),
 * a muted "honest frame" footnote treatment, and a neutral KV grid for counts.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/* ----------------------------------------------------------------------------
   Section — a small titled block inside a detail body.
   ---------------------------------------------------------------------------- */
export function Section({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  /** right-aligned small adornment (e.g. a chip / count). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {(title != null || aside != null) && (
        <div className="flex items-center gap-2">
          {title != null && <span className="eyebrow">{title}</span>}
          {aside != null && <span className="ml-auto">{aside}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Row — one label/value line. Label is a faint sans caption; value is the slot.
   ---------------------------------------------------------------------------- */
export function Row({
  label,
  children,
  title,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex items-baseline gap-3 py-1 border-b border-line-soft last:border-0", className)}
      title={title}
    >
      <span
        className="shrink-0 text-faint"
        style={{ fontSize: "var(--fs-data-sm)", minWidth: 96 }}
      >
        {label}
      </span>
      <span className="ml-auto text-right min-w-0">{children}</span>
    </div>
  );
}

/** A bare mono value (tabular). */
export function Mono({
  children,
  tone,
  className,
}: {
  children: ReactNode;
  tone?: "default" | "dim" | "faint" | "ok" | "warn" | "critical" | "accent";
  className?: string;
}) {
  const color =
    tone === "dim"
      ? "var(--text-dim)"
      : tone === "faint"
        ? "var(--text-faint)"
        : tone === "ok"
          ? "var(--sev-ok)"
          : tone === "warn"
            ? "var(--sev-warn)"
            : tone === "critical"
              ? "var(--sev-critical)"
              : tone === "accent"
                ? "var(--accent)"
                : "var(--text)";
  return (
    <span className={cn("mono data-sm tnum", className)} style={{ color }}>
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------------------
   HonestFrame — the load-bearing caveat note. This is what makes the console
   honest; it is deliberately quiet (faint) but always present. `note` is the
   verbatim string from the analyzer's verdict.detail.note.
   ---------------------------------------------------------------------------- */
export function HonestFrame({
  children,
  icon = "ⓘ",
  className,
}: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn("flex gap-1.5 leading-relaxed", className)}
      style={{ fontSize: "var(--fs-micro)", color: "var(--text-faint)" }}
    >
      <span aria-hidden style={{ flex: "none", opacity: 0.8 }}>
        {icon}
      </span>
      <span>{children}</span>
    </p>
  );
}

/* ----------------------------------------------------------------------------
   KVChips — render a {key: count} map (e.g. exposure secrets/pii) as labeled
   count chips. Empty map → a quiet "none" so absence is explicit.
   ---------------------------------------------------------------------------- */
export function KVChips({
  map,
  tone = "neutral",
  emptyLabel = "none",
}: {
  map: Record<string, number> | undefined | null;
  /** "warn" tints chips amber (secrets); "neutral" stays calm (pii/code). */
  tone?: "warn" | "neutral";
  emptyLabel?: string;
}) {
  const entries = Object.entries(map ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) {
    return (
      <span className="mono data-sm" style={{ color: "var(--text-ghost)" }}>
        {emptyLabel}
      </span>
    );
  }
  const color = tone === "warn" ? "var(--sev-warn)" : "var(--text-dim)";
  const bg = tone === "warn" ? "var(--sev-warn-bg)" : "var(--panel-3)";
  const border = tone === "warn" ? "var(--sev-warn-border)" : "var(--line)";
  return (
    <span className="inline-flex flex-wrap gap-1 justify-end">
      {entries.map(([k, n]) => (
        <span
          key={k}
          className="chip mono"
          style={{ color, background: bg, borderColor: border }}
          title={`${k}: ${n}`}
        >
          {k}
          <span className="tnum" style={{ opacity: 0.85 }}>
            ×{n}
          </span>
        </span>
      ))}
    </span>
  );
}

/* ----------------------------------------------------------------------------
   SignalList — provenance signals_present (✓) / signals_absent (·). Present are
   calm-ok; absent are faint/neutral (absence is suspicion, not a red failure).
   ---------------------------------------------------------------------------- */
export function SignalList({
  present = [],
  absent = [],
}: {
  present?: string[];
  absent?: string[];
}) {
  if (present.length === 0 && absent.length === 0) {
    return (
      <span className="data-sm" style={{ color: "var(--text-ghost)" }}>
        no fingerprint signals defined
      </span>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5" style={{ fontSize: "var(--fs-data-sm)" }}>
      {present.map((s) => (
        <li key={`p-${s}`} className="flex items-baseline gap-1.5">
          <span aria-hidden style={{ color: "var(--sev-ok)", flex: "none" }}>
            ✓
          </span>
          <span style={{ color: "var(--text-dim)" }}>{s}</span>
        </li>
      ))}
      {absent.map((s) => (
        <li key={`a-${s}`} className="flex items-baseline gap-1.5">
          <span aria-hidden style={{ color: "var(--text-ghost)", flex: "none" }}>
            ·
          </span>
          <span style={{ color: "var(--text-faint)" }}>{s}</span>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------------------
   TellChips — relay_stack_tells: leaked new-api/one-api markers. Neutral info
   chips (they confirm a reseller stack; not themselves a fraud verdict).
   ---------------------------------------------------------------------------- */
export function TellChips({ tells = [] }: { tells?: string[] }) {
  if (tells.length === 0) {
    return (
      <span className="mono data-sm" style={{ color: "var(--text-ghost)" }}>
        none observed
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap gap-1 justify-end">
      {tells.map((t) => (
        <span
          key={t}
          className="chip mono"
          style={{
            color: "var(--text-dim)",
            background: "var(--panel-3)",
            borderColor: "var(--line)",
          }}
          title={t}
        >
          {t}
        </span>
      ))}
    </span>
  );
}

/* ----------------------------------------------------------------------------
   SkipNote — the standard neutral "not applicable" treatment for a skipped
   check. skip ≠ fail (honest-boundary rule #9): muted, never red.
   ---------------------------------------------------------------------------- */
export function SkipNote({ reason, extra }: { reason?: string; extra?: ReactNode }) {
  return (
    <div
      className="well p-2.5 flex flex-col gap-1"
      style={{ fontSize: "var(--fs-data-sm)" }}
    >
      <div className="flex items-baseline gap-1.5" style={{ color: "var(--text-dim)" }}>
        <span aria-hidden style={{ color: "var(--sev-skip)", opacity: 0.7 }}>
          ⏾
        </span>
        <span>
          <span style={{ color: "var(--text-faint)" }}>not applicable</span>
          {reason ? <> — {reason}</> : null}
        </span>
      </div>
      {extra}
      <span className="micro" style={{ color: "var(--text-ghost)" }}>
        skipped is NORMAL here — this check did not apply to this record, and that is
        not a failure.
      </span>
    </div>
  );
}

/** A small inline numeric delta with directional tint and an optional pct. */
export function Delta({
  value,
  pct,
  /** true → positive value is the BAD direction (red); false → positive is fine. */
  positiveIsBad = false,
}: {
  value: number;
  pct?: number | null;
  positiveIsBad?: boolean;
}) {
  const sign = value > 0 ? "+" : "";
  const bad = positiveIsBad ? value > 0 : value < 0;
  const color = value === 0 ? "var(--text-faint)" : bad ? "var(--sev-warn)" : "var(--sev-ok)";
  return (
    <span className="mono data-sm tnum" style={{ color }}>
      {sign}
      {value}
      {pct !== undefined && pct !== null ? (
        <span style={{ opacity: 0.7 }}>
          {" "}
          ({sign}
          {pct}%)
        </span>
      ) : null}
    </span>
  );
}
