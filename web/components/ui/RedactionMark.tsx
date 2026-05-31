/**
 * RedactionMark — renders a redacted value (e.g. an Authorization header scrubbed
 * to "REDACTED", or a body secret replaced with [assay-redacted:TYPE]). Visually
 * a struck, monospace token so the reader sees that something WAS there and was
 * scrubbed before storage — never silently hidden (privacy + honesty).
 */

import { cn } from "@/lib/cn";

export interface RedactionMarkProps {
  /** the redaction kind shown in the chip, e.g. "openai_key" or "REDACTED". */
  label?: string;
  className?: string;
  title?: string;
}

export function RedactionMark({ label = "REDACTED", className, title }: RedactionMarkProps) {
  return (
    <span
      className={cn("chip mono", className)}
      style={{
        color: "var(--text-faint)",
        background: "repeating-linear-gradient(135deg, transparent, transparent 4px, rgba(255,255,255,0.03) 4px, rgba(255,255,255,0.03) 8px)",
        borderColor: "var(--line-strong)",
        letterSpacing: "0.04em",
      }}
      title={title ?? "scrubbed before storage — the real value was forwarded upstream, never written to evidence"}
    >
      <span aria-hidden>▚</span>
      {label}
    </span>
  );
}
