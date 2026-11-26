import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CafeClient } from "@cafe/protocol/client";
import { readCafeFile } from "@cafe/protocol/cafe-file";
import { FAST, barista, identity, startDaemon, waitFor } from "./helpers.ts";

// v4-11 review: a roster read from an authoritative `.cafe` must replace membership (removing a
// member has to take effect), a forgotten Host must not keep its teams, and a roster must not be
// resurrected by a stale revision.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const roster = (members: string[]) =>
  ["name: repo", "team:", "  channel: repo-dev", "  members:", "    - name: orch", "      duty: orchestrator", "      dir: ."]
    .concat(members.flatMap((name) => [`    - name: ${name}`, "      dir: ."]))
    .join("\n") + "\n";

const member = (name: string, teamDir: string) =>
  identity(name, { team: "repo", teamChannel: "repo-dev", member: name, teamDir, channels: ["repo-dev"] });

describe("team roster updates", () => {
  it("drops a member removed from the authoritative .cafe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cafe-roster-"));
    writeFileSync(join(dir, ".cafe"), roster(["dev1", "dev2"]));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const d = await startDaemon("ros1", { mode: "root" });
    cleanup.push(d.stop);

    const stale = mkdtempSync(join(tmpdir(), "cafe-roster-copy-"));
    writeFileSync(join(stale, ".cafe"), roster(["dev1"]));
    cleanup.push(() => rmSync(stale, { recursive: true, force: true }));
    const publish = (path: string) => d.daemon.publishRoster(path, readCafeFile(join(path, ".cafe")).team!);
    publish(dir);
    const before = d.daemon.teams()[0]!.revision;

    const c = new CafeClient({ daemon: d.addr });
    cleanup.push(() => c.close());
    await c.connect(member("dev1", stale));
    expect(d.daemon.teams()[0]!.roster.map((m) => m.name)).toEqual(["orch", "dev1", "dev2"]);
    expect(d.daemon.teams()[0]!.revision).toBe(before);
    expect(() => publish(stale)).toThrow(/roster directory/i);

    writeFileSync(join(dir, ".cafe"), roster(["dev1"]));
    publish(dir);
    expect(d.daemon.teams()[0]!.roster.map((m) => m.name)).toEqual(["orch", "dev1"]);
    expect(d.daemon.teams()[0]!.revision).toBeGreaterThan(before!);
  });

  it("removes a forgotten Host's teams from memory and teams.json", async () => {
    const root = await startDaemon("hubR", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pcR", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 5000);

    const dev = await barista(child.addr, identity("dev1", { team: "repo", teamChannel: "repo-dev", member: "dev1", channels: ["repo-dev"] }));
    cleanup.push(() => dev.client.close());
    await waitFor(() => root.daemon.teams().some((t) => t.host === "pcR" && t.team === "repo"), 5000);

    await child.stop();
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pcR" && !d.online), 5000);
    const res = await fetch(`http://${root.addr}/api/hosts/forget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "pcR" }),
    });
    expect(res.status, await res.text()).toBe(200);
    expect(root.daemon.teams().some((t) => t.host === "pcR")).toBe(false);

    const saved = JSON.parse(readFileSync(join(root.home, "teams.json"), "utf8")) as { host: string }[];
    expect(saved.some((t) => t.host === "pcR")).toBe(false);
  });

  it("republishes a child roster learned while the Root was offline", async () => {
    const root1 = await startDaemon("hubP", { mode: "root" });
    cleanup.push(root1.stop);
    const port = Number(root1.addr.split(":")[1]);
    const child = await startDaemon("pcP", { config: { root: root1.addr }, timing: FAST });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 5000);
    await root1.stop();
    await waitFor(() => !child.daemon.rootOnline, 5000);

    const dev = await barista(child.addr, identity("dev1", { team: "repo", teamChannel: "repo-dev", member: "dev1", channels: ["repo-dev"] }));
    cleanup.push(() => dev.client.close());
    await waitFor(() => child.daemon.teams().some((t) => t.team === "repo" && t.host === "pcP"), 5000);

    const root2 = await startDaemon("hubP", { mode: "root", config: { port, advertise: "127.0.0.1" } });
    cleanup.push(root2.stop);
    await waitFor(() => root2.daemon.teams().some((t) => t.host === "pcP" && t.team === "repo"), 8000);
  }, 30_000);

  it("ignores an equal revision but accepts a newer one", async () => {
    const d = await startDaemon("rev1", { mode: "root" });
    cleanup.push(d.stop);
    const key = "rev1/repo";
    const team = { team: "repo", host: "rev1", channel: "repo-dev", members: [{ name: "a", description: "", tags: [], scope: [], mode: "headless" as const, dir: "." }], revision: 10 };
    (d.daemon as unknown as { storeTeam: (t: unknown) => void }).storeTeam(team);
    (d.daemon as unknown as { storeTeam: (t: unknown) => void }).storeTeam({ ...team, members: [{ ...team.members[0]!, name: "stale" }], revision: 10 });
    expect(d.daemon.teams().find((t) => `${t.host}/${t.team}` === key)!.roster.map((m) => m.name)).toEqual(["a"]);

    (d.daemon as unknown as { storeTeam: (t: unknown) => void }).storeTeam({ ...team, members: [{ ...team.members[0]!, name: "b" }], revision: 11 });
    expect(d.daemon.teams().find((t) => `${t.host}/${t.team}` === key)!.roster.map((m) => m.name)).toEqual(["b"]);
  });
});