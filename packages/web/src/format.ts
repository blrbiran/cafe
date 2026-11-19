import { useSyncExternalStore } from "react";

let now = Date.now();
const listeners = new Map<number, Set<() => void>>();
const timers = new Map<number, ReturnType<typeof setInterval>>();

/**
 * A "now" that re-renders at `intervalMs`. List cards use a coarse interval
 * (relative times do not need 1 s precision); only live durations use 1 s.
 */
export function useNow(intervalMs = 1_000): number {
  return useSyncExternalStore(
    (l) => {
      let set = listeners.get(intervalMs);
      if (!set) {
        set = new Set();
        listeners.set(intervalMs, set);
        timers.set(
          intervalMs,
          setInterval(() => {
            now = Date.now();
            for (const f of set!) f();
          }, intervalMs),
        );
      }
      set.add(l);
      return () => {
        set!.delete(l);
        if (set!.size === 0) {
          clearInterval(timers.get(intervalMs));
          timers.delete(intervalMs);
          listeners.delete(intervalMs);
        }
      };
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
