import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cafe/daemon";
import type { ThreadMeta } from "@cafe/protocol";

// v4-12: channel history and digests page by activity. Before this a reply on an old Thread that
// fell outside the newest-N-by-creation window was invisible to observers and channel catch-up.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const meta = (id: string, createdAt: number, lastActivityAt: number) =>
  ({ threadId: id, createdAt, lastActivityAt, status: "done", channel: "default", orderId: `o-${id}`, turns: 1, targets: [], summary: id }) as unknown as ThreadMeta;

describe("activity-ordered channel threads", () => {
  it("puts a recently active old Thread first and honours the after cursor", () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-store-activity-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const store = new Store(home);
    cleanup.push(() => store.close());

    const now = Date.now();
    for (let i = 0; i < 220; i++) store.putThread(meta(`new-${i}`, now - i, now - i));
    store.putThread(meta("old-but-active", now - 86_400_000, now + 1000));

    const first = store.listThreadsInByActivity("default", { limit: 10 });
    expect(first[0]!.threadId).toBe("old-but-active");
    expect(first.map((m) => m.threadId)).not.toContain("new-219");

    const recent = store.listThreadsInByActivity("default", { after: now });
    expect(recent.map((m) => m.threadId)).toEqual(["old-but-active"]);
    // The creation-ordered window really does omit it; this is the bug the query replaces.
    expect(store.listThreadsIn("default", 200).some((m) => m.threadId === "old-but-active")).toBe(false);
  });

  it("pages backwards by activity with the before cursor", () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-store-activity-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const store = new Store(home);
    cleanup.push(() => store.close());
    const now = Date.now();
    for (let i = 0; i < 5; i++) store.putThread(meta(`t${i}`, now, now - i * 10));
    const page = store.listThreadsInByActivity("default", { before: now - 15, limit: 10 });
    expect(page.map((m) => m.threadId)).toEqual(["t2", "t3", "t4"]);
  });
});