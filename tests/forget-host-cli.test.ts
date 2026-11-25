import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "./helpers.ts";

// v4-8: `cafe host forget <host>` on the Root. Async spawn: the daemon lives in this process (§8 trap).
const BIN = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function cafe(addr: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "cafe-cli-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return new Promise((res) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, CAFE_HOME: home, CAFE_DAEMON: addr, CAFE_TOKEN: "t0k" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => res({ status, stdout, stderr }));
  });
}

describe("cafe host forget", () => {
  it("prints what it removed", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    root.daemon.config.knownDaemons.ghost = "127.0.0.1:9";
    const r = await cafe(root.addr, "host", "forget", "ghost");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("removed ghost (0 agents)");
    expect(r.stdout).toContain("it reappears if it connects again");
  }, 30_000);

  it("explains an unknown machine", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const r = await cafe(root.addr, "host", "forget", "nosuch");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no machine 'nosuch'/);
  }, 30_000);
});
