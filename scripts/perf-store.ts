/**
 * Repeatable storage baseline for #31/#34. No daemon, no model.
 *
 *   npm run perf:store
 *
 * The numbers are not a pass/fail gate; they show whether a change moved the
 * hot paths (meta write amplification, paging, search scans).
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/daemon/src/store.ts";

const home = mkdtempSync(join(tmpdir(), "cafe-perf-"));
const store = new Store(home);
const now = Date.now();
const ms = (fn: () => void) => {
  const t = performance.now();
  fn();
  return +(performance.now() - t).toFixed(1);
};

const meta: any = {
  threadId: "t1",
  orderId: "o1",
  file: store.threadFile("t1", now),
  status: "done",
  createdAt: now,
  lastActivityAt: now,
  from: { address: "cli@root", host: "root" },
  replies: [],
  declines: [],
};

// Write side: the daemon now keeps at most 50 reply summaries per turn, so this
// models the bounded metadata instead of an ever-growing array.
const WRITE = 5000;
const write5000Ms = ms(() => {
  for (let i = 0; i < WRITE; i++) {
    meta.replies.push({ agentId: "a", address: "a#1@root", text: `reply ${i} `.repeat(20), at: now });
    if (meta.replies.length > 50) meta.replies.shift();
    store.putThread(meta);
  }
});
const metaBytes = Buffer.byteLength(JSON.stringify(meta));
const dbBytes = statSync(join(home, "cafe.db")).size;

const event = (i: number) => ({
  eventId: String(i).padStart(26, "0"),
  threadId: "t2",
  orderId: "o2",
  host: "root",
  at: now,
  event: { type: "order.replied", agentId: "a", text: `answer ${i} `.repeat(10), final: true },
});
const f2 = store.threadFile("t2", now);
for (let i = 0; i < 10_000; i++) store.appendEvent(f2, event(i));
let allCount = 0;
const read10kMs = ms(() => {
  allCount = store.readEvents(f2).length;
});
let tailCount = 0;
const tail12Ms = ms(() => {
  tailCount = store.readEventsPage(f2, 12).events.length;
});
const page3Ms = ms(() => {
  store.readEventsPage(f2, 3, "0000000000000000000001000");
});

for (let i = 0; i < 10_000; i++) store.putThread({ ...meta, threadId: `t${i}`, orderId: `o${i}`, replies: [], createdAt: i, file: f2 });
let listCount = 0;
const list200Ms = ms(() => {
  listCount = store.listThreads(200).length;
});
let allThreadsCount = 0;
const allThreads10kMs = ms(() => {
  allThreadsCount = store.allThreads().length;
});

const records = Array.from({ length: 100 }, (_, i) => ({
  agentId: `a${i}`,
  address: `a${i}#1@root`,
  name: `a${i}`,
  host: "root",
  role: "barista",
  status: "idle",
  agent: "pi",
  mode: "headless",
  cwd: "/tmp",
  description: "",
  tags: [],
  scope: [],
  concurrency: 1,
  registeredAt: 1,
  lastSeenAt: 2,
})) as any;
const registry100x1000Ms = ms(() => {
  for (let i = 0; i < 1000; i++) store.saveRegistry(i, records.map((r: any) => ({ ...r, status: i % 2 ? "idle" : "busy" })));
});

const scanFiles: string[] = [];
for (let i = 0; i < 2000; i++) {
  const f = store.threadFile(`s${i}`, now);
  scanFiles.push(f);
  for (let j = 0; j < 20; j++) store.appendEvent(f, event(j));
}
let scanned = 0;
const searchScan2000x20Ms = ms(() => {
  for (const f of scanFiles) scanned += store.readEvents(f).length;
});
let staleCount = 0;
const stale10kMs = ms(() => {
  staleCount = store.staleThreads(now + 1).length;
});

console.log(
  JSON.stringify(
    {
      write5000Ms,
      metaBytes,
      dbBytes,
      read10kMs,
      readCount: allCount,
      tail12Ms,
      tailCount,
      page3BeforeMs: page3Ms,
      list200Ms,
      listCount,
      allThreads10kMs,
      allCount: allThreadsCount,
      registry100x1000Ms,
      searchScan2000x20Ms,
      scanned,
      stale10kMs,
      staleCount,
    },
    null,
    2,
  ),
);

store.close();
rmSync(home, { recursive: true, force: true });