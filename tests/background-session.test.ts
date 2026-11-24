import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isBackgroundSession, runSessionHost } from "../packages/cli/src/bridge/session-host.ts";
import { startDaemon, waitFor } from "./helpers.ts";

// A Claude Code session started in the background (`claude --bg`, no terminal attached) still registers
// an Agent; on the Agents page it looked like a stale record nobody could find. Mark it.

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const table: Record<number, { ppid: number; command: string }> = {
  100: { ppid: 50, command: "claude" },
  50: { ppid: 1, command: "claude --bg-pty-host /tmp/cc-daemon-501/abc" },
  200: { ppid: 60, command: "claude" },
  60: { ppid: 40, command: "-zsh" },
  40: { ppid: 1, command: "/Applications/iTerm.app/Contents/MacOS/iTerm2" },
  // A command that merely mentions the flag (a grep, a script) is not the background host.
  300: { ppid: 70, command: "node -e pgrep -f -- --bg-pty-host" },
  70: { ppid: 1, command: "-zsh" },
  400: { ppid: 80, command: "claude" },
  80: { ppid: 1, command: "/Users/me/.local/bin/claude --bg-pty-host /tmp/cc-daemon-501/x" },
  // The npm install runs the native binary claude.exe (seen live on macOS).
  500: { ppid: 90, command: "/u/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe" },
  90: { ppid: 1, command: "/u/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --bg-pty-host /tmp/cc-daemon-501/p.sock 23 42 -- /u/claude.exe" },
};
const read = (pid: number) => table[pid];

describe("background Claude Code sessions", () => {
  it("recognises a session whose process tree contains the background pty host", () => {
    expect(isBackgroundSession(100, read)).toBe(true);
    expect(isBackgroundSession(200, read)).toBe(false);
    expect(isBackgroundSession(999, read)).toBe(false);
    expect(isBackgroundSession(300, read)).toBe(false);
    expect(isBackgroundSession(400, read)).toBe(true);
    expect(isBackgroundSession(500, read)).toBe(true);
    expect(isBackgroundSession(100, () => { throw new Error("ps failed"); })).toBe(false);
  });

  it("registers the Agent as background so the Agents page can say so", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const dir = mkdtempSync(join(tmpdir(), "cafe-bg-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".cafe"), "name: bgsession\ndescription: runs in the background\n");
    const host = await runSessionHost({ agent: "claude", dir, daemon: root.addr, pid: 4242, background: true, send: () => {}, log: () => {} });
    cleanup.push(host.stop);
    await waitFor(() => root.daemon.registry.all().some((a) => a.name === "bgsession"));
    expect(root.daemon.registry.all().find((a) => a.name === "bgsession")).toMatchObject({ background: true, pid: 4242 });

    // `cafe agents` says "bg" where a terminal session says "tui".
    const bin = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
    const stdout = await new Promise<string>((ok) => {
      const p = spawn(process.execPath, [bin, "agents"], { env: { ...process.env, CAFE_HOME: root.home, CAFE_DAEMON: root.addr, CAFE_TOKEN: "t0k" } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => ok(out));
    });
    expect(stdout).toMatch(/claude·bg\s+bgsession/);
  }, 20_000);
});
