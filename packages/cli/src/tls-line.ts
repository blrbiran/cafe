/** A refused plaintext link as `/api/health.tls.refused` reports it (#89, #93). */
export interface Refusal {
  host: string;
  kind?: string;
  at: number;
  version?: string;
  /** Still trying (a doctor failure); older daemons omit it, which counts as still trying. */
  recent?: boolean;
}

/**
 * One line about transport security for `cafe status` / `cafe daemon status` (v4-6 §10.3). It names
 * refused plaintext links the way `cafe doctor` does, so the two never disagree (#93).
 */
export function tlsLine(t: { mode?: string; port?: number; network?: boolean; waiting?: string; refused?: Refusal[] } | undefined, now = Date.now()): string {
  if (!t) return "unknown (older daemon)";
  if (t.mode !== "tls") return "off (security.mode: plaintext)";
  if (!t.network) return `on :${t.port ?? "?"}, NOT on the network yet — not connecting to the hub: ${t.waiting ?? "enrolling"}`;
  const base = `on :${t.port ?? "?"} (daemon links use wss)`;
  const refused = t.refused ?? [];
  const trying = refused.filter((r) => r.recent !== false);
  const stopped = refused.filter((r) => r.recent === false);
  const ago = (at: number) => `${Math.max(1, Math.round((now - at) / 60_000))}m ago`;
  const parts: string[] = [];
  if (trying.length) parts.push(`refusing plaintext links from ${trying.map((r) => r.host).join(", ")} — see cafe doctor`);
  if (stopped.length) parts.push(`refused ${stopped.map((r) => `${r.host} ${ago(r.at)}`).join(", ")} (not tried since)`);
  return parts.length ? `${base}; ${parts.join("; ")}` : base;
}
