import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@cafe/protocol";
import { tlsLine } from "../packages/cli/src/tls-line.ts";
import { startDaemon, waitFor } from "./helpers.ts";

/**
 * #93: one refused plaintext handshake (a probe, a machine that was since renamed or retired) kept
 * `cafe doctor` failing forever, and `cafe daemon status` never mentioned it. A refusal now ages: a
 * Host still trying stays a failure, one that stopped trying is a warning with the time, and it is
 * forgotten after a day.
 *
 * Own file: a TLS Daemon adds its CA to the process-wide trust store.
 */
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const TLS = { security: { mode: "tls", tls: { port: 0 } } };
const AGES = { refusedRecentMs: 400, refusedForgetMs: 1_200 };

function plaintextUplink(addr: string, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${addr}/ws`);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, token: "t0k", kind: "daemon", host, url: "ws://127.0.0.1:1" } })));
    ws.on("message", () => {
      ws.close();
      resolve();
    });
    ws.on("error", reject);
  });
}

const linksCheck = (d: { daemon: { doctor(): { ok: boolean; checks: Array<{ name: string; level: string; detail: string; next?: string }> } } }) =>
  d.daemon.doctor().checks.find((c) => c.name === "tls-links");

describe("refused plaintext links age out (#93)", () => {
  it("fails while the Host keeps trying, warns once it stopped, and forgets it after a day", async () => {
    const root = await startDaemon("ageroot", { mode: "root", config: TLS, timing: AGES });
    cleanup.push(root.stop);
    await plaintextUplink(root.addr, "fake-plain");

    expect(linksCheck(root)).toMatchObject({ level: "fail" });
    expect(root.daemon.tlsStatus().refused).toEqual([expect.objectContaining({ host: "fake-plain", recent: true })]);

    // It stopped trying: a warning that says when, and doctor as a whole is no longer failing.
    await new Promise((r) => setTimeout(r, AGES.refusedRecentMs + 100));
    const old = linksCheck(root);
    expect(old?.level).toBe("warn");
    expect(old?.detail).toContain("fake-plain");
    expect(old?.detail).toMatch(/ago/);
    expect(old?.next).not.toMatch(/^on each/);
    expect(root.daemon.doctor().ok).toBe(true);

    // After the forget window it is gone, and so is the record the refusal alone had created.
    await new Promise((r) => setTimeout(r, AGES.refusedForgetMs));
    expect(root.daemon.tlsStatus().refused).toBeUndefined();
    expect(linksCheck(root)).toMatchObject({ level: "ok" });
    expect(root.daemon.daemons().some((d) => d.host === "fake-plain")).toBe(false);
  }, 30_000);

  it("a Host that keeps retrying stays a failure", async () => {
    const root = await startDaemon("retryroot", { mode: "root", config: TLS, timing: AGES });
    cleanup.push(root.stop);
    const until = Date.now() + AGES.refusedRecentMs * 2;
    while (Date.now() < until) {
      await plaintextUplink(root.addr, "still-plain");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(linksCheck(root)).toMatchObject({ level: "fail" });
    await waitFor(() => root.daemon.tlsStatus().refused?.[0]?.recent === true);
  }, 30_000);
});

describe("cafe daemon status says what doctor says (#93)", () => {
  const now = 1_800_000_000_000;
  it("names a Host that is still being refused", () => {
    expect(tlsLine({ mode: "tls", port: 4778, network: true, refused: [{ host: "ssh1", kind: "daemon", at: now - 30_000, recent: true }] }, now)).toMatch(/refusing plaintext links from ssh1/);
  });
  it("names an old refusal with its age, not as a current problem", () => {
    const line = tlsLine({ mode: "tls", port: 4778, network: true, refused: [{ host: "fake-plain", kind: "daemon", at: now - 29 * 60_000, recent: false }] }, now);
    expect(line).toContain("fake-plain");
    expect(line).toContain("29m ago");
    expect(line).not.toMatch(/refusing/);
  });
  it("stays short when nothing was refused", () => {
    expect(tlsLine({ mode: "tls", port: 4778, network: true }, now)).toBe("on :4778 (daemon links use wss)");
  });
});
