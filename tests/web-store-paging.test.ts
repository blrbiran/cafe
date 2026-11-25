import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMeta } from "@cafe/protocol";

// v4-11 review: (1) switching channels must not unmount the Feed and throw away an unsent
// composer draft; (2) a same-channel reconnect must not strand "load older" in `loading: true`.
const meta = (id: string, createdAt: number): ThreadMeta =>
  ({ threadId: id, createdAt, lastActivityAt: createdAt, status: "done", channel: "default", orderId: `o-${id}`, turns: 1, replies: [], declines: [], targets: [], summary: id } as unknown as ThreadMeta);

const snapshot = (threads: ThreadMeta[]) => ({
  host: "h",
  isRoot: true,
  rootOnline: true,
  router: "rules",
  registryVersion: 1,
  agents: [],
  daemons: [],
  threads,
});

type Handler = (path: string) => unknown;
function mockFetch(handler: Handler): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => new Response(JSON.stringify(handler(String(path))), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("web store channel switch and pagination (v4-11)", () => {
  it("keeps the Feed mounted across a channel switch", async () => {
    vi.resetModules();
    mockFetch((path) => (path.startsWith("/api/snapshot") ? snapshot([meta("t1", 1000)]) : []));
    const store = await import("../packages/web/src/store.ts");
    await store.refreshStore();
    expect(store.getState().loaded).toBe(true);

    store.setChannel("team");
    // The composer lives in the Feed; unmounting it here is what lost the draft.
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().threads).toEqual([]);
  });

  it("clears loadOlder.loading when a same-channel refresh lands first", async () => {
    vi.resetModules();
    let pageData: ThreadMeta[] = [];
    let releasePage!: () => void;
    const pageGate = new Promise<void>((r) => (releasePage = r));
    // A full snapshot keeps `older.done` false, so the page request actually runs.
    const full = Array.from({ length: 200 }, (_, i) => meta(`t${i + 2}`, 2000 + i));
    mockFetch((path) => {
      if (path.startsWith("/api/snapshot")) return snapshot(full);
      if (path.startsWith("/api/threads")) return pageData;
      return [];
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      if (String(path).startsWith("/api/threads")) await pageGate;
      return realFetch(path, init);
    });

    const store = await import("../packages/web/src/store.ts");
    await store.refreshStore();
    pageData = [meta("t1", 1000)];
    const loading = store.loadOlder();
    expect(store.getState().older.loading).toBe(true);

    // A reconnect refreshes the snapshot on the same channel while the page is in flight.
    await store.refreshStore();
    releasePage();
    await loading;

    expect(store.getState().older.loading).toBe(false);
    expect(store.getState().threads.map((t) => t.threadId)).toContain("t1");
    expect(store.getState().threads.map((t) => t.threadId)).toContain("t2");
  });

  it("falls back to the legacy view only when both the feature list and /api/channels say no", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (String(path).startsWith("/api/channels")) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(snapshot([meta("t1", 1000)])), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const store = await import("../packages/web/src/store.ts");
    store.syncChannel("team");
    await store.refreshStore();
    expect(store.getState().legacy).toBe(true);
    expect(store.getState().channel).toBe("default");
  });

  it("keeps channels for a v4-11 daemon that advertises nothing but serves /api/channels", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (String(path).startsWith("/api/channels")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(snapshot([meta("t1", 1000)])), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const store = await import("../packages/web/src/store.ts");
    store.syncChannel("team");
    await store.refreshStore();
    expect(store.getState().legacy).toBe(false);
    expect(store.getState().channel).toBe("team");
  });
});