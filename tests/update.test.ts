import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyUpdate, readUpdateState, rollbackUpdate, updateStatus } from "../packages/cli/src/update.ts";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const homes: string[] = [];
const ports: number[] = [];
afterEach(async () => {
  for (const port of ports.splice(0)) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(1000) });
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** A minimal release whose `bin/cafe.js` speaks just enough for the updater. */
function makeRelease(work: string, version: string, opts: { failStart?: boolean; protocol?: number; name?: string } = {}): string {
  const root = join(work, `rel-${version}`);
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(join(pkg, "web"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: opts.name ?? "@blrbiran/cafe", version }));
  writeFileSync(join(pkg, "dist", "cli.js"), "// fake\n");
  writeFileSync(join(pkg, "web", "index.html"), "<title>cafe</title>\n");
  writeFileSync(
    join(pkg, "bin", "cafe.js"),
    `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const version = ${JSON.stringify(version)};
if (args[0] === "--version") { console.log(version); process.exit(0); }
if (args[0] === "--protocol-version") { console.log(${opts.protocol ?? 1}); process.exit(0); }
if (args[0] === "daemon" && args[1] === "start") {
  ${opts.failStart ? "process.exit(1);" : ""}
  const home = process.env.CAFE_HOME;
  const cfg = readFileSync(join(home, "config.yml"), "utf8");
  const port = Number(/port:\\s*(\\d+)/.exec(cfg)?.[1] ?? 4777);
  const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const server = createServer((req, res) => {
    if (req.url === "/api/health") return send(res, 200, { ok: true, host: "t", isRoot: true, pid: process.pid, version, draining: false });
    if (req.url === "/api/snapshot") return send(res, 200, { host: "t", isRoot: true, registryVersion: 0, threads: [], agents: [], daemons: [] });
    if (req.method === "POST" && req.url === "/api/shutdown") { send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 20); return; }
    if (req.method === "POST" && req.url === "/api/drain") return send(res, 200, { waitedMs: 0, openThreads: 0, retryable: [] });
    send(res, 404, { error: "not_found" });
  });
  server.listen(port, "127.0.0.1");
  setInterval(() => {}, 1000);
}
`,
  );
  const tgz = join(work, `cafe-${version}.tgz`);
  // npm-pack layout: a top-level `package/` directory.
  execFileSync("tar", ["-czf", tgz, "-C", root, "package"]);
  return tgz;
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "cafe-update-"));
  homes.push(home);
  const work = mkdtempSync(join(tmpdir(), "cafe-update-work-"));
  homes.push(work);
  const port = await freePort();
  ports.push(port);
  writeFileSync(join(home, "config.yml"), `port: ${port}\nhost: t\nmode: root\ndiscovery: false\nsecurity:\n  mode: plaintext\n`);
  return { home, work, port, base: `http://127.0.0.1:${port}` };
}

describe("controlled update (#27)", () => {
  it("applies a release, health-checks it, and records lastGood", async () => {
    const { home, work, base } = await setup();
    const old = makeRelease(work, "0.0.1");
    const first = await applyUpdate({ home, base, file: old, healthTimeoutMs: 8000 });
    expect(first.ok).toBe(true);
    expect(first.health.version).toBe("0.0.1");
    expect(readUpdateState(home)).toMatchObject({ current: "0.0.1", lastGood: "0.0.1" });

    const next = makeRelease(work, "9.9.9");
    const r = await applyUpdate({ home, base, file: next, healthTimeoutMs: 8000 });
    expect(r.ok).toBe(true);
    expect(r.from).toBe("0.0.1");
    expect(r.health.version).toBe("9.9.9");
    const s = await updateStatus(home, base);
    expect(s.running?.version).toBe("9.9.9");
    expect(s.current).toBe("9.9.9");
    expect(s.lastGood).toBe("9.9.9");
  }, 30_000);

  it("rolls back automatically when the new release never becomes healthy", async () => {
    const { home, work, base } = await setup();
    await applyUpdate({ home, base, file: makeRelease(work, "0.0.1"), healthTimeoutMs: 8000 });
    const bad = makeRelease(work, "9.9.8", { failStart: true });
    const r = await applyUpdate({ home, base, file: bad, healthTimeoutMs: 2500 });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.health.ok).toBe(false);
    const s = await updateStatus(home, base);
    expect(s.running?.version).toBe("0.0.1");
    expect(s.current).toBe("0.0.1");
    expect(s.lastGood).toBe("0.0.1");
    expect(s.log.some((e) => e.action === "apply" && !e.ok)).toBe(true);
  }, 30_000);

  it("rolls back on demand to lastGood", async () => {
    const { home, work, base } = await setup();
    await applyUpdate({ home, base, file: makeRelease(work, "0.0.1"), healthTimeoutMs: 8000 });
    const r = await rollbackUpdate({ home, base, healthTimeoutMs: 8000 });
    expect(r.ok).toBe(true);
    expect(r.to).toBe("0.0.1");
    expect((await updateStatus(home, base)).running?.version).toBe("0.0.1");
  }, 30_000);

  it("rejects a bad package name, a wrong checksum and a protocol mismatch", async () => {
    const { home, work, base } = await setup();
    await expect(applyUpdate({ home, base, file: makeRelease(work, "1.0.0", { name: "evil" }) })).rejects.toThrow(/bad_package/);
    await expect(applyUpdate({ home, base, file: makeRelease(work, "1.0.1"), sha256: "0".repeat(64) })).rejects.toThrow(/checksum_mismatch/);
    await expect(applyUpdate({ home, base, file: makeRelease(work, "1.0.2", { protocol: 99 }) })).rejects.toThrow(/protocol_mismatch/);
    expect(readUpdateState(home).current).toBeUndefined();
  }, 30_000);
});

describe("daemon drain (#27)", () => {
  it("refuses new Orders while draining and reports still-open threads as retryable", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    const b = await barista(d.addr, identity("slow"), async (h) => {
      await h.ack();
      await new Promise((r) => setTimeout(r, 1200));
      await h.reply("done");
    });
    const c = await customer(d.addr);
    try {
      const res = await c.ask({ body: "hi", to: "slow" });
      await waitFor(() => d.daemon.thread(res.threadId)?.meta.status === "working");
      const drained = await d.daemon.drain(200);
      expect(drained.openThreads).toBe(1);
      expect(drained.retryable).toContain(res.threadId);
      const h = (await (await fetch(`http://${d.addr}/api/health`)).json()) as { draining?: boolean };
      expect(h.draining).toBe(true);
      await expect(c.ask({ body: "again" })).rejects.toThrow(/draining/);
      await untilClosed(c, res.threadId, res.orderId);
    } finally {
      await b.client.close();
      await c.close();
      await d.stop();
    }
  }, 15_000);
});