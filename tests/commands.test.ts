import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudePluginPlan, claudePluginState, writeClaudePlugin } from "../packages/cli/src/claude-plugin.ts";
import { claudeCommandPath, claudeCommandState, commandsStatus, installClaudeCommand } from "../packages/cli/src/commands.ts";

const dirs: string[] = [];
function temp(prefix = "cafe-cmd-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A fake `claude` on PATH that answers `plugin list` from a JSON file, so tests control what is "installed". */
function fakeClaude(home: string, opts: { listOutput?: string; exit?: number } = {}): { bin: string; state: string } {
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const stateFile = join(home, "claude-state.txt");
  writeFileSync(stateFile, opts.listOutput ?? "");
  const bin = join(binDir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  cat "${stateFile}"
  exit ${opts.exit ?? 0}
fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return { bin, state: stateFile };
}

describe("commands status (#55)", () => {
  it("reports /cafe-barista installed only when `claude plugin list` shows the plugin", () => {
    const home = temp();
    const user = join(home, "user");
    mkdirSync(join(user, ".claude/commands"), { recursive: true });

    const fake = fakeClaude(home, { listOutput: "  ❯ cafe@cafe-local\n    Status: ✔ enabled\n" });
    const installed = commandsStatus({ userHome: user, claudePlugin: claudePluginState(fake.bin) }).find((r) => r.entry === "/cafe-barista");
    expect(installed?.status).toBe("installed");

    writeFileSync(fake.state, "Installed plugins:\n  (none)\n");
    const missing = commandsStatus({ userHome: user, claudePlugin: claudePluginState(fake.bin) }).find((r) => r.entry === "/cafe-barista");
    expect(missing?.status).toBe("missing");
  });

  it("does not claim installed just because the marketplace folder exists", () => {
    const home = temp();
    const user = join(home, "user");
    mkdirSync(join(user, ".claude/commands"), { recursive: true });
    // writeClaudePlugin alone (no `claude plugin install`) must not read as installed.
    const plan = claudePluginPlan(home, ["node", "/repo/packages/cli/bin/cafe.js"]);
    writeClaudePlugin(plan);

    const fake = fakeClaude(home, { listOutput: "Installed plugins:\n  (none)\n" });
    const row = commandsStatus({ userHome: user, claudePlugin: claudePluginState(fake.bin) }).find((r) => r.entry === "/cafe-barista");
    expect(row?.status).toBe("missing");
  });

  it("treats a broken claude binary as unavailable, not installed", () => {
    const home = temp();
    const user = join(home, "user");
    mkdirSync(join(user, ".claude/commands"), { recursive: true });
    const fake = fakeClaude(home, { exit: 137 });
    const row = commandsStatus({ userHome: user, claudePlugin: claudePluginState(fake.bin) }).find((r) => r.entry === "/cafe-barista");
    expect(row?.status).toBe("unavailable");
    expect(row?.detail).toContain("137");
  });

  it("says the binary is missing when claude is not on PATH", () => {
    const state = claudePluginState(join(temp(), "no-such-claude"));
    expect(state.state).toBe("unknown");
    expect(state.detail).toMatch(/not found|failed/);
  });
});

describe("cafe claude install exits non-zero when claude rejects the plugin (#55)", () => {
  const BIN = join(import.meta.dirname, "../packages/cli/bin/cafe.js");

  function run(cafeHome: string, home: string, fakeBin: string): { status: number | null; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [BIN, "claude", "install"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, CAFE_HOME: cafeHome, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string; stderr?: string };
      return { status: e.status ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("exits 1 and says the plugin is not registered when `claude plugin install` fails", () => {
    const home = temp();
    const cafeHome = join(home, ".cafe");
    mkdirSync(cafeHome, { recursive: true });
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, "claude");
    writeFileSync(fake, '#!/bin/sh\nif [ "$2" = "install" ]; then echo "boom: plugin rejected" >&2; exit 1; fi\nexit 0\n');
    chmodSync(fake, 0o755);

    const r = run(cafeHome, home, binDir);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("the plugin is not registered");
  });

  it("still exits 0 when claude registers the plugin", () => {
    const home = temp();
    const cafeHome = join(home, ".cafe");
    mkdirSync(cafeHome, { recursive: true });
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, "claude");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);

    const r = run(cafeHome, home, binDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("run /reload-plugins");
  });
});

describe("cafe commands install --agent claude", () => {
  it("keeps a person's own command file unless --force, and writes ours with the marker", () => {
    const home = temp();
    const path = claudeCommandPath(home);
    mkdirSync(join(home, ".claude/commands"), { recursive: true });
    writeFileSync(path, "# my own cafe command\n");
    expect(claudeCommandState(home).state).toBe("foreign");
    expect(() => installClaudeCommand(home)).toThrow(/--force/);
    const r = installClaudeCommand(home, { force: true });
    expect(r.written).toBe(true);
    expect(r.replaced).toContain("my own cafe command");
    expect(claudeCommandState(home).state).toBe("ours");
    expect(existsSync(path)).toBe(true);
  });
});