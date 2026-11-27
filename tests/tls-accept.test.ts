import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@cafe/protocol";
import { startDaemon, waitFor } from "./helpers.ts";
import { startEnrolledChild } from "./tls-helpers.ts";

/**
 * Dogfooding #89: fail-closed must hold on the accepting side too. A Daemon with TLS on refuses a
 * Daemon↔Daemon handshake (a child's uplink, a direct link) that arrives on its plaintext port, says why
 * and what to do, and shows the refused Host instead of marking it online. Browsers and local tools
 * (kind `ui`, Agents) still use the plaintext port.
 *
 * Own file: a TLS Daemon adds its CA to the process-wide trust store.
 */
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const TLS = { security: { mode: "tls", tls: { port: 0 } } };

/** One raw `initialize` over the plaintext port; resolves with the response frame. */
function initialize(addr: string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${addr}/ws`);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, token: "t0k", ...params } })));
    ws.on("message", (d) => {
      resolve(JSON.parse(d.toString()));
      ws.close();
    });
    ws.on("error", reject);
  });
}

describe("a TLS Daemon refuses plaintext Daemon links (#89)", () => {
  it("refuses a plaintext child's uplink, tells the child why, and reports the Host", async () => {
    const root = await startDaemon("troot", { mode: "root", config: TLS });
    cleanup.push(root.stop);
    const childLog: string[] = [];
    const child = await startDaemon("pchild", { config: { root: root.addr }, log: (l: string) => childLog.push(l) });
    cleanup.push(child.stop);

    await waitFor(() => childLog.some((l) => l.includes("tls_required") || /requires TLS/.test(l)), 10_000);
    expect(childLog.join("\n")).toMatch(/upgrade|security\.mode/i);
    expect(child.daemon.rootOnline).toBe(false);
    // Shown as a refused Host (offline, with the reason), not silently missing and never online.
    expect(root.daemon.daemons().find((d) => d.host === "pchild")).toMatchObject({ online: false, url: "", refused: { reason: "plaintext" } });

    // The Root shows the refused Host and doctor names it.
    expect(root.daemon.tlsStatus()).toMatchObject({ refused: [expect.objectContaining({ host: "pchild" })] });
    const check = root.daemon.doctor().checks.find((c) => c.name === "tls-links");
    expect(check).toMatchObject({ level: "fail" });
    expect(check?.detail).toContain("pchild");
  }, 30_000);

  it("refuses a plaintext direct link (kind peer) but still serves a local UI", async () => {
    const d = await startDaemon("tpeer", { config: TLS });
    cleanup.push(d.stop);
    const peer = await initialize(d.addr, { kind: "peer", host: "sneaky", url: "ws://127.0.0.1:1" });
    expect(peer.error).toMatchObject({ code: "tls_required" });
    expect(peer.error?.message).toContain(String(d.server.tlsPort));

    const ui = await initialize(d.addr, { kind: "ui" });
    expect(ui.error).toBeUndefined();
    expect(ui.result).toMatchObject({ host: "tpeer" });
  }, 30_000);

  it("a plaintext Daemon still accepts plaintext links (nothing to refuse)", async () => {
    const d = await startDaemon("plainpeer");
    cleanup.push(d.stop);
    const peer = await initialize(d.addr, { kind: "peer", host: "friend", url: "ws://127.0.0.1:1" });
    expect(peer.error).toBeUndefined();
  }, 30_000);
});

describe("a refused Host that comes back over TLS (#89)", () => {
  it("drops the refusal once the same Host joins over wss", async () => {
    const root = await startDaemon("troot2", { mode: "root", config: TLS });
    cleanup.push(root.stop);
    const plain = await startDaemon("flipper", { config: { root: root.addr } });
    await waitFor(() => !!root.daemon.daemons().find((d) => d.host === "flipper")?.refused, 10_000);
    await plain.stop();
    const tls = await startEnrolledChild(root, "flipper", {});
    cleanup.push(tls.stop);
    await waitFor(() => root.daemon.daemons().find((d) => d.host === "flipper")?.online === true, 15_000);
    expect(root.daemon.daemons().find((d) => d.host === "flipper")?.refused).toBeUndefined();
    expect(root.daemon.tlsStatus().refused).toBeUndefined();
    expect(root.daemon.doctor().checks.find((c) => c.name === "tls-links")).toMatchObject({ level: "ok" });
  }, 40_000);
});
