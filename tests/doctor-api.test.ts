import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { startDaemon } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

interface Check {
  name: string;
  level: "ok" | "warn" | "fail";
  detail: string;
  next?: string;
}

async function doctor(addr: string): Promise<{ ok: boolean; checks: Check[] }> {
  const res = await fetch(`http://${addr}/api/doctor`);
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; checks: Check[] };
}

describe("GET /api/doctor", () => {
  it("reports the machine's health and the next command to run", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    const body = await doctor(d.addr);
    expect(body.ok).toBe(true);
    expect(body.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["daemon", "router", "root", "config"]));
    expect(body.checks.find((c) => c.name === "root")).toMatchObject({ level: "ok" });
    expect(body.checks.find((c) => c.name === "config")).toMatchObject({ level: "ok" });
  });

  it("points at cafe daemon restart for a restart-required change", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    writeFileSync(join(d.home, "config.yml"), stringify({ host: "pc1", token: "t0k", port: 0, advertise: "127.0.0.1", mode: "root" }));
    const body = await doctor(d.addr);
    expect(body.ok).toBe(true);
    expect(body.checks.find((c) => c.name === "config")).toMatchObject({ level: "warn", next: "cafe daemon restart" });
  });
});