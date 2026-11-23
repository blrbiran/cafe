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

// Search: index 2000 threads x 20 events, then run the FTS path the daemon uses for 3+ char queries.
const who = (id: string) => `${id}#1@root`;
const indexMs = ms(() => {
  for (const f of scanFiles) for (const env of store.readEvents(f)) store.indexEvent(env as any, who);
});
let ftsHits = 0;
const searchFtsMs = ms(() => {
  ftsHits = store.searchIndex("answer 7", 20).hits.length;
});
// #67: heartbeats produce no searchable text, so they must not touch the index at all.
const indexedBeforeHeartbeats = store.countIndexed();
const heartbeatIndexMs = ms(() => {
  for (let i = 0; i < 1000; i++) store.indexEvent({ eventId: `hb${i}`, threadId: "s0", orderId: "o", host: "root", at: now, event: { type: "order.heartbeat", agentId: "a" } } as any, who);
});
const heartbeatIndexRows = store.countIndexed() - indexedBeforeHeartbeats;

// #68: the hint recompute used to pull every row of the last seven days into JS.
const HINT_ROWS = 200_000;
const hintInsert = store["db"].prepare("INSERT INTO agent_events(agent_id, kind, at, thread_id, identity, tokens) VALUES (?, ?, ?, ?, ?, ?)");
store["db"].exec("BEGIN");
for (let i = 0; i < HINT_ROWS; i++) hintInsert.run(`a${i % 100}`, i % 5 === 0 ? "declined" : "answered", now - (i % (7 * 24 * 3600_000)), `h${i}`, `a${i % 100}@root`, i % 5 === 0 ? "refund vat" : "readme");
store["db"].exec("COMMIT");
let hintRows = 0;
const hintSummaryMs = ms(() => {
  hintRows = store.outcomeSummary(now - 7 * 24 * 3600_000).length;
});
let hintOldMs = 0;
const hintOldRowsMs = ms(() => {
  store.outcomes(now - 7 * 24 * 3600_000);
});
hintOldMs = hintOldRowsMs;

let registryUnchangedMs = 0;
registryUnchangedMs = ms(() => {
  for (let i = 0; i < 1000; i++) store.saveRegistry(i, records);
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
      registryUnchanged1000Ms: registryUnchangedMs,
      searchScan2000x20Ms,
      scanned,
      stale10kMs,
      staleCount,
      indexMs,
      indexEvents: scanned,
      searchFtsMs,
      ftsHits,
      heartbeatIndexMs,
      heartbeatIndexRows,
      hintRows,
      hintSummaryMs,
      hintOldRowsMs,
    },
    null,
    2,
  ),
);

store.close();
rmSync(home, { recursive: true, force: true });