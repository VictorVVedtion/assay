/**
 * Dashboard page — the single-page forensic console.
 *
 * Boots the data layer (useSnapshot for the initial paint + useAuditStream for
 * the live SSE feed) and composes the feature panels in the DESIGN grid:
 *
 *   StatRow (full width)
 *   ┌────────────────────────────┬───────────────────┐
 *   │ LiveStreamPanel (large)     │ ChecksPanel (5)   │
 *   │                            ├───────────────────┤
 *   │                            │ ChainPanel        │
 *   ├──────────────┬─────────────┼───────────────────┤
 *   │ MetricsPanel │ FlagsFeed    │ Demo/Live + Onboard│
 *   └──────────────┴─────────────┴───────────────────┘
 *   + EvidenceDrawer (global, right-side, opens on a row / chain-block click)
 *
 * IMPORTANT: the panel imports below are the FROZEN seam for the feature agents.
 * They will NOT resolve until those agents create the files — that is EXPECTED.
 * This foundation deliberately does NOT create them and does NOT run the build.
 */

"use client";

import { useSnapshot, useAuditStream } from "@/lib/hooks";

import { StatRow } from "@/components/overview/StatRow";
import { LiveStreamPanel } from "@/components/stream/LiveStreamPanel";
import { ChecksPanel } from "@/components/verdicts/ChecksPanel";
import { MetricsPanel } from "@/components/metrics/MetricsPanel";
import { ChainPanel } from "@/components/chain/ChainPanel";
import { FlagsFeed } from "@/components/verdicts/FlagsFeed";
import { OnboardingCard } from "@/components/overview/OnboardingCard";
import { DemoLiveExplainer } from "@/components/overview/DemoLiveExplainer";
import { EvidenceDrawer } from "@/components/stream/EvidenceDrawer";

export default function ConsolePage() {
  // initial paint + live tail (both keyed to the active source / demo break)
  useSnapshot();
  useAuditStream();

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-[1680px] p-3 flex flex-col gap-3">
        {/* live counters across the top */}
        <StatRow />

        {/* primary grid: stream + verdict cards + chain */}
        <div className="grid gap-3 grid-cols-1 xl:grid-cols-12">
          {/* left: the live evidence stream (large) */}
          <div className="xl:col-span-8 min-w-0 flex flex-col gap-3">
            <LiveStreamPanel />
            {/* metrics + flags side by side under the stream */}
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 min-w-0">
              <MetricsPanel />
              <FlagsFeed />
            </div>
          </div>

          {/* right rail: the five checks, chain viz, onboarding */}
          <div className="xl:col-span-4 min-w-0 flex flex-col gap-3">
            <ChecksPanel />
            <ChainPanel />
            <DemoLiveExplainer />
            <OnboardingCard />
          </div>
        </div>
      </div>

      {/* app-wide drawer: opens on evidence row or chain block click */}
      <EvidenceDrawer />
    </div>
  );
}
