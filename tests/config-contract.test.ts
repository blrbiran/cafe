import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { configApplyMode, diffConfig } from "../packages/daemon/src/config.ts";
import { startDaemon } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("config apply modes", () => {
  it("marks router and root as hot, everything else as restart-required", () => {
    expect(configApplyMode("router.model")).toBe("hot");
    expect(configApplyMode("router.timeoutMs")).toBe("hot");
    expect(configApplyMode("root")).toBe("hot");
    expect(configApplyMode("host")).toBe("restart-required");
    expect(configApplyMode("retention.days")).toBe("restart-required");
  });
});

describe("config diff", () => {
  it("reports a changed restart-required value", () => {
    const file = { host: "new-name", router: { model: "p/m" } };
    const running = { host: "old-name", router: { model: "p/m" } };
    expect(diffConfig(file, running)).toEqual([{ key: "host", file: "new-name", running: "old-name", mode: "restart-required" }]);
  });

  it("reports a changed hot value", () => {
    const file = { router: { model: "p/new" } };
    const running = { router: { model: "p/old" } };
    expect(diffConfig(file, running)).toEqual([{ key: "router.model", file: "p/new", running: "p/old", mode: "hot" }]);
  });

  it("returns nothing when the running daemon already matches the file", () => {
    const same = { host: "a", router: { model: "p/m", learn: true }, retention: { days: 7 } };
    expect(diffConfig(same, structuredClone(same))).toEqual([]);
  });

  it("ignores an ephemeral port (0) that the daemon resolved to a real one", () => {
    expect(diffConfig({ port: 0 }, { port: 57_828 })).toEqual([]);
  });
});

describe("runtime config endpoint", () => {
  it("exposes what the daemon is actually running, without the token", async () => {
    const d = await startDaemon("pc1", { config: { router: { model: "p/m" }, retention: { days: 7 }, displayName: "desk" } });
    cleanup.push(d.stop);
    const res = await fetch(`http://${d.addr}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ host: "pc1", displayName: "desk", mode: "daemon", retention: { days: 7 }, router: { model: "p/m" } });
    expect(JSON.stringify(body)).not.toContain("t0k");
  });

  it("lists config.yml changes the running daemon has not applied", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    writeFileSync(join(d.home, "config.yml"), stringify({ host: "pc1", token: "t0k", port: 0, advertise: "127.0.0.1", mode: "root" }));
    const body = (await (await fetch(`http://${d.addr}/api/config`)).json()) as { pending: unknown[] };
    expect(body.pending).toEqual([{ key: "mode", file: "root", running: "daemon", mode: "restart-required" }]);
  });
});

describe("web build freshness", () => {
  it("marks the snapshot after the built UI changes on disk", async () => {
    const dist = mkdtempSync(join(tmpdir(), "cafe-web-"));
    writeFileSync(join(dist, "index.html"), "v1");
    const d = await startDaemon("pc1", { webDist: dist });
    cleanup.push(d.stop, () => rmSync(dist, { recursive: true, force: true }));

    const snap = async () => (await (await fetch(`http://${d.addr}/api/snapshot`)).json()) as { webStale?: boolean };
    expect((await snap()).webStale).toBeUndefined();
    writeFileSync(join(dist, "index.html"), "v2-rebuilt");
    expect((await snap()).webStale).toBe(true);
  });
});