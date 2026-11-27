import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installConnector, removeConnector, restartConnector, superviseConnector, startConnector, statusConnector, stopConnector } from "../packages/cli/src/connector.ts";
import { Store } from "../packages/daemon/src/store.ts";

// #56: a connector that ends cleanly is finished, not crashed. Manual starts are not crash restarts.
// #58: a signal-killed helper must be reported by name, not as `null`.
const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

/** A minimal connector that writes one heartbeat line and then exits with `code`. */
function fixture(home: string, name: string, code: number): void {
  const dir = join(home, "connectors", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "cafe-connector.json"),
    JSON.stringify({ name, kind: "customer-connector", version: "0.0.0", entry: "index.mjs", configSchema: {}, permissions: [], health: { heartbeatMs: 0 } }),
  );
  writeFileSync(
    join(dir, "index.mjs"),
    `process.stdout.write(JSON.stringify({ type: "hello", name: ${JSON.stringify(name)} }) + "\\n");
process.stdout.write(JSON.stringify({ type: "heartbeat", at: Date.now() }) + "\\n");
setTimeout(() => process.exit(${code}), 30);
`,
  );
}

describe("connector caller credential lifecycle", () => {
  it("provisions on install, preserves identity on force reinstall, and revokes on remove", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-conn-credential-"));
    homes.push(home);
    const source = join(home, "fixture-source");
    mkdirSync(source);
    writeFileSync(join(source, "cafe-connector.json"), JSON.stringify({
      name: "fixture",
      kind: "customer-connector",
      version: "1.0.0",
      entry: "index.mjs",
      configSchema: {},
      permissions: ["orders:write"],
    }));
    writeFileSync(join(source, "index.mjs"), "process.exit(0);\n");

    installConnector(home, source);
    const keyPath = join(home, "connector-data", "fixture", "connector.key");
    const key = readFileSync(keyPath, "utf8");
    const digest = createHash("sha256").update(key).digest("hex");
    const store = new Store(home);
    try {
      const principalId = store.getCallerPrincipal("connector", digest);
      expect(principalId).toBeTruthy();
      expect((await import("node:fs")).statSync(keyPath).mode & 0o077).toBe(0);

      const observedKey = join(home, "connector-key-observed");
      const supervisorArgv = [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(observedKey)}, process.env.CAFE_CONNECTOR_KEY ?? "missing"); setInterval(() => {}, 1000);`];
      await startConnector(home, "fixture", { supervisorArgv });
      expect(readFileSync(observedKey, "utf8")).toBe(key);
      await restartConnector(home, "fixture", { supervisorArgv });
      expect(readFileSync(observedKey, "utf8")).toBe(key);
      await stopConnector(home, "fixture");

      installConnector(home, source, { force: true });
      expect(readFileSync(keyPath, "utf8")).toBe(key);
      expect(store.getCallerPrincipal("connector", digest)).toBe(principalId);

      const removed = await removeConnector(home, "fixture");
      expect(removed.removed).toBe(true);
      expect(store.getCallerPrincipal("connector", digest)).toBeUndefined();
      expect(existsSync(keyPath)).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("connector supervisor exit semantics (#56)", () => {
  it("treats a clean exit as stopped: no restart, no error", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-conn-"));
    homes.push(home);
    fixture(home, "once", 0);
    await superviseConnector(home, "once");
    const s = statusConnector(home, "once");
    expect(s.status).toBe("stopped");
    expect(s.restarts).toBe(0);
    expect(s.lastError).toBeUndefined();
  });

  it("still restarts a connector that exits non-zero", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-conn-"));
    homes.push(home);
    fixture(home, "flaky", 3);
    // Give up after one restart so the test is quick and deterministic.
    await superviseConnector(home, "flaky", { maxRestarts: 1, windowMs: 60_000, baseDelayMs: 20 });
    const s = statusConnector(home, "flaky");
    expect(s.status).toBe("crashed");
    expect(s.restarts).toBeGreaterThan(0);
    expect(s.lastError).toMatch(/exited 3/);
  });

  it("does not count a manual start as a crash restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-conn-"));
    homes.push(home);
    fixture(home, "long", 0);
    // A stand-in supervisor that stays up: what is under test is the run.json bookkeeping.
    const supervisorArgv = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
    await startConnector(home, "long", { supervisorArgv });
    await stopConnector(home, "long");
    await startConnector(home, "long", { supervisorArgv });
    const s = statusConnector(home, "long");
    await stopConnector(home, "long");
    expect(s.restarts).toBe(0);
  });
});