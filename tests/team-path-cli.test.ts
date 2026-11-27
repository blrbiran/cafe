import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startDaemon } from "./helpers.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

it("grants only the declared external directory and lists the canonical grant", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "cafe-team-path-cli-"));
  cleanup.push(() => rmSync(fixture, { recursive: true, force: true }));
  const roster = join(fixture, "roster");
  const workspace = join(fixture, "workspace");
  const other = join(fixture, "other");
  for (const dir of [roster, workspace, other]) mkdirSync(dir);
  writeFileSync(join(roster, ".cafe"), "name: cafe-team\nteam:\n  members:\n    - name: lead\n      duty: orchestrator\n      dir: ../workspace\n");
  const d = await startDaemon("grant-cli");
  cleanup.push(d.stop);
  const cli = (...args: string[]) => new Promise<{ exit: number | null; output: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../packages/cli/bin/cafe.js"), ...args], {
      env: { ...process.env, CAFE_HOME: d.home, CAFE_DAEMON: d.addr },
    });
    let output = "";
    child.stdout.on("data", (buf) => { output += buf; });
    child.on("error", reject);
    child.on("close", (exit) => done({ exit, output }));
  });
  expect((await fetch(`http://${d.addr}/api/team-paths`)).status).toBe(403);
  expect((await cli("team", "trust-path", roster, "lead", other)).exit).toBe(1);
  expect((await cli("team", "trust-path", roster, "lead", workspace)).exit).toBe(0);
  const listed = await cli("team", "paths", roster, "--json");
  expect(listed.exit).toBe(0);
  expect(JSON.parse(listed.output)).toMatchObject([{ member: "lead", target: realpathSync(workspace), state: "active" }]);
});
