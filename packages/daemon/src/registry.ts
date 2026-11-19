import { EventEmitter } from "node:events";
import type { AgentRecord, RegistryDelta } from "@cafe/protocol";
import { parseAddress } from "@cafe/protocol";

/**
 * The Registry of all Agents. The Root owns the authoritative copy and bumps
 * `version` on every change; other Daemons hold a replica (ADR-0002).
 */
export class Registry extends EventEmitter<{ delta: [RegistryDelta] }> {
  version = 0;
  private agents = new Map<string, AgentRecord>();

  all(): AgentRecord[] {
    return [...this.agents.values()];
  }

  get(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  /** Authoritative mutation (Root, or local-only Daemon while the Root is down). */
  upsert(records: AgentRecord[]): RegistryDelta {
    for (const r of records) this.agents.set(r.agentId, r);
    return this.bump({ version: 0, upsert: records, remove: [] });
  }

  remove(agentIds: string[]): RegistryDelta {
    const removed = agentIds.filter((id) => this.agents.delete(id));
    return this.bump({ version: 0, upsert: [], remove: removed });
  }

  /** Replica update from the Root. Returns false if a gap was detected (caller should resync). */
  applyDelta(delta: RegistryDelta): boolean {
    if (delta.version <= this.version) return true;
    if (delta.version !== this.version + 1) return false;
    for (const r of delta.upsert) this.agents.set(r.agentId, r);
    for (const id of delta.remove) this.agents.delete(id);
    this.version = delta.version;
    this.emit("delta", delta);
    return true;
  }

  applySnapshot(version: number, records: AgentRecord[]): void {
    const before = new Set(this.agents.keys());
    this.agents = new Map(records.map((r) => [r.agentId, r]));
    this.version = version;
    const remove = [...before].filter((id) => !this.agents.has(id));
    this.emit("delta", { version, upsert: records, remove });
  }

  /** Next free instance number for `name` on `host`. */
  nextInstance(name: string, host: string): number {
    const used = new Set(
      this.all()
        .filter((r) => r.name === name && r.host === host)
        .map((r) => parseAddress(r.address)?.n ?? 0),
    );
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  /** Resolve an Address (`name#n@host`, `name@host`, or bare `name`) to Agent ids. */
  resolve(address: string): string[] {
    const a = parseAddress(address);
    if (!a) return this.agents.has(address) ? [address] : [];
    const named = (r: AgentRecord) => r.name === a.name || r.displayName === a.name || r.aliases.includes(a.name);
    return this.all()
      .filter((r) => named(r) && (a.host === undefined || r.host === a.host))
      .filter((r) => a.n === undefined || parseAddress(r.address)?.n === a.n)
      .map((r) => r.agentId);
  }

  private bump(delta: RegistryDelta): RegistryDelta {
    this.version += 1;
    const d = { ...delta, version: this.version };
    this.emit("delta", d);
    return d;
  }
}
