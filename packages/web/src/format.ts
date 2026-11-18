import { useSyncExternalStore } from "react";

let now = Date.now();
const ticks = new Set<() => void>();
setInterval(() => {
  now = Date.now();
  for (const t of ticks) t();
}, 5_000);

/** A "now" that re-renders every 5s, for relative times. */
export function useNow(): number {
  return useSyncExternalStore(
    (l) => {
      ticks.add(l);
      return () => ticks.delete(l);
    },
    () => now,
  );
}

export function relTime(at: number | undefined, nowMs: number): string {
  if (!at) return "—";
  const s = Math.round((nowMs - at) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

export function clock(at: number | undefined): string {
  if (!at) return "—";
  const d = new Date(at);
  return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export function stamp(at: number | undefined): string {
  if (!at) return "—";
  return new Date(at).toLocaleString([], { hour12: false });
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
