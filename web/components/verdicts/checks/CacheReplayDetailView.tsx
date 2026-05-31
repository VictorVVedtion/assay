/**
 * CacheReplayDetailView — renders a cache_replay verdict.detail
 * (analyzer/assay_analyzer/checks/cache_replay.py).
 *
 * Shows the response fingerprint (short mono), the distinct-request count for
 * that fingerprint, normalized length, temperature, and seed presence. The flag
 * fires only when one long response is served for ≥2 DISTINCT requests AND
 * determinism cannot excuse it (temperature≠0 and no seed).
 *
 * Honest framing: a WEAK heuristic. Same prompt → same output (esp. temp=0 / a
 * fixed seed) is NORMAL and not flagged; that case downgrades to skip. skip
 * (incomplete / too short / unparseable) → neutral "not applicable".
 */

import type { CacheReplayDetail, Status } from "@/lib/types";
import { MonoHash } from "@/components/ui/MonoHash";
import { fmtInt } from "@/lib/format";
import { Section, Row, Mono, HonestFrame, SkipNote } from "./shared";

const NOTE_FALLBACK =
  "exact-replay tripwire only; paraphrase/regeneration evades (out of Phase 0 scope)";

export function CacheReplayDetailView({
  detail,
  status,
}: {
  detail: CacheReplayDetail;
  status: Status;
}) {
  // skip path: only a `reason` (+ maybe normalized_len) is present.
  if (status === "skip" || detail.resp_fingerprint === undefined) {
    return (
      <Section title="缓存重放 cache_replay">
        <SkipNote
          reason={detail.reason}
          extra={
            detail.normalized_len !== undefined ? (
              <span className="micro mono tnum" style={{ color: "var(--text-faint)" }}>
                normalized_len = {fmtInt(detail.normalized_len)}
              </span>
            ) : undefined
          }
        />
        <HonestFrame>
          弱启发式:同 prompt → 同输出(尤其 temp=0 或固定 seed)属正常,不报。
        </HonestFrame>
      </Section>
    );
  }

  const count = detail.distinct_request_count ?? 0;
  const collision = count >= 2;
  const deterministic = detail.temperature === 0 || detail.has_seed === true;

  return (
    <Section title="缓存重放 cache_replay · response fingerprint">
      <div className="flex flex-col">
        <Row label="resp fingerprint" title="sha256 of the NFKC-normalized assistant text">
          <MonoHash
            value={detail.resp_fingerprint}
            head={10}
            tail={8}
            tone={collision && !deterministic ? "critical" : "dim"}
            prefix="sha256"
          />
        </Row>
        <Row
          label="distinct requests"
          title="number of semantically DIFFERENT requests that produced this exact response"
        >
          <Mono tone={collision && !deterministic ? "warn" : "dim"}>
            {fmtInt(count)}
            {collision ? (
              <span style={{ color: "var(--text-faint)" }}> — collision</span>
            ) : (
              <span style={{ color: "var(--text-ghost)" }}> — unique</span>
            )}
          </Mono>
        </Row>
        <Row label="normalized len">
          <Mono tone="dim">{fmtInt(detail.normalized_len)}</Mono>
        </Row>
        <Row label="temperature" title="temperature=0 ⇒ determinism expected ⇒ not flagged">
          <Mono tone={detail.temperature === 0 ? "ok" : "dim"}>
            {detail.temperature === null || detail.temperature === undefined
              ? "—"
              : detail.temperature}
          </Mono>
        </Row>
        <Row label="seed">
          <Mono tone={detail.has_seed ? "ok" : "faint"}>
            {detail.has_seed ? "fixed (determinism expected)" : "none"}
          </Mono>
        </Row>
        {detail.first_seen_record_id && (
          <Row label="first seen" title="record id where this response fingerprint first appeared">
            <MonoHash value={detail.first_seen_record_id} head={10} tail={6} tone="dim" />
          </Row>
        )}
      </div>

      {collision && deterministic && (
        <HonestFrame icon="≡">
          相同输出 + temperature=0 / 固定 seed —— 确定性可解释,<strong> 不算欺诈</strong>。
        </HonestFrame>
      )}

      <HonestFrame>{detail.note ?? NOTE_FALLBACK}</HonestFrame>
    </Section>
  );
}
