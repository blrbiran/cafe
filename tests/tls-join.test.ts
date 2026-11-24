import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startDaemon, waitFor } from "./helpers.ts";

/**
 * v4-6 §10.3 (dogfooding #79 #80): `root:` is the Root's main address — the one people type. A child
 * must join the network over TLS from it, must never fall back to a plaintext uplink, and every Daemon
 * address it learns must name the TLS endpoint.
 *
 * Own file: a TLS child adds the network CA to the process-wide trust store.
 */
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const TLS = { security: { mode: "tls", tls: { port: 0 } } };
const FAST_ENROL = { enrolRetryBaseMs: 100, enrolRetryMaxMs: 400 };

function home(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `cafe-join-${tag}-`));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const pins = (h: string) => (parse(readFileSync(join(h, "config.yml"), "utf8")) as any).security?.tls?.pins ?? {};

describe("joining a TLS network by the Root's main address (#79)", () => {
  it("enrols from the main address and connects over wss to the Root's TLS port", async () => {
    const rootHome = home("root");
    const root = await startDaemon("jroot", { home: rootHome, mode: "root", config: TLS });
    cleanup.push(root.stop);
    const childHome = home("child");
    const child = await startDaemon("jchild", { home: childHome, config: { ...TLS, root: root.addr } });
    cleanup.push(child.stop);

    await waitFor(() => child.daemon.rootOnline, 15_000);
    expect(readFileSync(join(childHome, "tls", "ca.crt"), "utf8")).toBe(readFileSync(join(rootHome, "tls", "ca.crt"), "utf8"));
    expect(child.daemon.tlsStatus()).toMatchObject({ mode: "tls", network: true });
    // The uplink went over TLS: only a wss dial records a leaf-key pin, keyed by the TLS port dialled.
    expect(Object.keys(pins(childHome))).toContain(`127.0.0.1:${root.server.tlsPort}`);
  }, 40_000);

  it("never dials the Root in plaintext while it cannot enrol", async () => {
    // A Root with TLS off answers /api/tls without a CA: the child cannot join a TLS network there.
    const root = await startDaemon("plainroot", { mode: "root" });
    cleanup.push(root.stop);
    const childHome = home("closed");
    const child = await startDaemon("closedchild", { home: childHome, config: { ...TLS, root: root.addr }, timing: FAST_ENROL });
    cleanup.push(child.stop);

    await new Promise((r) => setTimeout(r, 1500));
    expect(child.daemon.rootOnline).toBe(false);
    expect(root.daemon.daemons().some((d) => d.host === "closedchild")).toBe(false);
    const status = child.daemon.tlsStatus();
    expect(status.network).toBe(false);
    expect(status.waiting).toMatch(/TLS disabled/);
    const doctor = child.daemon.doctor();
    expect(doctor.checks.find((c) => c.name === "tls")).toMatchObject({ level: "fail" });
  }, 30_000);

  it("joins without a restart once a Root comes up on the main address it was given", async () => {
    const mainPort = await freePort();
    const childHome = home("late");
    const child = await startDaemon("latejoin", { home: childHome, config: { ...TLS, root: `127.0.0.1:${mainPort}` }, timing: FAST_ENROL });
    cleanup.push(child.stop);
    expect(child.daemon.rootOnline).toBe(false);
    expect(existsSync(join(childHome, "tls", "ca.crt"))).toBe(false);

    const root = await startDaemon("lateroot2", { mode: "root", config: { ...TLS, port: mainPort } });
    cleanup.push(root.stop);
    await waitFor(() => child.daemon.rootOnline, 15_000);
    expect(child.daemon.tlsStatus().network).toBe(true);
    expect(Object.keys(pins(childHome))).toContain(`127.0.0.1:${root.server.tlsPort}`);
  }, 40_000);

  it("still accepts a root: that names the TLS port (configs written before this change)", async () => {
    const root = await startDaemon("tlsportroot", { mode: "root", config: TLS });
    cleanup.push(root.stop);
    const child = await startDaemon("tlsportchild", { home: home("tlsport"), config: { ...TLS, root: `127.0.0.1:${root.server.tlsPort}` } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 15_000);
    expect(child.daemon.tlsStatus().network).toBe(true);
  }, 40_000);
});

describe("Daemon addresses carry TLS on an enrolled network (#80)", () => {
  it("advertises wss://<host>:<tls port>, and children learn TLS addresses for direct links", async () => {
    const root = await startDaemon("aroot", { mode: "root", config: TLS });
    cleanup.push(root.stop);
    const h1 = home("a1");
    const c1 = await startDaemon("achild1", { home: h1, config: { ...TLS, root: root.addr } });
    cleanup.push(c1.stop);
    const c2 = await startDaemon("achild2", { home: home("a2"), config: { ...TLS, root: root.addr } });
    cleanup.push(c2.stop);
    await waitFor(() => c1.daemon.rootOnline && c2.daemon.rootOnline, 15_000);

    expect(root.daemon.url()).toBe(`wss://127.0.0.1:${root.server.tlsPort}`);
    expect(c2.daemon.url()).toBe(`wss://127.0.0.1:${c2.server.tlsPort}`);
    await waitFor(() => (c1.daemon.peerUrlFor("achild2") ?? "").startsWith("wss://"), 10_000);
    expect(c1.daemon.peerUrlFor("achild2")).toBe(`wss://127.0.0.1:${c2.server.tlsPort}`);

    // A direct link goes over TLS and is pinned by the TLS endpoint.
    await (c1.daemon as any).link("achild2");
    expect(Object.keys(pins(h1))).toContain(`127.0.0.1:${c2.server.tlsPort}`);
  }, 50_000);

  it("upgrades a plaintext address (a hand-set pin, an older Daemon) instead of dialling it in plaintext", async () => {
    const root = await startDaemon("uroot", { mode: "root", config: TLS });
    cleanup.push(root.stop);
    const h1 = home("u1");
    const c1 = await startDaemon("uchild1", { home: h1, config: { ...TLS, root: root.addr } });
    cleanup.push(c1.stop);
    const c2 = await startDaemon("uchild2", { home: home("u2"), config: { ...TLS, root: root.addr } });
    cleanup.push(c2.stop);
    await waitFor(() => c1.daemon.rootOnline && c2.daemon.rootOnline, 15_000);

    (c1.daemon as any).peerUrls.set("uchild2", `ws://${c2.addr}`);
    (c1.daemon as any).links.get("uchild2")?.ws.close();
    (c1.daemon as any).links.delete("uchild2");
    await (c1.daemon as any).link("uchild2");
    expect(Object.keys(pins(h1))).toContain(`127.0.0.1:${c2.server.tlsPort}`);
  }, 50_000);
});

describe("TLS diagnosis (#81A)", () => {
  it("reports TLS state in the daemon's health checks", async () => {
    const root = await startDaemon("droot", { mode: "root", config: TLS });
    cleanup.push(root.stop);
    const tls = root.daemon.doctor().checks.find((c) => c.name === "tls");
    expect(tls?.level).toBe("ok");
    expect(tls?.detail).toContain(`:${root.server.tlsPort}`);
    expect(tls?.detail).toMatch(/leaf valid \d+ more days/);

    const plain = await startDaemon("dplain", { mode: "root" });
    cleanup.push(plain.stop);
    expect(plain.daemon.doctor().checks.find((c) => c.name === "tls")).toMatchObject({ level: "warn", detail: expect.stringMatching(/TLS is off/) });

    const health = await fetch(`http://${root.addr}/api/health`).then((r) => r.json());
    expect(health.tls).toMatchObject({ mode: "tls", network: true, port: root.server.tlsPort });
  }, 30_000);
});
