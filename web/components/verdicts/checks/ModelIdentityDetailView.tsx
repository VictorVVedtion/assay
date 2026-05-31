/**
 * ModelIdentityDetailView — render a model_identity (MMD two-sample) verdict,
 * faithful to analyzer/assay_analyzer/checks/model_identity.py.
 *
 * Honest-boundary (never softened, mirrors the verdict's own note):
 *   - a flag = "output distribution DIFFERS from the reference at p<α", NOT
 *     fraud (benign quantization / finetune / serving variation are
 *     indistinguishable). Severity caps at warn upstream — this view never
 *     renders a red "fraud" state.
 *   - active-probe only: a relay serving genuine-to-probes evades it.
 *   - the reference is TRUSTED, not verified (poisoned-root limit).
 *
 * skip is NORMAL and the common case: no genuine reference (run `assay
 * calibrate`), mismatched probe params, or insufficient shared samples.
 */

import type { ModelIdentityDetail, Status } from "@/lib/types";
import { Section, Row, Mono, HonestFrame, SkipNote } from "./shared";

const SKIP_REASON: Record<string, string> = {
  no_reference: "无可信参考 — 运行 `assay calibrate`(官方直连)或导入社区指纹后才能比对",
  param_mismatch: "探针参数与参考不一致(prompt 池 / 采样)— 用同一池重新校准,不比较不可比的分布",
};

export function ModelIdentityDetailView({
  detail,
  status,
}: {
  detail: ModelIdentityDetail;
  status: Status;
}) {
  const perRef = detail.per_reference ?? {};
  const refEntries = Object.entries(perRef);
  const isSkip =
    status === "skip" || !!detail.reason || detail.all_insufficient || refEntries.length === 0;

  if (isSkip) {
    const reason =
      (detail.reason && SKIP_REASON[detail.reason]) ||
      (detail.all_insufficient
        ? "共享证据不足(可比的探针/参考样本太少)— 用参考的 prompt 池重新探测"
        : detail.reason) ||
      "未进行比对";
    return (
      <SkipNote
        reason={reason}
        extra={
          <>
            {detail.mismatches && detail.mismatches.length > 0 && (
              <ul
                className="flex flex-col gap-0.5"
                style={{ fontSize: "var(--fs-micro)", color: "var(--text-faint)" }}
              >
                {detail.mismatches.map((m, i) => (
                  <li key={i} className="mono">
                    · {m}
                  </li>
                ))}
              </ul>
            )}
            {detail.note && <HonestFrame>{detail.note}</HonestFrame>}
          </>
        }
      />
    );
  }

  const alpha = detail.alpha;
  const rejectedAll = !!detail.rejected_all;

  return (
    <div className="flex flex-col gap-2.5">
      <Section title="MMD distribution test">
        <Row label="claimed model">
          <Mono tone="dim">{detail.model ?? "—"}</Mono>
        </Row>
        <Row label="alpha (α)">
          <Mono>{alpha ?? "—"}</Mono>
        </Row>
        <Row label="permutations">
          <Mono>{detail.permutations ?? "—"}</Mono>
        </Row>
        <Row label="usable refs">
          <Mono>
            {detail.usable_references ?? refEntries.filter(([, r]) => !r.insufficient).length}
          </Mono>
        </Row>
        <Row
          label="verdict"
          title="composite null: 'differs' only if it rejects vs EVERY usable reference (eq. 11)"
        >
          {rejectedAll ? (
            <Mono tone="warn">differs from ALL refs (p&lt;α)</Mono>
          ) : detail.rejected_any ? (
            <Mono tone="ok">partial — composite-null gray zone (not flagged)</Mono>
          ) : (
            <Mono tone="ok">consistent with reference</Mono>
          )}
        </Row>
      </Section>

      {refEntries.length > 0 && (
        <Section title="per reference · p-value / MMD²">
          <div className="flex flex-col">
            {refEntries.map(([label, r]) => {
              const reject = r.pvalue !== null && alpha !== undefined && r.pvalue < alpha;
              return (
                <Row
                  key={label}
                  label={<Mono tone="faint">{label}</Mono>}
                  title={`${r.n_probe} probe vs ${r.n_ref} ref samples · ${r.shared_prompts} shared prompts · L=${r.length}`}
                >
                  {r.insufficient ? (
                    <Mono tone="dim">insufficient</Mono>
                  ) : (
                    <span className="inline-flex items-baseline gap-2">
                      <Mono tone={reject ? "warn" : "ok"}>p={r.pvalue}</Mono>
                      <Mono tone="faint">mmd²={r.mmd2}</Mono>
                    </span>
                  )}
                </Row>
              );
            })}
          </div>
        </Section>
      )}

      {detail.note && <HonestFrame>{detail.note}</HonestFrame>}
    </div>
  );
}

export default ModelIdentityDetailView;
