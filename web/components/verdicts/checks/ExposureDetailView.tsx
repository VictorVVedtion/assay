/**
 * ExposureDetailView — renders an exposure verdict.detail
 * (analyzer/assay_analyzer/checks/exposure.py).
 *
 * Two columns: REQUEST (what you sent) vs RESPONSE (which the relay also sees /
 * can echo). Each shows secrets{type:count}, pii{type:count}, high-entropy blobs
 * and code blocks. secrets are the loud signal (warn-tinted); pii/code are calm
 * info counts.
 *
 * Honest framing is mandatory and always present:
 *   - LOWER BOUND ("下界 / at least N"); 0 detected ≠ safe.
 *   - MEASURED, not PREVENTED — assay cannot stop the relay reading plaintext
 *     (the MITM reality). This is NOT a risk score.
 *   - truncated capture floors the lower bound further (true exposure is higher).
 * detector versions are shown for reproducibility.
 */

import type { ExposureDetail, ExposureScan } from "@/lib/types";
import { cn } from "@/lib/cn";
import { Section, HonestFrame, KVChips } from "./shared";

const NOTE_FALLBACK =
  "LOWER BOUND of what egressed to the relay -- 'at least', never 'safe'. assay does NOT prevent the relay reading this; it measures so you can ship less. Zero detected != zero present.";

function ScanColumn({
  title,
  cjk,
  scan,
}: {
  title: string;
  cjk: string;
  scan: ExposureScan | undefined;
}) {
  const s = scan ?? { secrets: {}, pii: {}, high_entropy_blobs: 0, code_blocks: 0 };
  const secretTotal = Object.values(s.secrets ?? {}).reduce((a, b) => a + b, 0);
  const hasSecrets = secretTotal > 0;
  return (
    <div
      className="flex flex-col gap-2 p-2.5 min-w-0"
      style={{
        background: hasSecrets ? "var(--sev-warn-bg)" : "var(--panel-3)",
        border: `1px solid ${hasSecrets ? "var(--sev-warn-border)" : "var(--line)"}`,
        borderRadius: "var(--r)",
      }}
    >
      <div className="flex items-baseline gap-2">
        <span className="eyebrow" style={{ color: hasSecrets ? "var(--sev-warn)" : undefined }}>
          {title}
        </span>
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          {cjk}
        </span>
      </div>
      <ExposureLine label="secrets" tone={hasSecrets ? "warn" : "neutral"} map={s.secrets} />
      <ExposureLine label="pii" tone="neutral" map={s.pii} />
      <div className="flex items-baseline gap-3 pt-0.5">
        <span className="text-faint" style={{ fontSize: "var(--fs-data-sm)", minWidth: 78 }}>
          entropy blobs
        </span>
        <span className="ml-auto mono data-sm tnum" style={{ color: "var(--text-dim)" }}>
          {s.high_entropy_blobs ?? 0}
        </span>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-faint" style={{ fontSize: "var(--fs-data-sm)", minWidth: 78 }}>
          code blocks
        </span>
        <span className="ml-auto mono data-sm tnum" style={{ color: "var(--text-dim)" }}>
          {s.code_blocks ?? 0}
        </span>
      </div>
    </div>
  );
}

function ExposureLine({
  label,
  tone,
  map,
}: {
  label: string;
  tone: "warn" | "neutral";
  map: Record<string, number> | undefined;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-faint" style={{ fontSize: "var(--fs-data-sm)", minWidth: 78 }}>
        {label}
      </span>
      <span className="ml-auto text-right">
        <KVChips map={map} tone={tone} emptyLabel="0 detected" />
      </span>
    </div>
  );
}

export function ExposureDetailView({ detail }: { detail: ExposureDetail }) {
  const detectors = Object.entries(detail.detector_versions ?? {});
  return (
    <Section title="数据泄露下界 exposure · request + response">
      {/* The lower-bound banner LEADS — exposure is measured, never prevented. */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5"
        style={{
          background: "var(--panel-3)",
          border: "1px dashed var(--line-strong)",
          borderRadius: "var(--r)",
        }}
      >
        <span
          className="chip mono"
          style={{
            color: "var(--text-dim)",
            background: "var(--inset)",
            borderColor: "var(--line-strong)",
          }}
          title="at least N — a floor, not a total"
        >
          ≥ 下界 LOWER BOUND
        </span>
        <span className="micro" style={{ color: "var(--text-faint)" }}>
          已测量 · 未阻止 / measured, NOT prevented — 检测到 0 ≠ 安全
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 min-w-0">
        <ScanColumn title="REQUEST" cjk="你发送的" scan={detail.request} />
        <ScanColumn title="RESPONSE" cjk="中转站也可读" scan={detail.response} />
      </div>

      {detail.truncated_capture && (
        <div
          className="flex items-start gap-2 px-2.5 py-1.5"
          style={{
            background: "var(--sev-warn-bg)",
            border: "1px solid var(--sev-warn-border)",
            borderRadius: "var(--r)",
            fontSize: "var(--fs-data-sm)",
            color: "var(--sev-warn)",
          }}
        >
          <span aria-hidden style={{ flex: "none" }}>
            ✂
          </span>
          <span>
            capture TRUNCATED at proxy cap — 截断点之后的内容既未存储也未计数,真实泄露
            <strong> 高于 </strong>此下界。
          </span>
        </div>
      )}

      {detectors.length > 0 && (
        <Section title="detector versions" aside={<ReproChip />}>
          <div className="flex flex-wrap gap-1">
            {detectors.map(([k, ver]) => (
              <span
                key={k}
                className={cn("chip mono")}
                style={{
                  color: "var(--text-faint)",
                  background: "var(--panel-3)",
                  borderColor: "var(--line)",
                }}
                title={`${k}: ${ver}`}
              >
                {k}
                <span style={{ color: "var(--text-ghost)" }}>={ver}</span>
              </span>
            ))}
          </div>
        </Section>
      )}

      <HonestFrame>{detail.note ?? NOTE_FALLBACK}</HonestFrame>
    </Section>
  );
}

function ReproChip() {
  return (
    <span
      className="micro"
      style={{ color: "var(--text-ghost)" }}
      title="recorded so any box can reproduce the same lower bound"
    >
      reproducible
    </span>
  );
}
