/**
 * TLS cost baseline for #61 (v4-6). One scratch Root with `security.mode: tls`; the same daemon
 * answers on its plaintext port and its TLS port, so the only difference is the transport.
 *
 *   npm run perf:tls            # defaults: 2000 round trips, 200 new connections
 *   npm run perf:tls -- --json
 *
 * Targets from the issue (a report, not a gate):
 *   - steady WebSocket round trip: TLS p95 within 10% of plaintext
 *   - new connection (connect + handshake + initialize): TLS p95 adds < 10 ms
 *
 * Loopback only, so the numbers isolate crypto + framing cost; a real LAN adds the same network
 * latency to both sides.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import WebSocket from "ws";
import { runDaemon } from "../packages/daemon/src/index.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const num = (flag: string, def: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const ROUND_TRIPS = num("--round-trips", 2000);
const CONNECTIONS = num("--connections", 200);
const WARMUP = 100;

// A benchmark daemon must not announce itself on the real LAN.
process.env.CAFE_DISCOVERY = "0";

const home = mkdtempSync(join(tmpdir(), "cafe-perf-tls-"));
writeFileSync(join(home, "config.yml"), stringify({ host: "perftls", token: "perf", port: 0, mode: "root", advertise: "127.0.0.1", security: { mode: "tls", tls: { port: 0 } } }));
const running = await runDaemon({ home, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "no-web") });
const ca = readFileSync(join(home, "tls", "ca.crt"));
const plainUrl = `ws://127.0.0.1:${running.server.port}/ws`;
const tlsUrl = `wss://127.0.0.1:${running.server.tlsPort}/ws`;

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, url.startsWith("wss:") ? { ca } : {});
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Sends one JSON-RPC request and resolves on its response; any reply (even an error) is a round trip. */
function request(ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<void> {
  return new Promise((resolve) => {
    const on = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.id !== id) return;
      ws.off("message", on);
      resolve();
    };
    ws.on("message", on);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const initialize = (ws: WebSocket) => request(ws, 0, "initialize", { protocolVersion: 1, kind: "ui", token: "perf" });

async function roundTrips(url: string): Promise<number[]> {
  const ws = await open(url);
  await initialize(ws);
  const out: number[] = [];
  for (let i = 1; i <= WARMUP + ROUND_TRIPS; i++) {
    const t = performance.now();
    await request(ws, i, "perf/echo", { i });
    if (i > WARMUP) out.push(performance.now() - t);
  }
  ws.close();
  return out;
}

async function newConnections(url: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < CONNECTIONS + 10; i++) {
    const t = performance.now();
    const ws = await open(url);
    await initialize(ws);
    const d = performance.now() - t;
    ws.terminate();
    if (i >= 10) out.push(d);
  }
  return out;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(3);
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}

try {
  // Warm both paths first (JIT, TLS session setup) so the first transport measured is not the cold one.
  await roundTrips(plainUrl);
  await roundTrips(tlsUrl);
  // Three alternating rounds; each transport's numbers are the median round. A loopback p95 is tens
  // of microseconds, so one round's ±20 µs jitter alone swings the percentage by tens of percent.
  const ROUNDS = 3;
  const rounds: Array<Record<"rtPlain" | "rtTls" | "ncPlain" | "ncTls", ReturnType<typeof stats>>> = [];
  for (let r = 0; r < ROUNDS; r++) {
    const plainFirst = r % 2 === 0;
    const rt = plainFirst ? [await roundTrips(plainUrl), await roundTrips(tlsUrl)] : [await roundTrips(tlsUrl), await roundTrips(plainUrl)].reverse();
    const nc = plainFirst ? [await newConnections(plainUrl), await newConnections(tlsUrl)] : [await newConnections(tlsUrl), await newConnections(plainUrl)].reverse();
    rounds.push({ rtPlain: stats(rt[0]!), rtTls: stats(rt[1]!), ncPlain: stats(nc[0]!), ncTls: stats(nc[1]!) });
  }
  const median = (k: keyof (typeof rounds)[number]) => [...rounds].sort((a, b) => a[k].p95 - b[k].p95)[Math.floor(ROUNDS / 2)]![k];
  const rtPlain = median("rtPlain");
  const rtTls = median("rtTls");
  const ncPlain = median("ncPlain");
  const ncTls = median("ncTls");
  const rtDeltaPct = +(((rtTls.p95 - rtPlain.p95) / rtPlain.p95) * 100).toFixed(1);
  const rtDeltaMs = +(rtTls.p95 - rtPlain.p95).toFixed(3);
  const ncDeltaMs = +(ncTls.p95 - ncPlain.p95).toFixed(3);
  const report = {
    node: process.version,
    roundTrip: { plain: rtPlain, tls: rtTls, p95DeltaPct: rtDeltaPct, p95DeltaMs: rtDeltaMs, target: "< 10%", met: rtDeltaPct < 10 },
    newConnection: { plain: ncPlain, tls: ncTls, p95DeltaMs: ncDeltaMs, target: "< 10 ms", met: ncDeltaMs < 10 },
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    const row = (name: string, a: ReturnType<typeof stats>, b: ReturnType<typeof stats>) =>
      console.log(`${name.padEnd(16)} plain p50 ${a.p50} p95 ${a.p95} p99 ${a.p99} ms | tls p50 ${b.p50} p95 ${b.p95} p99 ${b.p99} ms`);
    console.log(`perf:tls (Node ${process.version}, loopback, median of ${ROUNDS} rounds × ${ROUND_TRIPS} round trips / ${CONNECTIONS} connections)`);
    row("round trip", rtPlain, rtTls);
    row("new connection", ncPlain, ncTls);
    console.log(`round trip p95 ${rtDeltaPct >= 0 ? "+" : ""}${rtDeltaPct}% (${rtDeltaMs} ms; target < 10%) ${report.roundTrip.met ? "met" : "NOT met"}`);
    console.log(`new connection p95 +${ncDeltaMs} ms (target < 10 ms) ${report.newConnection.met ? "met" : "NOT met"}`);
  }
} finally {
  await running.stop();
  rmSync(home, { recursive: true, force: true });
}
