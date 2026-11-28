import { afterEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "@cafe/protocol/peer";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, waitFor } from "./helpers.ts";
import { enrollTestChild } from "./tls-helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const hash1 = "a".repeat(64);
const hash2 = "b".repeat(64);
const record = (host: string, rosterRootId: string, revision: number, contentHash: string) => ({
  team: "shop",
  host,
  channel: "shop",
  members: [{ name: "lead", duty: "orchestrator", description: "", tags: [], scope: [], mode: "headless" as const, dir: "." }],
  revision,
  authoritative: true,
  contentHash,
  rosterRootId,
});

describe("durable Root roster compare-and-swap", () => {
  it("keeps the roster acknowledgment capability reserved for rollout", async () => {
    const root = await startDaemon("cas-cap-root", { mode: "root" });
    cleanup.push(root.stop);
    expect(root.daemon.features()).not.toContain("team-roster-ack-v1");
  });

  it("authenticates the Host, acknowledges exact retries, conflicts on stale base/hash, and survives restart", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-roster-cas-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-roster-cas-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const rootOpts = { home: rootHome, mode: "root" as const, rosterAckFixture: true, config: { security: { mode: "tls" as const, tls: { port: 0 } } } };
    let root = await startDaemon("cas-root", rootOpts);
    cleanup.push(() => root.stop());
    const enrollment = await enrollTestChild(root, root.daemon.hostId, childHome, "cas-child");
    const child = await startDaemon("cas-child", {
      home: childHome,
      config: { root: `127.0.0.1:${root.server.tlsPort}`, security: { mode: "tls", tls: { port: 0, caFingerprint: enrollment.caFingerprint, rootHostId: enrollment.rootHostId } } },
    });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 10_000);
    const uplink = () => (child.daemon as unknown as { uplink: Peer }).uplink;
    const base = record("cas-child", "roster-root-stable-1", 1, hash1);
    const request = { rosterRootId: base.rosterRootId, baseRevision: 0, baseContentHash: null, revision: 1, contentHash: hash1, roster: base, tombstones: [] };

    const persist = vi.spyOn(root.daemon as any, "persistTeams").mockImplementation(() => { throw new Error("disk full"); });
    await expect(uplink().request("team/rosterAck", request)).rejects.toThrow("disk full");
    persist.mockRestore();
    expect(root.daemon.teams().some((team) => team.rosterRootId === base.rosterRootId)).toBe(false);

    const ack = await uplink().request("team/rosterAck", request);
    expect(ack).toEqual({ status: "ack", rosterRootId: base.rosterRootId, revision: 1, contentHash: hash1 });
    expect(await uplink().request("team/rosterAck", request)).toEqual(ack);
    const nonIdenticalReplay = await uplink().request("team/rosterAck", { ...request, roster: { ...base, members: [{ ...base.members[0]!, name: "impostor" }] } });
    expect(nonIdenticalReplay).toMatchObject({ status: "conflict", revision: 1, contentHash: hash1 });

    const staleBase = await uplink().request("team/rosterAck", { ...request, baseRevision: 0, revision: 2, contentHash: hash2, roster: record("cas-child", base.rosterRootId, 2, hash2) });
    expect(staleBase).toMatchObject({ status: "conflict", revision: 1, contentHash: hash1 });
    const staleHash = await uplink().request("team/rosterAck", { ...request, baseRevision: 1, baseContentHash: hash2, revision: 2, contentHash: hash2, roster: record("cas-child", base.rosterRootId, 2, hash2) });
    expect(staleHash).toMatchObject({ status: "conflict", revision: 1, contentHash: hash1 });

    const renamedRoster = { ...record("cas-child", base.rosterRootId, 2, hash2), team: "shop-renamed", channel: "shop-renamed" };
    const renamedRequest = { rosterRootId: base.rosterRootId, baseRevision: 1, baseContentHash: hash1, revision: 2, contentHash: hash2, roster: renamedRoster, tombstones: [] };
    const renameAck = await uplink().request("team/rosterAck", renamedRequest);
    expect(renameAck).toEqual({ status: "ack", rosterRootId: base.rosterRootId, revision: 2, contentHash: hash2 });
    const renamedRecords = JSON.parse(readFileSync(join(rootHome, "teams.json"), "utf8")) as Array<{ host: string; team: string; removed?: boolean; rosterRootId?: string }>;
    expect(renamedRecords).toContainEqual(expect.objectContaining({ host: "cas-child", team: "shop", removed: true, rosterRootId: base.rosterRootId }));
    expect(root.daemon.teams()).toContainEqual(expect.objectContaining({ host: "cas-child", team: "shop-renamed", rosterRootId: base.rosterRootId }));

    await expect(uplink().request("team/rosterAck", { ...request, roster: record("other-host", base.rosterRootId, 1, hash1) })).rejects.toMatchObject({ code: "bad_identity" });

    const persisted = JSON.parse(readFileSync(join(rootHome, "teams.json"), "utf8")) as Array<{ rosterRootId?: string; host: string; revision?: number; contentHash?: string }>;
    expect(persisted).toContainEqual(expect.objectContaining({ rosterRootId: base.rosterRootId, host: "cas-child", team: "shop-renamed", revision: 2, contentHash: hash2 }));

    const originalUplink = uplink();
    await root.stop();
    root = await startDaemon("cas-root", { ...rootOpts, config: { security: { mode: "tls", tls: { port: root.server.tlsPort } } } });
    await waitFor(() => child.daemon.rootOnline && uplink() !== originalUplink && !uplink().isClosed, 10_000);
    const afterRestart = await uplink().request("team/rosterAck", renamedRequest);
    expect(afterRestart).toEqual(renameAck);
    expect(root.daemon.teams()).toContainEqual(expect.objectContaining({ host: "cas-child", team: "shop-renamed", revision: 2, contentHash: hash2 }));
  }, 30_000);
});
