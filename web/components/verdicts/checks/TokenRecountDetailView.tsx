/**
 * TokenRecountDetailView — renders a token_recount verdict.detail
 * (analyzer/assay_analyzer/checks/token_recount.py).
 *
 * The heart of the check is a claimed-vs-recomputed comparison for prompt and
 * completion tokens. Two distinct flag semantics (faithful to the Python):
 *   CRITICAL — visible completion EXCEEDS billed (impossible if honest).
 *   WARN     — billed GREATLY exceeds visible on a non-reasoning/non-tool
 *              response (the core token-inflation fraud Phase 0 targets).
 * estimate_only (reasoning / tools / multimodal) caps at info and is rendered
 * as a neutral caveat — never an accusation. skip is neutral "not applicable".
 *
 * Always surfaces the load-bearing honest note: recompute is against YOUR
 * request, so prompt-padding the relay adds UPSTREAM is invisible here.
 */

import type { TokenRecountDetail } from "@/lib/types";
import { fmtTokens, fmtPct } from "@/lib/format";
import { Section, Row, Mono, HonestFrame, SkipNote, Delta } from "./shared";

const NOTE_FALLBACK =
  "recompute is a close estimate, not a byte-exact oracle; prompt-side padding the relay adds UPSTREAM is invisible here";

/** One comparison line: claimed vs recomputed with a delta. */
function CompareRow({
  label,
  claimed,
  recomputed,
  delta,
  deltaPct,
  positiveIsBad,
  emphasis,
  note,
}: {
  label: string;
  claimed: number | null | undefined;
  recomputed: number | null | undefined;
  delta?: number;
  deltaPct?: number | null;
  /** for completion: visible>billed (positive delta) is the BAD/critical case. */
  positiveIsBad?: boolean;
  /** tint the whole row to flag the load-bearing comparison. */
  emphasis?: "critical" | "warn" | null;
  note?: string;
}) {
  const borderColor =
    emphasis === "critical"
      ? "var(--sev-critical-border)"
      : emphasis === "warn"
        ? "var(--sev-warn-border)"
        : "var(--line-soft)";
  const bg =
    emphasis === "critical"
      ? "var(--sev-critical-bg)"
      : emphasis === "warn"
        ? "var(--sev-warn-bg)"
        : "transparent";
  return (
    <div
      className="flex flex-col gap-1 px-2 py-1.5"
      style={{
        border: `1px solid ${borderColor}`,
        background: bg,
        borderRadius: "var(--r)",
      }}
    >
      <div className="flex items-baseline gap-3">
        <span className="text-faint" style={{ fontSize: "var(--fs-data-sm)" }}>
          {label}
        </span>
        <span className="ml-auto flex items-baseline gap-3">
          <span className="flex flex-col items-end leading-tight">
            <Mono tone="dim">{fmtTokens(claimed)}</Mono>
            <span className="micro" style={{ color: "var(--text-ghost)" }}>
              claimed
            </span>
          </span>
          <span style={{ color: "var(--text-ghost)" }}>·</span>
          <span className="flex flex-col items-end leading-tight">
            <Mono tone="accent">{fmtTokens(recomputed)}</Mono>
            <span className="micro" style={{ color: "var(--text-ghost)" }}>
              recomputed
            </span>
          </span>
        </span>
      </div>
      {delta !== undefined && (
        <div className="flex items-baseline gap-2">
          <span className="micro" style={{ color: "var(--text-ghost)" }}>
            Δ recomputed−claimed
          </span>
          <span className="ml-auto">
            <Delta value={delta} pct={deltaPct} positiveIsBad={positiveIsBad} />
          </span>
        </div>
      )}
      {note && (
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          {note}
        </span>
      )}
    </div>
  );
}

