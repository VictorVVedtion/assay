/**
 * DigestRecompute — the project's "anyone can recompute" guarantee, realized IN
 * THE BROWSER (KILLER FEATURE A).
 *
 * Given the selected EvidenceRecord, this calls the foundation's ported §4
 * canonical encoding (lib/digest canon → Web Crypto SHA-256) RIGHT HERE on the
 * client and shows:
 *
 *   1. the recomputed sha256(canon(record)) vs the stored `hash`        (integrity)
 *   2. whether this record's `prev_hash` matches the previous record's   (linkage)
 *      stored hash — i.e. the chain link holds at this point
 *
 * No server, no trust: the buyer can read this code, copy the bytes (MonoHash is
 * click-to-copy), and reproduce the same hash with `sha256sum` over the canon
 * preimage. The component states this explicitly — you believe the recompute,
 * not our conclusion.
 *
 * Honest framing: a matching hash proves the record is INTERNALLY INTACT and the
 * link to its predecessor holds — it says NOTHING about whether the relay told
 * the truth inside the record (that is what the verdicts are for). We label that.
 *
 * Client component (Web Crypto + async state).
 */

"use client";

import { useEffect, useState } from "react";
import type { EvidenceRecord } from "@/lib/types";
import { GENESIS_PREV_HASH } from "@/lib/types";
import { canonHex, computeHash } from "@/lib/digest";
import { MonoHash } from "@/components/ui/MonoHash";
import { useRecords } from "@/lib/hooks";
import { cn } from "@/lib/cn";

export interface DigestRecomputeProps {
  record: EvidenceRecord;
  className?: string;
}

type Check = "pending" | "pass" | "fail";

interface RecomputeResult {
  /** the record id this result was computed for (drives the "pending" gate). */
  forId: string;
  /** the hash we recomputed in-browser. */
  computed: string;
  /** sha256(canon) == stored hash. */
  hashOk: boolean;
  /** prev_hash links to the previous record's stored hash (or genesis at seq 0). */
  linkOk: boolean;
  /** the previous record's hash we compared prev_hash against (if known). */
  expectedPrev: string | null;
  /** whether the previous record is present in the loaded window. */
  prevKnown: boolean;
  /** byte length of the canon preimage (the thing that was hashed). */
  canonBytes: number;
  error: string | null;
}

