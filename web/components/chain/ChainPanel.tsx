/**
 * ChainPanel — the evidence hash-chain viewer; the trust-minimized centerpiece
 * (the "spine" of the console).
 *
 * It renders the append-only evidence chain as a vertical sequence of linked
 * blocks — one per EvidenceRecord — each showing its seq + short hash and a
 * prev_hash → previous.hash link glyph, conveying continuity. The overall
 * verification status (VALID / EMPTY / TORN_TAIL / BREAK@seq) reads prominently
 * at the head; a BREAK flips the panel into the loud TAMPER state
 * ("证据被篡改 — 裁决不可信"), with the broken link marked at the exact seq.
 *
 * Clicking any block selects that record in the store → opens the EvidenceDrawer,
 * where the buyer recomputes sha256(canon(record)) IN THE BROWSER and checks it
 * == the stored hash + prev_hash linkage. This panel relies on the foundation
 * /api/verify status (surfaced via the store's chainStatus); it does NOT
 * recompute the whole chain client-side (that is the drawer's per-record job).
 *
 * Layout note: it lives in the narrow right rail, so the spine is vertical and
 * dense, with a capped scroll region; long chains elide their verified middle.
 *
 * Client component.
 */

"use client";

import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChainStatusBanner } from "./ChainStatusBanner";
import { ChainSpine } from "./ChainSpine";
import { BreakToggle } from "./BreakToggle";
import {
  useChainStatus,
  useRecords,
  useSelect,
  useSelectedRecordId,
  useHydrated,
} from "@/lib/hooks";
import { CHAIN_STATUS_META } from "@/lib/constants";

export function ChainPanel() {
  const records = useRecords();
  const chain = useChainStatus();
  const selectedId = useSelectedRecordId();
  const select = useSelect();
  const hydrated = useHydrated();

  const meta = CHAIN_STATUS_META[chain.status];
  const isTamper = meta.tone === "tamper";
  const hasRecords = records.length > 0;

  return (
    <Panel
      eyebrow="Evidence chain · 证据链"
      title="哈希链 / Hash chain"
      actions={
        <div className="flex items-center gap-2">
          <BreakToggle />
          <StatusPillInline status={meta.label} cjk={meta.cjk} tone={meta.tone} pulse={isTamper} />
        </div>
      }
      bodyClassName="p-3 flex flex-col gap-3 min-h-0"
    >
      {/* prominent status (TAMPER reads loudest here) */}
      <ChainStatusBanner chain={chain} />

      {/* the spine */}
      {hasRecords ? (
        <div
          className="min-h-0 overflow-auto pr-0.5"
          style={{ maxHeight: 420 }}
          aria-label="evidence chain spine"
        >
          <ChainSpine
            records={records}
            chain={chain}
            selectedId={selectedId}
            onSelect={select}
          />
        </div>
      ) : (
        <EmptyState
          compact
          glyph={<span aria-hidden>⛓</span>}
          title={hydrated ? "链为空 · chain empty" : "校验中… · verifying…"}
          hint={
            hydrated
              ? "暂无证据记录。代理捕获后,每条都会成链并可在浏览器内重算。"
              : "正在读取并重算证据链 (recomputing the chain in-browser)。"
          }
        />
      )}

      {/* honest footnote: what the chain proves — and what it does NOT */}
      <ChainHonestFootnote />
    </Panel>
  );
}

/** Mirrors the TopBar chain pill, scoped to this panel's header. */
function StatusPillInline({
  status,
  cjk,
  tone,
  pulse,
}: {
  status: string;
  cjk: string;
  tone: "ok" | "info" | "warn" | "tamper";
  pulse?: boolean;
}) {
  const map: Record<string, { color: string; bg: string; border: string }> = {
    ok: { color: "var(--sev-ok)", bg: "var(--sev-ok-bg)", border: "var(--sev-ok-border)" },
    info: { color: "var(--sev-info)", bg: "var(--sev-info-bg)", border: "var(--sev-info-border)" },
    warn: { color: "var(--sev-warn)", bg: "var(--sev-warn-bg)", border: "var(--sev-warn-border)" },
    tamper: {
      color: "var(--sev-tamper)",
      bg: "var(--sev-tamper-bg)",
      border: "var(--sev-tamper-border)",
    },
  };
  const c = map[tone];
  return (
    <span
      className={pulse ? "pill tamper-pulse" : "pill"}
      style={{ color: c.color, background: c.bg, borderColor: c.border }}
      title={`evidence chain: ${status} (${cjk})`}
    >
      <span className="mono">{status}</span>
    </span>
  );
}

/** The non-negotiable honest limit of a LOCAL hash chain: it is tamper-EVIDENT,
 *  not tamper-PROOF (a holder with write access can rewrite the whole file);
 *  only external anchoring raises that bar (PHASE0.md §4.1 / §0.10). Paired with
 *  the empowering half: anyone can recompute every hash here, no server trust. */
function ChainHonestFootnote() {
  return (
    <p
      className="micro"
      style={{
        color: "var(--text-faint)",
        lineHeight: 1.5,
        borderTop: "1px solid var(--line-soft)",
        paddingTop: 8,
        margin: 0,
      }}
    >
      <span style={{ color: "var(--text-dim)" }}>防误改,非防篡改 / tamper-EVIDENT, not tamper-PROOF.</span>{" "}
      本地链可被有写权者整体重算 → 非 dispute 级铁证;dispute 级需外部锚定(Ed25519 / TSA,Phase 1)。
      凭据在于<span style={{ color: "var(--accent)" }}> 任何人都能独立重算每条 hash</span> —
      点开任一区块,浏览器内 SHA-256 现算即验,零服务器信任。
    </p>
  );
}

export default ChainPanel;
