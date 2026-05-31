/**
 * StatusPill — a verdict's status (ok / flag / skip / error).
 *
 * Honest-boundary rules baked in:
 *   - skip ≠ fail → rendered DIM/neutral ("napping" gray, ~55% opacity) with a
 *     "不适用 / not applicable" reading, NEVER red (rule #9).
 *   - ok reads as calm slate-teal, framed as "within scope", never a global
 *     green "verified/safe" (rule #2).
 *   - flag inherits the verdict's severity color when given; otherwise neutral.
 *   - error is a muted violet-gray, distinct from warn (analyzer couldn't run,
 *     which is not a fraud signal).
 */

import type { Severity, Status } from "@/lib/types";
import { STATUS_META, SEVERITY_META } from "@/lib/constants";
import { cn } from "@/lib/cn";

export interface StatusPillProps {
  status: Status;
  /** for flags, color by severity; ignored for non-flag statuses. */
  severity?: Severity;
  /** show the bilingual Chinese label instead of the English short label. */
  cjk?: boolean;
  className?: string;
}

export function StatusPill({ status, severity, cjk, className }: StatusPillProps) {
  const meta = STATUS_META[status];
  const text = cjk ? meta.cjk : meta.label;

  let color = "var(--text-dim)";
  let bg = "transparent";
  let border = "var(--line)";

  switch (status) {
    case "ok":
      color = "var(--sev-ok)";
      bg = "var(--sev-ok-bg)";
      border = "var(--sev-ok-border)";
      break;
    case "flag": {
      const sm = severity ? SEVERITY_META[severity] : SEVERITY_META.warn;
      color = `var(${sm.colorVar})`;
      bg = `var(${sm.bgVar})`;
      border = `var(${sm.borderVar})`;
      break;
    }
    case "skip":
      color = "var(--sev-skip)";
      bg = "var(--sev-skip-bg)";
      border = "var(--sev-skip-border)";
      break;
    case "error":
      color = "var(--sev-error)";
      bg = "var(--sev-error-bg)";
      border = "var(--sev-error-border)";
      break;
  }

  return (
    <span
      className={cn("pill", status === "skip" && "is-skip", className)}
      style={{ color, background: bg, borderColor: border }}
      title={status === "skip" ? "跳过 — 该 check 对此记录不适用 (not applicable, NOT a failure)" : undefined}
    >
      {text}
    </span>
  );
}
