import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Peer } from "@cafe/protocol/peer";
import { TeamSpec } from "@cafe/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, waitFor } from "./helpers.ts";
import { enrollTestChild } from "./tls-helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const spec = (duty: string) => TeamSpec.parse({
  name: "shop",
  channel: "shop",
  members: [
    { name: "lead", duty: "orchestrator", dir: "." },
    { name: "builder", duty, dir: "." },
  ],
});

const rosterHash = (roster: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(roster)).digest("hex");

describe("Child durable roster publication state", () => {
  it("persists pending requests, rebases known Root state after reconnect, and blocks unknown Root edits", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-roster-cas-child-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-roster-cas-child-host-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const rootOpts = { home: rootHome, mode: "root" as const, testTeamRosterAckFeature: true, config: { security: { mode: "tls" as const, tls: { port: 0 } } } };
    let root = await startDaemon("cas-child-root", rootOpts);
    cleanup.push(() => root.stop());
    const enrollment = await enrollTestChild(root, root.daemon.hostId, childHome, "cas-child-host");
    const childOpts = {
      home: childHome,
      config: { root: `127.0.0.1:${root.server.tlsPort}`, security: { mode: "tls", tls: { port: 0, caFingerprint: enrollment.caFingerprint, rootHostId: enrollment.rootHostId } } },
    };
    let child = await startDaemon("cas-child-host", childOpts);
    cleanup.push(() => child.stop());
    await waitFor(() => child.daemon.rootOnline && child.daemon.rootFeatureList().includes("team-roster-ack-v1"), 10_000);

    child.daemon.publishRoster(childHome, spec("builder"));
    await waitFor(() => root.daemon.teams().some((team) => team.host === "cas-child-host" && team.team === "shop"), 10_000);
    const state = () => child.daemon.store.getKv<Record<string, any>>("teamRosterCas") ?? {};
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log("child-cas-state", Object.values(state()));
    await waitFor(() => Object.values(state()).some((entry) => entry.status === "acknowledged" && entry.acknowledged?.revision === 1), 10_000);
    const first = Object.values(state())[0]!;
    const rosterRootId = first.rosterRootId as string;
    expect(rosterRootId).toBeTruthy();
    expect(first.pending).toBeUndefined();

    const rootPort = root.server.tlsPort;
    await root.stop();
    await waitFor(() => !child.daemon.rootOnline, 5_000);
    child.daemon.publishRoster(childHome, spec("designer"));
    await waitFor(() => Object.values(state()).some((entry) => entry.status === "publish_pending" && entry.pending), 5_000);
    const pending = Object.values(state()).find((entry) => entry.rosterRootId === rosterRootId)!.pending;
    expect(pending).toMatchObject({ baseRevision: 1, revision: 2 });

    root = await startDaemon("cas-child-root", { ...rootOpts, config: { security: { mode: "tls", tls: { port: rootPort } } } });
    await waitFor(() => child.daemon.rootOnline, 10_000);
    await waitFor(() => root.daemon.teams().some((team) => team.host === "cas-child-host" && team.team === "shop" && team.members.some((member) => member.name === "builder" && member.duty === "designer")), 10_000);
    await waitFor(() => Object.values(state()).some((entry) => entry.rosterRootId === rosterRootId && entry.status === "acknowledged" && entry.acknowledged?.revision === 2 && !entry.pending), 10_000);

    const uplink = (child.daemon as unknown as { uplink: Peer }).uplink;
    const concurrentRoster = { ...root.daemon.teams().find((team) => team.host === "cas-child-host")!, rosterRootId, revision: 3 };
    const concurrentHash = "c".repeat(64);
    concurrentRoster.contentHash = concurrentHash;
    await uplink.request("team/rosterAck", {
      rosterRootId,
      baseRevision: 2,
      baseContentHash: Object.values(state()).find((entry) => entry.rosterRootId === rosterRootId)!.acknowledged.contentHash,
      revision: 3,
      contentHash: concurrentHash,
      roster: concurrentRoster,
      tombstones: [],
    });
    child.daemon.publishRoster(childHome, spec("reviewer"));
    await waitFor(() => Object.values(state()).some((entry) => entry.rosterRootId === rosterRootId && entry.status === "revision_conflict"), 10_000);
    expect(root.daemon.teams().find((team) => team.host === "cas-child-host")?.members.find((member) => member.name === "builder")?.duty).toBe("designer");
  }, 40_000);
});
