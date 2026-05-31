/**
 * lib/format.ts — pure display formatters for machine data, shared by every
 * panel so units render consistently (mono + tabular). No deps, no I/O.
 *
 * Timing is stored in integer MICROSECONDS (PHASE0.md §4). These helpers turn
 * raw fields into compact human strings without lying about precision.
 */

/** microseconds → compact human duration ("412 ms", "1.9 s", "84 µs"). */
export function fmtMicros(us: number | null | undefined): string {
  if (us === null || us === undefined) return "—";
  if (us < 1000) return `${us} µs`;
  const ms = us / 1000;
  if (ms < 1000) return `${ms >= 100 ? Math.round(ms) : ms.toFixed(1)} ms`;
  const s = ms / 1000;
  return `${s.toFixed(s >= 10 ? 1 : 2)} s`;
}

/** raw microseconds value for a mono tooltip ("412300 µs"). */
export function fmtMicrosExact(us: number | null | undefined): string {
  return us === null || us === undefined ? "—" : `${us} µs`;
}

/** byte count → compact ("1.2 KiB", "5.0 MiB", "962 B"). Binary units. */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** integer with thousands separators (tabular-friendly). */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

/** a token count, or "—" when absent. */
export function fmtTokens(n: number | null | undefined): string {
  return fmtInt(n);
}

/** percentage with one decimal ("96.3%"). */
export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(digits)}%`;
}

/** tokens/sec compact. */
export function fmtTps(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${Math.round(n).toLocaleString("en-US")} tok/s`;
}

/** ISO timestamp → "HH:MM:SS" local (the dense table form). */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

/** ISO timestamp → "HH:MM:SS.mmm" with milliseconds (drawer / precise view). */
export function fmtClockMs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const base = d.toLocaleTimeString("en-GB", { hour12: false });
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${base}.${ms}`;
}

/** ISO → relative ("3s ago", "2m ago", "just now"). */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 2) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Short path label (drops a long query string for the table). */
export function fmtPath(path: string): string {
  const q = path.indexOf("?");
  return q >= 0 ? path.slice(0, q) : path;
}
