import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { daemonLog, daemonLogPath } from "@cafe/daemon";

// #66: daemon.log had no timestamp, no rotation and no boundary line between cafe versions, so
// `daemon ssh1 connected` three times in a row could have been one second or one hour apart.
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "cafe-log-"));
  dirs.push(d);
  return d;
}

describe("daemon log (#66)", () => {
  it("writes an ISO timestamp and the host on every line", () => {
    const h = home();
    const log = daemonLog("pc1", h);
    log("listening on :4777");
    const text = readFileSync(daemonLogPath(h), "utf8");
    expect(text).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[cafe pc1\] listening on :4777/);
  });

  it("writes a version/pid boundary line when it starts", () => {
    const h = home();
    const log = daemonLog("pc1", h, { version: "0.1.5", pid: 4242, mode: "root" });
    log("listening");
    const first = readFileSync(daemonLogPath(h), "utf8").split("\n")[0]!;
    expect(first).toContain("cafe 0.1.5");
    expect(first).toContain("pid 4242");
    expect(first).toContain("root");
  });

  it("caps the file and leaves a marker instead of growing forever", () => {
    const h = home();
    const log = daemonLog("pc1", h, { capBytes: 2048 });
    for (let i = 0; i < 500; i++) log(`line ${i} ${"x".repeat(40)}`);
    const size = statSync(daemonLogPath(h)).size;
    // The cap plus the one truncation marker line; never unbounded growth.
    expect(size).toBeLessThanOrEqual(2048 + 128);
    expect(readFileSync(daemonLogPath(h), "utf8")).toContain("log truncated");
  });

  it("starts appending when an older log already exists", () => {
    const h = home();
    writeFileSync(daemonLogPath(h), "[old] 0.1.4 starting\n");
    const log = daemonLog("pc1", h, { version: "0.1.5", pid: 7, mode: "daemon" });
    log("hello");
    const text = readFileSync(daemonLogPath(h), "utf8");
    expect(text).toContain("0.1.4 starting");
    expect(text).toContain("hello");
    expect(existsSync(daemonLogPath(h))).toBe(true);
  });
});

describe("daemon log path", () => {
  it("lives under CAFE_HOME", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), stringify({ host: "pc1", port: 0 }));
    expect(daemonLogPath(h)).toBe(join(h, "daemon.log"));
  });
});