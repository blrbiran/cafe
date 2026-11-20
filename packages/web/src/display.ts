import type { AgentRecord, DaemonRecord } from "@cafe/protocol";

/** User-added aliases only: names equal to the stable id / current label are legacy or redundant. */
export function explicitAliases(aliases: string[] | undefined, hide: Array<string | undefined>): string[] {
  const blocked = new Set(hide.filter(Boolean) as string[]);
  return (aliases ?? []).filter((a) => a && !blocked.has(a));
}

/** Most recently added explicit alias, then the display name, then the stable id. */
export function hostLabel(host: string, daemons: DaemonRecord[]): string {
  const d = daemons.find((x) => x.host === host);
  if (!d) return host;
  const aliases = explicitAliases(d.aliases, [d.host, d.displayName]);
  return aliases.at(-1) ?? d.displayName ?? d.host ?? host;
}

/** Alias-first for the Agent's own label; the stable Address is still used for routing and copying. */
export function agentLabel(a: AgentRecord, daemons: DaemonRecord[]): string {
  const aliases = explicitAliases(a.aliases, [a.name, a.host, a.displayName]);
  return aliases.at(-1) ?? a.displayName ?? a.name;
}

/** `name#n@<host label>`: the stable name/ordinal with the Host's current display label. */
export function agentAddress(a: AgentRecord, daemons: DaemonRecord[]): string {
  const at = a.address.indexOf("@");
  const namePart = at >= 0 ? a.address.slice(0, at) : a.name;
  return `${namePart}@${hostLabel(a.host, daemons)}`;
}

/** Aliases a person may remove (legacy names and the stable id are excluded). */
export function removableAgentAliases(a: AgentRecord): string[] {
  return explicitAliases(a.aliases, [a.name, a.host, a.displayName]);
}

export function removableHostAliases(d: DaemonRecord | undefined): string[] {
  return d ? explicitAliases(d.aliases, [d.host, d.displayName]) : [];
}
