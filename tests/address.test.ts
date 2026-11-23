import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { runDaemon } from "@cafe/daemon";
import { FAST, startDaemon } from "./helpers.ts";

// #76: `advertise: 127.0.0.1:4801` used to become `ws://127.0.0.1:4801:4801`, which was then persisted
// as a child's `root:` and killed that daemon on every start with an uncaught Invalid URL.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("daemon addresses (#76)", () => {
  it("does not append the port twice when advertise already carries one", async () => {
    const d = await startDaemon("pc1", { mode: "root", config: { advertise: "127.0.0.1:4801" } });
    cleanup.push(d.stop);
    expect(d.daemon.url()).toBe("ws://127.0.0.1:4801");
    const daemons = await fetch(`http://${d.addr}/api/daemons`).then((r) => r.json());
    expect(daemons.find((x: { host: string }) => x.host === "pc1").url).toBe("ws://127.0.0.1:4801");
  });

  it("keeps a bare host working", async () => {
    const d = await startDaemon("pc1", { mode: "root", config: { advertise: "10.0.0.5" } });
    cleanup.push(d.stop);
    expect(d.daemon.url()).toMatch(/^ws:\/\/10\.0\.0\.5:\d+$/);
  });

  it("refuses a malformed Root address instead of persisting it", async () => {
    const d = await startDaemon("pc1", { config: { root: "127.0.0.1:4799" } });
    cleanup.push(d.stop);
    const bad = await fetch(`http://${d.addr}/api/root`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: "1.2.3.4:4777:4777" }) });
    expect(bad.status).toBe(400);
    expect(d.daemon.config.root).toBe("127.0.0.1:4799");
  });

  it("starts with an unusable persisted root instead of dying", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-badroot-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, "config.yml"), stringify({ host: "pc1", token: "t0k", port: 0, root: "1.2.3.4:4777:4777" }));
    // An invalid URL used to throw out of a timer callback and exit the process.
    const r = await runDaemon({ home, timing: FAST, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "no-web") });
    cleanup.push(r.stop);
    expect(r.daemon.config.root).toBe("1.2.3.4:4777:4777");
  });
});