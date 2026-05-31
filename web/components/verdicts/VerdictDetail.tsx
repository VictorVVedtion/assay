/**
 * VerdictDetail — the per-check detail dispatcher (the cross-feature seam).
 *
 * components/stream/EvidenceDrawer.tsx renders one of these per verdict attached
 * to the selected record (it draws the check label + StatusPill header itself,
 * so this component renders only the BODY of the detail). It narrows the open
 * VerdictRecord union with isCheck() and hands the typed `detail` (+ `status`
 * where the view needs the skip/run distinction) to the matching per-check view.
 *
 * Honest-boundary (rule #2): an `ok` verdict never reads "verified / safe /
 * genuine". When a check returns ok, we append the quiet, load-bearing reminder
 * that ok means only "no flag within Phase 0's scope" — NOT a positive
 * authenticity claim. The per-check views render their own honest frames; this
 * adds the global one on the ok path.
 *
 * model_identity (Phase 1, active-probe MMD) renders via its own view; any other
 * forward-compatible check falls through to a calm raw view.
 */

import type { VerdictRecord } from "@/lib/types";
import { isCheck } from "@/lib/types";

import { TokenRecountDetailView } from "./checks/TokenRecountDetailView";
import { ProvenanceDetailView } from "./checks/ProvenanceDetailView";
import { ExposureDetailView } from "./checks/ExposureDetailView";
import { CacheReplayDetailView } from "./checks/CacheReplayDetailView";
import { ThroughputDetailView } from "./checks/ThroughputDetailView";
import { ModelIdentityDetailView } from "./checks/ModelIdentityDetailView";
import { HonestFrame } from "./checks/shared";

export function VerdictDetail({ verdict }: { verdict: VerdictRecord }) {
  return (
    <div className="flex flex-col gap-2">
      <CheckBody verdict={verdict} />
      {/* Global honest frame for an ok reading — ok ≠ "正品 / 安全". The
          per-check views carry their own caveats; this guards the ok path
          across every check (honest-boundary rule #2). */}
      {verdict.status === "ok" && (
        <HonestFrame icon="✓">
          ok = Phase 0 范围内未发现 flag —— 并非「正品 / 安全」断言。
          ok within Phase 0&apos;s scope, NOT a genuineness or safety claim.
        </HonestFrame>
      )}
    </div>
  );
}

/** Narrow the union to the concrete check and render its typed detail view. */
function CheckBody({ verdict }: { verdict: VerdictRecord }) {
  if (isCheck(verdict, "token_recount")) {
    return <TokenRecountDetailView detail={verdict.detail} />;
  }
  if (isCheck(verdict, "provenance")) {
    return <ProvenanceDetailView detail={verdict.detail} status={verdict.status} />;
  }
  if (isCheck(verdict, "exposure")) {
    return <ExposureDetailView detail={verdict.detail} />;
  }
  if (isCheck(verdict, "cache_replay")) {
    return <CacheReplayDetailView detail={verdict.detail} status={verdict.status} />;
  }
  if (isCheck(verdict, "throughput")) {
    return <ThroughputDetailView detail={verdict.detail} status={verdict.status} />;
  }
  if (isCheck(verdict, "model_identity")) {
    return <ModelIdentityDetailView detail={verdict.detail} status={verdict.status} />;
  }
  // any forward-compatible check: a calm fallback that shows the summary only.
  return <FallbackDetail verdict={verdict} />;
}

function FallbackDetail({ verdict }: { verdict: VerdictRecord }) {
  return (
    <div className="flex flex-col gap-1" style={{ fontSize: "var(--fs-data-sm)" }}>
      <span style={{ color: "var(--text-dim)" }}>{verdict.summary}</span>
      <HonestFrame>
        {`no dedicated renderer for "${verdict.check}" — showing summary only.`}
      </HonestFrame>
    </div>
  );
}

export default VerdictDetail;
