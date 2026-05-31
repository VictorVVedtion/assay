/**
 * ProviderChip — provider identity chip (openai=green, anthropic=warm clay,
 * gemini=blue, unknown=gray). The provider is classified by REQUEST PATH, not
 * the model string (classify.go) — so this chip reflects the API surface the
 * SDK chose, which is harder for a relay to misattribute than the model field.
 */

import type { ApiSurface, Provider } from "@/lib/types";
import { PROVIDER_META } from "@/lib/constants";
import { cn } from "@/lib/cn";

export interface ProviderChipProps {
  provider: Provider;
  /** optionally append the api_surface (e.g. "openai · chat.completions"). */
  apiSurface?: ApiSurface;
  className?: string;
}

export function ProviderChip({ provider, apiSurface, className }: ProviderChipProps) {
  const meta = PROVIDER_META[provider] ?? PROVIDER_META.unknown;
  return (
    <span
      className={cn("chip mono", className)}
      style={{
        color: `var(${meta.colorVar})`,
        background: `var(${meta.bgVar})`,
        borderColor: `var(${meta.colorVar})`,
      }}
      title={`provider classified by request path${apiSurface ? ` · ${apiSurface}` : ""}`}
    >
      {meta.label}
      {apiSurface ? (
        <span className="micro" style={{ opacity: 0.7 }}>
          · {apiSurface}
        </span>
      ) : null}
    </span>
  );
}
