/**
 * ProvenanceDetailView — renders a provenance verdict.detail
 * (analyzer/assay_analyzer/checks/provenance.py).
 *
 * Shows the claimed model + expected upstream, a score/max gauge, the native
 * fingerprint signals present (✓) / absent (·), any relay-stack tells, and (when
 * present) the anti-markers that prove the relay REBUILT the envelope.
 *
 * Honest framing is mandatory and always rendered:
 *   - PRESENCE = "consistent with genuine upstream"; markers are FORGEABLE, so
 *     NEVER "proven genuine".
 *   - ABSENCE = suspicion, not proof of fraud (CDN may strip headers).
 *   - says NOTHING about WHICH model served you (that is Phase 1).
 * skip (no signature library) → neutral "not applicable".
 */

import type { ProvenanceDetail, Status } from "@/lib/types";
import { GaugeBar } from "@/components/ui/GaugeBar";
import { Section, Row, Mono, HonestFrame, SignalList, TellChips, SkipNote } from "./shared";

const NOTE_FALLBACK =
  "presence = consistent with genuine upstream (markers are FORGEABLE, so never 'proven genuine'); absence = suspicion, not proof; says nothing about WHICH model served you (that is Phase 1).";

export function ProvenanceDetailView({
  detail,
  status,
}: {
  detail: ProvenanceDetail;
  status: Status;
}) {
  // skip path: a `reason` is set and there are no scored signals.
  const isSkip = status === "skip" || (detail.score === undefined && detail.reason !== undefined);

  const score = detail.score ?? 0;
  const maxScore = detail.max_score ?? 0;
  const antimarkers = (detail as { antimarkers?: string[] }).antimarkers ?? [];

  // Gauge tone tracks the verdict reading: ok = calm slate-teal, otherwise warn.
  // (provenance never escalates past warn — absence is suspicion, not proof.)
  const gaugeTone = status === "ok" ? "ok" : "warn";

  return (
    <Section title="上游来源 provenance · header / body fingerprint">
      <div className="flex flex-col">
        <Row label="claimed model" title="买家在请求里声明的模型(可信度低)">
          <Mono tone="dim">{detail.claimed_model ?? "—"}</Mono>
        </Row>
        <Row label="expected upstream" title="由声明模型推断的应到上游">
          <Mono tone="default">{detail.expected_upstream}</Mono>
        </Row>
      </div>

      {!isSkip && (
        <Section
          title="provenance score"
          aside={
            <span
              className="micro mono tnum"
              style={{ color: status === "ok" ? "var(--sev-ok)" : "var(--sev-warn)" }}
              title="native-fingerprint evidence strength — NOT a probability of authenticity"
            >
              {score}/{maxScore}
            </span>
          }
        >
          <GaugeBar
            value={score}
            max={maxScore || 1}
            tone={gaugeTone}
            height={7}
            ariaLabel={`provenance score ${score} of ${maxScore}`}
          />
          <span className="micro" style={{ color: "var(--text-ghost)" }}>
            分数 = 出现的原生标记权重和;markers forgeable —— 「与之一致」,绝非「已证明为真」。
          </span>
        </Section>
      )}

      {antimarkers.length > 0 && (
        <Section title="anti-markers · 套壳 / masquerade tells">
          <ul
            className="flex flex-col gap-1"
            style={{ fontSize: "var(--fs-data-sm)", color: "var(--sev-warn)" }}
          >
            {antimarkers.map((a, i) => (
              <li key={i} className="flex gap-1.5">
                <span aria-hidden style={{ flex: "none" }}>
                  ⚑
                </span>
                <span>{a}</span>
              </li>
            ))}
          </ul>
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            禁止字段证明中转站重建了响应外壳(比缺头部更强);仍不证明哪个模型服务了你 ——
            升级至 Phase 1。
          </span>
        </Section>
      )}

      {isSkip ? (
        <SkipNote reason={detail.reason} />
      ) : (
        <Section title="native fingerprint signals">
          <SignalList present={detail.signals_present} absent={detail.signals_absent} />
        </Section>
      )}

      <Section title="relay-stack tells" aside={<RelayCount n={detail.relay_stack_tells?.length ?? 0} />}>
        <TellChips tells={detail.relay_stack_tells} />
        <span className="micro" style={{ color: "var(--text-ghost)" }}>
          new-api / one-api 自报的转码标记 —— 确认中间商栈,有时泄露真实后端(usage_source)。
        </span>
      </Section>

      <HonestFrame>{detail.note ?? NOTE_FALLBACK}</HonestFrame>
    </Section>
  );
}

function RelayCount({ n }: { n: number }) {
  return (
    <span className="micro mono tnum" style={{ color: "var(--text-faint)" }}>
      {n}
    </span>
  );
}
