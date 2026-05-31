/**
 * lib/cn.ts — tiny className joiner (no dependency). Filters falsy values and
 * joins with spaces. Use in every primitive so callers can pass conditional
 * classes and a `className` override.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
