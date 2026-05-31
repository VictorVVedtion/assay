/**
 * Root layout. Renders the always-present shell — <TopBar/> then <ScopeBanner/>
 * — above every page (the ScopeBanner LEADS the whole UI and is NEVER
 * removable, per the honest-boundary rules). Fonts are pure CSS stacks defined
 * in globals.css (no webfont fetch — the dashboard makes ZERO external calls,
 * honoring the project's local-only / self-host ethos).
 */

import type { Metadata } from "next";
import "./globals.css";
import { TopBar } from "@/components/shell/TopBar";
import { ScopeBanner } from "@/components/shell/ScopeBanner";

export const metadata: Metadata = {
  title: "assay · 照妖镜 — Live Audit Console",
  description:
    "Local-only forensic console for the assay audit proxy. Reads append-only evidence + verdicts on this machine; no network. Phase 0: token honesty + naive cache + exposure lower-bound + upstream provenance.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh" className="h-full">
      <body className="min-h-full flex flex-col">
        <TopBar />
        <ScopeBanner />
        <main className="flex-1 min-h-0">{children}</main>
      </body>
    </html>
  );
}