export function TokenRecountDetailView({ detail }: { detail: TokenRecountDetail }) {
  // skip path: {reason, provider, api_surface} (no `eligible`).
  if (detail.eligible !== true) {
    return (
      <Section title="用量重算 token_recount">
        <SkipNote
          reason={detail.reason}
          extra={
            <div className="flex items-center gap-2">
              <span className="micro" style={{ color: "var(--text-faint)" }}>
                {String(detail.provider)} / {String(detail.api_surface)}
              </span>
            </div>
          }
        />
        <HonestFrame>
          Claude / Gemini / 未知模型一律 skip:没有公开分词器可独立重算。
          这<strong> 不是失败 </strong>—— 只对真·OpenAI chat 强。
        </HonestFrame>
      </Section>
    );
  }

  const claimed = detail.claimed ?? { prompt: null, completion: null };
  const recomputed = detail.recomputed ?? { prompt: null, completion: null };

  // Determine which comparison is the load-bearing flag.
  const cDelta = detail.completion_delta; // recomputed - claimed
  const isCritical = cDelta !== undefined && cDelta > 0; // visible exceeds billed
  const isWarn =
    detail.billed_exceeds_visible_pct !== undefined && (cDelta === undefined || cDelta <= 0);

  return (
    <Section title="用量重算 token_recount · claimed vs recomputed">
      {detail.estimate_only && (
        <div
          className="flex items-start gap-2 px-2.5 py-1.5"
          style={{
            background: "var(--sev-info-bg)",
            border: "1px solid var(--sev-info-border)",
            borderRadius: "var(--r)",
            fontSize: "var(--fs-data-sm)",
            color: "var(--sev-info)",
          }}
        >
          <span aria-hidden style={{ flex: "none" }}>
            ≈
          </span>
          <span>
            <strong>estimate-only</strong> — 上限为 info,不会升级为指控
            {detail.estimate_reasons && detail.estimate_reasons.length > 0 ? (
              <>
                {" ("}
                {detail.estimate_reasons.join(", ")}
                {")"}
              </>
            ) : null}
            。推理 / 工具 / 多模态会计入隐藏 token,可解释 recomputed &lt; claimed。
          </span>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <CompareRow
          label="completion 输出"
          claimed={claimed.completion}
          recomputed={recomputed.completion}
          delta={cDelta}
          deltaPct={detail.completion_delta_pct}
          positiveIsBad
          emphasis={isCritical ? "critical" : isWarn ? "warn" : null}
          note={
            isCritical
              ? "visible 重算 > billed:诚实情况下物理不可能(抓包误差或少计费)"
              : isWarn
                ? `billed ≫ visible:可见文本仅占 ${fmtPct(
                    detail.billed_exceeds_visible_pct !== undefined
                      ? 100 - detail.billed_exceeds_visible_pct
                      : null,
                  )},疑似充值膨胀`
                : undefined
          }
        />
        <CompareRow
          label="prompt 输入"
          claimed={claimed.prompt}
          recomputed={recomputed.prompt}
          delta={detail.prompt_delta}
          deltaPct={detail.prompt_delta_pct}
          note="仅作观测,不据此 flag(framing 常数较噪)"
        />
      </div>

      {detail.observations && detail.observations.length > 0 && (
        <Section title="observations">
          <ul className="flex flex-col gap-1" style={{ fontSize: "var(--fs-data-sm)" }}>
            {detail.observations.map((o, i) => (
              <li key={i} className="flex gap-1.5" style={{ color: "var(--text-dim)" }}>
                <span aria-hidden style={{ color: "var(--text-ghost)", flex: "none" }}>
                  ·
                </span>
                <span>{o}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="flex flex-col">
        {detail.encoding && (
          <Row label="encoding">
            <Mono tone="dim">{detail.encoding}</Mono>
          </Row>
        )}
        {detail.framing && (
          <Row label="framing" title="Chat Completions framing constants (PHASE0 §6.1)">
            <Mono tone="faint">
              +{detail.framing.tokens_per_message}/msg · +{detail.framing.reply_priming} priming
            </Mono>
          </Row>
        )}
        {(detail.tolerance_pct !== undefined || detail.min_abs_tokens !== undefined) && (
          <Row label="tolerance">
            <Mono tone="faint">
              {detail.tolerance_pct !== undefined ? `${detail.tolerance_pct}%` : "—"}
              {detail.min_abs_tokens !== undefined ? ` · ≥${detail.min_abs_tokens} abs` : ""}
            </Mono>
          </Row>
        )}
      </div>

      <HonestFrame>{detail.note ?? NOTE_FALLBACK}</HonestFrame>
    </Section>
  );
}
