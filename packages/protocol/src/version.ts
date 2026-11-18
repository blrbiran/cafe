// Dependency-free constants, so the web UI can import them without pulling in zod.
export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 4777;

/** Distinct cafe versions among online Daemons; more than one means the network runs mixed releases. */
export function onlineVersions(daemons: { online: boolean; version?: string }[]): string[] {
  return [...new Set(daemons.filter((d) => d.online).map((d) => d.version ?? "?"))].sort();
}
