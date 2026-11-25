import { afterEach, describe, expect, it } from "vitest";
import { CafeClient } from "@cafe/protocol/client";
import { identity, startDaemon } from "./helpers.ts";

// Two native team members usually share `dir: .`. The stored native session must then be scoped by
// team/member, not cwd, or the second member resumes the first member's conversation (v4-11 review).
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const teamIdentity = (name: string, member: string) =>
  identity(name, { cwd: "/tmp", team: "repo", teamChannel: "repo-dev", member, channels: ["repo-dev"] });

describe("native session scope for team members", () => {
  it("keeps two members in the same cwd apart and lets a restarted member resume its own", async () => {
    const d = await startDaemon("sess1", { mode: "root" });
    cleanup.push(d.stop);

    const a = new CafeClient({ daemon: d.addr });
    cleanup.push(() => a.close());
    await a.connect(teamIdentity("dev-one", "dev1"));
    const b = new CafeClient({ daemon: d.addr });
    cleanup.push(() => b.close());
    await b.connect(teamIdentity("dev-two", "dev2"));

    await a.setSession("th1", "claude", "sid-a");
    expect(await a.getSession("th1", "claude")).toBe("sid-a");
    expect(await b.getSession("th1", "claude")).toBeUndefined();

    await b.setSession("th1", "claude", "sid-b");
    expect(await a.getSession("th1", "claude")).toBe("sid-a");

    // A restart is a new agentId but the same team/member.
    a.close();
    const again = new CafeClient({ daemon: d.addr });
    cleanup.push(() => again.close());
    await again.connect(teamIdentity("dev-one-restarted", "dev1"));
    expect(await again.getSession("th1", "claude")).toBe("sid-a");
  });

  it("keeps the cwd scope for a plain Barista so a restart still resumes", async () => {
    const d = await startDaemon("sess2", { mode: "root" });
    cleanup.push(d.stop);

    const a = new CafeClient({ daemon: d.addr });
    cleanup.push(() => a.close());
    await a.connect(identity("plain", { cwd: "/tmp/plain" }));
    await a.setSession("th2", "claude", "sid-plain");
    a.close();

    const again = new CafeClient({ daemon: d.addr });
    cleanup.push(() => again.close());
    await again.connect(identity("plain", { cwd: "/tmp/plain" }));
    expect(await again.getSession("th2", "claude")).toBe("sid-plain");
  });
});