export function DigestRecompute({ record, className }: DigestRecomputeProps) {
  const records = useRecords();
  const [result, setResult] = useState<RecomputeResult | null>(null);
  // the canon preimage hex, revealed (and computed) on demand — it can be large.
  const [preimage, setPreimage] = useState<string | null>(null);

  const isGenesis = record.seq === 0 || record.prev_hash === GENESIS_PREV_HASH;
  // Find the immediate predecessor by seq (records are sorted asc).
  const prev = records.find((r) => r.seq === record.seq - 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const computed = await computeHash(record);
        const hashOk = computed === record.hash;

        // linkage: genesis links to all-zeros; otherwise to prev record's hash.
        const expectedPrev = isGenesis ? GENESIS_PREV_HASH : (prev?.hash ?? null);
        const prevKnown = isGenesis || prev !== undefined;
        const linkOk = expectedPrev !== null && record.prev_hash === expectedPrev;

        if (cancelled) return;
        setResult({
          forId: record.id,
          computed,
          hashOk,
          linkOk,
          expectedPrev,
          prevKnown,
          canonBytes: canonHex(record).length / 2,
          error: null,
        });
      } catch (e) {
        if (cancelled) return;
        setResult({
          forId: record.id,
          computed: "",
          hashOk: false,
          linkOk: false,
          expectedPrev: null,
          prevKnown: false,
          canonBytes: 0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [record, isGenesis, prev]);

  // Derive a render-time view: treat a stale/absent result as "pending" without
  // writing state in an effect (React 19: no setState reset on prop change).
  const fresh = result && result.forId === record.id ? result : null;
  const state = {
    status: (fresh ? (fresh.error ? "fail" : fresh.hashOk && (fresh.prevKnown ? fresh.linkOk : true) ? "pass" : "fail") : "pending") as Check,
    computed: fresh?.computed ?? "",
    hashOk: fresh?.hashOk ?? false,
    linkOk: fresh?.linkOk ?? false,
    expectedPrev: fresh?.expectedPrev ?? null,
    prevKnown: fresh?.prevKnown ?? false,
    canonBytes: fresh?.canonBytes ?? 0,
    error: fresh?.error ?? null,
  };
  const showPreimage = preimage !== null;

  const revealPreimage = () => {
    if (preimage === null) {
      try {
        setPreimage(canonHex(record));
      } catch {
        setPreimage("");
      }
    } else {
      setPreimage(null);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {/* the ethos line — what the buyer is actually trusting */}
      <p className="micro" style={{ color: "var(--text-faint)", lineHeight: 1.5 }}>
        你信的不是结论，而是任何人都能复算 · you don&apos;t trust the verdict, you trust the
        recompute. sha256(canon(record)) is recomputed in YOUR browser via Web
        Crypto (lib/digest, ported byte-exact from the Go data plane).
      </p>

      {/* integrity: recomputed vs stored */}
      <CheckRow
        status={state.status === "pending" ? "pending" : state.hashOk ? "pass" : "fail"}
        label="sha256(canon) == hash"
        cjk="本地复算 == 存储哈希"
      >
        <div className="flex flex-col gap-1 min-w-0">
          <KV k="recomputed" >
            <MonoHash
              value={state.computed || "…"}
              tone={state.hashOk ? "ok" : state.status === "fail" ? "critical" : "dim"}
              prefix="sha256"
            />
          </KV>
          <KV k="stored.hash">
            <MonoHash
              value={record.hash}
              tone={state.hashOk ? "ok" : "default"}
            />
          </KV>
        </div>
      </CheckRow>

      {/* linkage: prev_hash → previous record's hash */}
      <CheckRow
        status={
          state.status === "pending"
            ? "pending"
            : isGenesis
              ? state.linkOk
                ? "pass"
                : "fail"
              : !state.prevKnown
                ? "pending"
                : state.linkOk
                  ? "pass"
                  : "fail"
        }
        label={isGenesis ? "prev_hash == genesis (seq 0)" : "prev_hash == prev.hash"}
        cjk={isGenesis ? "创世链接 (seq 0)" : "上一条链接"}
      >
        <div className="flex flex-col gap-1 min-w-0">
          <KV k="this.prev_hash">
            <MonoHash
              value={record.prev_hash}
              tone={state.linkOk ? "ok" : state.prevKnown ? "critical" : "dim"}
            />
          </KV>
          <KV k={isGenesis ? "genesis (64×0)" : prev ? `seq ${prev.seq}.hash` : "prev.hash"}>
            {state.expectedPrev ? (
              <MonoHash value={state.expectedPrev} tone={state.linkOk ? "ok" : "default"} />
            ) : (
              <span className="mono data-sm" style={{ color: "var(--text-faint)" }}>
                上一条不在当前窗口 · prev record not in loaded window
              </span>
            )}
          </KV>
        </div>
      </CheckRow>

      {/* the preimage affordance — show the exact bytes that were hashed */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <button
          type="button"
          onClick={revealPreimage}
          className="link micro"
          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
          title="reveal the canonical byte preimage (length-prefixed typed encoding) — sha256sum this to reproduce the hash yourself"
        >
          {showPreimage ? "▾ hide" : "▸ show"} canon preimage
          {state.canonBytes > 0 ? ` (${state.canonBytes} B)` : ""}
        </button>
        <span className="micro" style={{ color: "var(--text-ghost)" }}>
          domain assay-evidence-v1
        </span>
      </div>
      {showPreimage && preimage && (
        <div className="well p-2" style={{ maxHeight: 160, overflow: "auto" }}>
          <code
            className="mono data-sm"
            style={{ color: "var(--text-dim)", wordBreak: "break-all", lineHeight: 1.5 }}
          >
            {preimage}
          </code>
        </div>
      )}

      {/* honest caveat: integrity ≠ honesty */}
      <p className="micro" style={{ color: "var(--text-faint)", lineHeight: 1.5 }}>
        {state.error ? (
          <span style={{ color: "var(--sev-critical)" }}>recompute error: {state.error}</span>
        ) : (
          <>
            链完整 ≠ 内容为真 — a matching hash proves this record is intact and its
            link holds; it does NOT vouch for what the relay <em>claimed</em> inside
            it. That is what the checks below are for.
          </>
        )}
      </p>
    </div>
  );
}

/* ---- small presentational helpers ---- */

function CheckRow({
  status,
  label,
  cjk,
  children,
}: {
  status: Check | "pending";
  label: string;
  cjk: string;
  children: React.ReactNode;
}) {
  const mark = status === "pass" ? "✓" : status === "fail" ? "✗" : "…";
  const color =
    status === "pass"
      ? "var(--sev-ok)"
      : status === "fail"
        ? "var(--sev-critical)"
        : "var(--text-faint)";
  const border =
    status === "pass"
      ? "var(--sev-ok-border)"
      : status === "fail"
        ? "var(--sev-critical-border)"
        : "var(--line)";
  return (
    <div
      className="well p-2 flex gap-2"
      style={{ borderColor: border }}
    >
      <span
        className="mono"
        aria-hidden
        style={{ color, fontSize: 13, lineHeight: 1.4, width: 14, textAlign: "center", flex: "none" }}
      >
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="mono data-sm" style={{ color }}>
            {label}
          </span>
          <span className="micro" style={{ color: "var(--text-faint)" }}>
            {cjk}
          </span>
        </div>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span
        className="micro mono"
        style={{ color: "var(--text-faint)", width: 110, flex: "none", textAlign: "right" }}
      >
        {k}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
