/**
 * ChainStatusBanner — the prominent, status-aware verdict on chain integrity,
 * shown at the head of the ChainPanel body. This is where the BREAK ⇒ TAMPER
 * state reads loudest (PHASE0.md §4, honest-boundary rule #8): intensified red,
 * a slow ominous pulse, and the non-negotiable line
 *   "证据被篡改 — 以下裁决不可信 / EVIDENCE TAMPERED — verdicts cannot be trusted."
 *
 * Honest framing per status:
 *   VALID     — calm slate-teal; "N 条链接经浏览器内 SHA-256 重算" (NOT a green "safe").
 *   EMPTY     — neutral; "暂无证据".
 *   TORN_TAIL — amber; "末行残缺=崩溃,可恢复" (recoverable crash artifact, not tamper).
 *   BREAK     — tamper; the break detail + the tamper line.
 *
 * It also surfaces the project's honest LIMIT of a local chain: it is
 * tamper-EVIDENT, not tamper-PROOF — a holder with write access can rewrite the
 * whole file; only external anchoring (Ed25519 / TSA, deferred) raises that bar
 * (PHASE0.md §4.1 / §0.10).
 */

"use client";

import { StatusDot } from "@/components/ui/StatusDot";
import { MonoHash } from "@/components/ui/MonoHash";
import { CHAIN_STATUS_META, SCOPE_BANNER } from "@/lib/constants";
import { fmtInt } from "@/lib/format";
import type { DotTone } from "@/components/ui/StatusDot";
import type { VerifyResult } from "@/lib/types";

const TONE_VARS: Record<
  "ok" | "info" | "warn" | "tamper",
  { color: string; bg: string; border: string; dot: DotTone }
> = {
  ok: { color: "var(--sev-ok)", bg: "var(--sev-ok-bg)", border: "var(--sev-ok-border)", dot: "ok" },
  info: { color: "var(--sev-info)", bg: "var(--sev-info-bg)", border: "var(--sev-info-border)", dot: "info" },
  warn: { color: "var(--sev-warn)", bg: "var(--sev-warn-bg)", border: "var(--sev-warn-border)", dot: "warn" },
  tamper: {
    color: "var(--sev-tamper)",
    bg: "var(--sev-tamper-bg)",
    border: "var(--sev-tamper-border)",
    dot: "tamper",
  },
};

/** Honest one-liners shown under the status label (the "what it means"). */
function statusLines(chain: VerifyResult): { cjk: string; en: string } {
  switch (chain.status) {
    case "VALID":
      return {
        cjk: `${fmtInt(chain.records)} 条链接经浏览器内 SHA-256 重算一致 — 防误改,非「正品」证明。`,
        en: `${fmtInt(chain.records)} links recomputed in-browser via SHA-256. Tamper-EVIDENT, not a clean bill of health.`,
      };
    case "EMPTY":
      return {
        cjk: "暂无证据记录 — 链为空。",
        en: "No evidence records yet — the chain is empty.",
      };
    case "TORN_TAIL":
      return {
        cjk: `末行残缺(无换行)— 崩溃残留,可恢复,非篡改。前 ${fmtInt(chain.records)} 条仍校验通过。`,
        en: `Trailing line torn (no newline) — a recoverable crash artifact, NOT tamper. The prior ${fmtInt(chain.records)} verified.`,
      };
    case "BREAK":
      return { cjk: SCOPE_BANNER.tamper.cjk, en: SCOPE_BANNER.tamper.en };
  }
}

export interface ChainStatusBannerProps {
  chain: VerifyResult;
}

export function ChainStatusBanner({ chain }: ChainStatusBannerProps) {
  const meta = CHAIN_STATUS_META[chain.status];
  const t = TONE_VARS[meta.tone];
  const isTamper = meta.tone === "tamper";
  const lines = statusLines(chain);

  return (
    <div
      className={isTamper ? "tamper-pulse" : undefined}
      style={{
        border: "1px solid",
        borderColor: t.border,
        background: t.bg,
        borderRadius: "var(--r)",
        padding: "9px 10px",
      }}
      role={isTamper ? "alert" : undefined}
    >
      {/* status headline */}
      <div className="flex items-center gap-2">
        <StatusDot tone={t.dot} pulse={isTamper} size={9} />
        <span aria-hidden style={{ color: t.color, fontSize: 13, lineHeight: 1 }}>
          ⛓
        </span>
        <span
          className="mono"
          style={{ color: t.color, fontWeight: 700, letterSpacing: "0.04em", fontSize: 13.5 }}
        >
          {meta.label}
        </span>
        <span style={{ color: t.color, opacity: 0.85, fontSize: 12.5 }}>{meta.cjk}</span>
        {chain.break_seq !== null && (
          <span
            className="mono"
            style={{ color: t.color, fontWeight: 700, marginLeft: "auto", fontSize: 12.5 }}
            title={`break detected at seq ${chain.break_seq}`}
          >
            @seq {chain.break_seq}
          </span>
        )}
      </div>

      {/* honest one-liner */}
      <div className="mt-1.5 flex flex-col" style={{ gap: 1 }}>
        <span
          style={{
            color: isTamper ? "var(--sev-critical)" : "var(--text)",
            fontSize: 12.5,
            fontWeight: isTamper ? 600 : 400,
            lineHeight: 1.45,
          }}
        >
          {lines.cjk}
        </span>
        <span className="micro" style={{ color: "var(--text-faint)", lineHeight: 1.4 }}>
          {lines.en}
        </span>
      </div>

      {/* the precise break/torn detail straight from verify (mono, exact) */}
      {(isTamper || chain.status === "TORN_TAIL") && chain.detail && (
        <div
          className="well mono micro mt-2"
          style={{
            color: isTamper ? "var(--sev-critical)" : "var(--sev-warn)",
            padding: "5px 7px",
            wordBreak: "break-word",
            borderColor: isTamper ? "var(--sev-tamper-border)" : "var(--sev-warn-border)",
          }}
        >
          {chain.detail}
        </div>
      )}

      {/* warnings (e.g. timestamp regression) — non-fatal, muted */}
      {chain.warnings.length > 0 && (
        <ul className="mt-1.5" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {chain.warnings.map((w, i) => (
            <li
              key={i}
              className="micro mono"
              style={{ color: "var(--text-faint)" }}
              title="non-fatal observation — a full rewriter can forge timestamps (PHASE0.md §4.1)"
            >
              ⚐ {w}
            </li>
          ))}
        </ul>
      )}

      {/* head hash — the verified frontier (genesis if none) */}
      {chain.status !== "EMPTY" && (
        <div className="mt-2 flex items-center gap-1.5" style={{ flexWrap: "wrap" }}>
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            verified head
          </span>
          <MonoHash value={chain.head_hash} head={10} tail={8} tone={isTamper ? "dim" : "ok"} />
        </div>
      )}
    </div>
  );
}
