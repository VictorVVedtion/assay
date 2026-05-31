/**
 * ThroughputDetailView — renders a throughput verdict.detail
 * (analyzer/assay_analyzer/checks/throughput.py).
 *
 * tokens/s, generation time (gen_us → seconds), TTFT, stream chunks, and the
 * physical ceiling. Labeled TELEMETRY ONLY: tok/s measured THROUGH the proxy
 * reflects the RELAY's pacing (it can buffer and re-emit), not the model's
 * decode speed — so this check NEVER produces a critical verdict; it flags only
 * the physically impossible (faster than any real hardware), and even then warn.
 * skip (non-stream / low resolution / no completion count) → neutral.
 */

import type { ThroughputDetail, Status } from "@/lib/types";
import { GaugeBar } from "@/components/ui/GaugeBar";
import { fmtMicros, fmtTps, fmtInt } from "@/lib/format";
import { Section, Row, Mono, HonestFrame, SkipNote } from "./shared";

const NOTE_FALLBACK = "measures relay pacing, not model speed; informational only";

export function ThroughputDetailView({
  detail,
  status,
}: {
  detail: ThroughputDetail;
  status: Status;
}) {
  // skip path: only a `reason` (+ maybe ttft_us/total_us) is present.
  if (status === "skip" || detail.tokens_per_s === undefined) {
    return (
      <Section title="吞吐遥测 throughput">
        <SkipNote
          reason={detail.reason}
          extra={
            detail.ttft_us !== undefined || detail.total_us !== undefined ? (
              <span className="micro mono tnum" style={{ color: "var(--text-faint)" }}>
                ttft {fmtMicros(detail.ttft_us)} · total {fmtMicros(detail.total_us)}
              </span>
            ) : undefined
          }
        />
        <HonestFrame>
          非流式 / 时间分辨率不足 / 无 completion 计数 → skip。tok/s 只对流式有意义。
        </HonestFrame>
      </Section>
    );
  }

  const tps = detail.tokens_per_s ?? 0;
  const ceiling = detail.ceiling_tps ?? 0;
  const overCeiling = ceiling > 0 && tps > ceiling;

  return (
    <Section title="吞吐遥测 throughput · telemetry only">
      <div
        className="flex items-baseline gap-2 px-2.5 py-1.5"
        style={{
          background: "var(--sev-info-bg)",
          border: "1px solid var(--sev-info-border)",
          borderRadius: "var(--r)",
        }}
      >
        <span className="mono tnum" style={{ fontSize: "var(--fs-stat)", color: overCeiling ? "var(--sev-warn)" : "var(--sev-info)", lineHeight: 1 }}>
          {fmtInt(Math.round(tps))}
        </span>
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          tok/s
        </span>
        <span
          className="ml-auto chip mono"
          style={{
            color: "var(--sev-info)",
            background: "transparent",
            borderColor: "var(--sev-info-border)",
          }}
          title="this check is telemetry; not a fraud signal unless physically impossible"
        >
          遥测 / TELEMETRY
        </span>
      </div>

      {ceiling > 0 && (
        <Section
          title="vs physical ceiling"
          aside={
            <span className="micro mono tnum" style={{ color: "var(--text-faint)" }}>
              {fmtInt(Math.round(tps))}/{fmtInt(Math.round(ceiling))}
            </span>
          }
        >
          <GaugeBar
            value={Math.min(tps, ceiling)}
            max={ceiling}
            tone={overCeiling ? "warn" : "info"}
            height={7}
            ariaLabel={`${Math.round(tps)} tokens/s of ${Math.round(ceiling)} ceiling`}
          />
          {overCeiling && (
            <span className="micro" style={{ color: "var(--sev-warn)" }}>
              超过物理上限 —— 缓冲 / 重放投递的提示(非证明)。
            </span>
          )}
        </Section>
      )}

      <div className="flex flex-col">
        <Row label="completion used">
          <Mono tone="dim">{fmtInt(detail.completion_tokens_used)} tok</Mono>
        </Row>
        <Row label="gen time" title="total − ttft (the decode window)">
          <Mono tone="dim">{fmtMicros(detail.gen_us)}</Mono>
        </Row>
        <Row label="ttft">
          <Mono tone="dim">{fmtMicros(detail.ttft_us)}</Mono>
        </Row>
        <Row label="tok/s">
          <Mono tone={overCeiling ? "warn" : "dim"}>{fmtTps(tps)}</Mono>
        </Row>
        {detail.stream_chunks !== undefined && (
          <Row label="stream chunks">
            <Mono tone="faint">{fmtInt(detail.stream_chunks)}</Mono>
          </Row>
        )}
      </div>

      <HonestFrame>{detail.note ?? NOTE_FALLBACK}</HonestFrame>
    </Section>
  );
}
