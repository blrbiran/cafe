import { afterEach, describe, expect, it } from "vitest";
import { FAST, barista, customer, identity, startDaemon, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("channel filtering in the store and HTTP API (v4-11)", () => {
  it("returns only the selected channel from snapshot, threads and search", async () => {
    const d = await startDaemon("sc1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const def = await barista(d.addr, identity("def"));
    cleanup.push(() => def.client.close());
    const team = await barista(d.addr, identity("teamie", { channels: ["team"] }));
    cleanup.push(() => team.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const a = await c.ask({ body: "default needle", to: "def" });
    const b = await c.ask({ body: "team needle", to: "teamie", channel: "team" });
    await waitFor(() => d.daemon.store.getThread(a.threadId) !== undefined && d.daemon.store.getThread(b.threadId) !== undefined, 5000);

    const teamSnap = (await (await fetch(`http://${d.addr}/api/snapshot?channel=team`)).json()) as { threads: { threadId: string; channel?: string }[] };
    expect(teamSnap.threads.map((t) => t.threadId)).toContain(b.threadId);
    expect(teamSnap.threads.map((t) => t.threadId)).not.toContain(a.threadId);

    const teamThreads = (await (await fetch(`http://${d.addr}/api/threads?channel=team`)).json()) as { threadId: string }[];
    expect(teamThreads.map((t) => t.threadId)).toEqual([b.threadId]);

    const teamSearch = (await (await fetch(`http://${d.addr}/api/search?q=needle&channel=team`)).json()) as { meta: { threadId: string } }[];
    expect(teamSearch.map((r) => r.meta.threadId)).toEqual([b.threadId]);

    // Absent means all channels (old clients keep working).
    const allThreads = (await (await fetch(`http://${d.addr}/api/threads`)).json()) as { threadId: string }[];
    expect(allThreads.map((t) => t.threadId).sort()).toEqual([a.threadId, b.threadId].sort());
  });

  it("stores an old Thread (no channel) as default", async () => {
    const d = await startDaemon("sc2", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const def = await barista(d.addr, identity("def"));
    cleanup.push(() => def.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const a = await c.ask({ body: "plain", to: "def" });
    await waitFor(() => d.daemon.store.getThread(a.threadId) !== undefined, 5000);
    const defaults = d.daemon.store.listThreadsIn("default");
    expect(defaults.map((m) => m.threadId)).toContain(a.threadId);
  });
});