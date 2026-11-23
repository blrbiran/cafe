import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startDaemon } from "./helpers.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

it("reports only safe local connector status and requires current, fresh Discord readiness", async () => {
  const d = await startDaemon("connector-view");
  cleanup.push(d.stop);
  const get = async () => {
    const res = await fetch(`http://${d.addr}/api/connectors`);
    expect(res.status).toBe(200);
    return res.json();
  };
  expect(await get()).toEqual([]);

  const data = join(d.home, "connector-data", "discord");
  mkdirSync(join(d.home, "connectors", "discord"), { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(d.home, "logs"), { recursive: true });
  const log = join(d.home, "logs", "connector-discord.log");
  const now = Date.now();
  const pid = process.pid;
  const saveRun = (status: string, childPid = pid) => writeFileSync(join(data, "run.json"), JSON.stringify({ status, pid, childPid, startedAt: now - 120_000, lastError: "private diagnostic" }));
  const beat = (at: number, connection: string, childPid = pid) => ({ type: "heartbeat", at, pid: childPid, ok: true, connection });
  const saveLog = (...values: unknown[]) => writeFileSync(log, values.map((v) => JSON.stringify(v)).join("\n") + "\n");
  writeFileSync(join(data, "config.json"), JSON.stringify({ token: "private credential" }));

  saveRun("running");
  saveLog(beat(now, "connected", pid + 1));
  expect(await get()).toEqual([{ name: "discord", state: "connecting" }]);
  saveLog(beat(now - 90_000, "connected"));
  expect(await get()).toEqual([{ name: "discord", state: "disconnected" }]);
  saveLog({ ...beat(now - 90_000, "connected"), intervalMs: 120_000 });
  expect(await get()).toEqual([{ name: "discord", state: "connected" }]);
  saveLog({ type: "heartbeat", at: now, ok: true });
  expect(await get()).toEqual([{ name: "discord", state: "running" }]);
  saveLog(beat(now, "connected"), { type: "error", message: "private diagnostic" });
  expect(await get()).toEqual([{ name: "discord", state: "connected" }]);
  saveLog(beat(now, "connected"), beat(now, "disconnected"));
  expect(await get()).toEqual([{ name: "discord", state: "disconnected" }]);
  saveRun("stopped");
  expect(await get()).toEqual([{ name: "discord", state: "stopped" }]);
});
