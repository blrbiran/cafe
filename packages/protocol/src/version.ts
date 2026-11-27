// Dependency-free constants, so the web UI can import them without pulling in zod.
export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 4777;

/**
 * Feature flags a Daemon advertises (v4-11 §7 named the idea; v4-12 adds the wire fields and the
 * mixed-release behaviour). An old peer omits the list; absent means none.
 */
export const FEATURES = ["teams", "channels", "escalate", "collect", "digests", "team-sessions", "team-child-view", "human-clarifications", "host-auth-v1", "caller-auth-v1", "team-roster-ack-v1"] as const;
export type Feature = (typeof FEATURES)[number];
export const CURRENT_FEATURES: readonly Feature[] = FEATURES;

/** Features in `need` that `have` lacks (undefined/absent = none). */
export function missingFeatures(have: readonly string[] | undefined, need: readonly string[]): string[] {
  const set = new Set(have ?? []);
  return need.filter((f) => !set.has(f));
}

/** Distinct cafe versions among online Daemons; more than one means the network runs mixed releases. */
export function onlineVersions(daemons: { online: boolean; version?: string }[]): string[] {
  return [...new Set(daemons.filter((d) => d.online).map((d) => d.version ?? "?"))].sort();
}
