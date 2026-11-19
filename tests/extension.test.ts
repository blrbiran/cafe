import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installPiExtension, ompExtensionCommand, piExtensionState, removePiExtension } from "../packages/cli/src/extension.ts";

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "cafe-ext-home-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("pi extension settings", () => {
  it("adds the extension once and preserves other settings", () => {
    const home = temp();
    mkdirSync(join(home, ".pi/agent"), { recursive: true });
    writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ defaultModel: "x", extensions: ["/other/one.ts"] }));
    const source = "/repo/packages/pi-extension/src/index.ts";

    const first = installPiExtension(home, source);
    expect(first).toMatchObject({ changed: true, alreadyInstalled: false });
    const settings = JSON.parse(readFileSync(join(home, ".pi/agent/settings.json"), "utf8"));
    expect(settings.defaultModel).toBe("x");
    expect(settings.extensions).toEqual(["/other/one.ts", source]);
    expect(piExtensionState(home, source).installed).toBe(true);

    const second = installPiExtension(home, source);
    expect(second).toMatchObject({ changed: false, alreadyInstalled: true });
    expect(JSON.parse(readFileSync(join(home, ".pi/agent/settings.json"), "utf8")).extensions).toHaveLength(2);
  });

  it("does not write on --dry-run", () => {
    const home = temp();
    const source = "/repo/ext.js";
    const r = installPiExtension(home, source, { dryRun: true });
    expect(r).toMatchObject({ changed: true, dryRun: true });
    expect(piExtensionState(home, source).installed).toBe(false);
  });

  it("removes only the cafe entry", () => {
    const home = temp();
    mkdirSync(join(home, ".pi/agent"), { recursive: true });
    writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ extensions: ["/other/one.ts", "/repo/ext.js"] }));
    removePiExtension(home, "/repo/ext.js");
    expect(JSON.parse(readFileSync(join(home, ".pi/agent/settings.json"), "utf8")).extensions).toEqual(["/other/one.ts"]);
  });
});

describe("omp extension", () => {
  it("uses the host's own install/link command, with dry-run and the right source", () => {
    expect(ompExtensionCommand("install", "/repo/packages/pi-extension", { dryRun: true })).toEqual([
      "omp",
      "install",
      "/repo/packages/pi-extension",
      "--dry-run",
      "--json",
    ]);
    expect(ompExtensionCommand("uninstall", "/repo/ext.js", {})).toEqual(["omp", "uninstall", "/repo/ext.js", "--json"]);
  });
});
