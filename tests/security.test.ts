import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { startDaemon } from "./helpers.ts";

// Browser-facing protections (#65): a loopback request must not be usable by an arbitrary web page
// (CSRF) and must not be readable through DNS rebinding. CLI/MCP traffic has no Origin and keeps working.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

interface RawResponse {
  status: number;
  body: string;
}

/** A request whose Host/Origin headers can be chosen freely (fetch refuses to set Host). */
function raw(addr: string, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  const [host, port] = addr.split(":");
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: Number(port), method: opts.method ?? "GET", path: opts.path, headers: { host: `${host}:${port}`, ...opts.headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function wsHandshake(addr: string, origin?: string): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${addr}/ws`, origin ? { origin } : {});
    const done = (r: "open" | "rejected") => {
      clearTimeout(t);
      try {
        ws.terminate();
      } catch {
        // already closed
      }
      resolve(r);
    };
    const t = setTimeout(() => done("rejected"), 2000);
    ws.on("open", () => done("open"));
    ws.on("error", () => done("rejected"));
    ws.on("unexpected-response", () => done("rejected"));
  });
}

describe("browser-facing auth (#65)", () => {
  it("rejects a cross-site write carrying an Origin and does not create a Thread", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const res = await raw(d.addr, {
      method: "POST",
      path: "/api/orders",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ body: "csrf probe" }),
    });
    expect(res.status).toBe(403);
    expect(d.daemon.store.listThreads(10)).toHaveLength(0);
  });

  it("rejects a DNS-rebinding Host header on a loopback read", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const [host, port] = d.addr.split(":");
    const bad = await raw(d.addr, { path: "/api/threads?limit=1", headers: { host: "evil.example" } });
    expect(bad.status).toBe(403);
    const good = await raw(d.addr, { path: "/api/threads?limit=1", headers: { host: `${host}:${port}` } });
    expect(good.status).toBe(200);
  });

  it("allows the Web UI's own same-origin write", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const res = await raw(d.addr, {
      method: "POST",
      path: "/api/orders",
      headers: { origin: `http://${d.addr}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "hello", to: "nobody" }),
    });
    // 200 or a routing error, but never a CSRF rejection.
    expect(res.status).not.toBe(403);
  });

  it("allows CLI traffic without an Origin", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const res = await raw(d.addr, { path: "/api/health" });
    expect(res.status).toBe(200);
  });

  it("rejects a cross-origin WebSocket upgrade", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    expect(await wsHandshake(d.addr, "https://evil.example")).toBe("rejected");
    expect(await wsHandshake(d.addr, `http://${d.addr}`)).toBe("open");
  });
});

describe("/api/baristas only starts cafe's own agents (#65)", () => {
  it("rejects an arbitrary executable or extra argv", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const post = (body: Record<string, unknown>) =>
      raw(d.addr, { method: "POST", path: "/api/baristas", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const shell = await post({ dir: "/tmp", bin: "/bin/sh", args: ["-c", "id"] });
    expect(shell.status).toBe(400);
    const args = await post({ dir: "/tmp", agent: "codex", args: ["--dangerous"] });
    expect(args.status).toBe(400);
    const bogus = await post({ dir: "/tmp", agent: "sh" });
    expect(bogus.status).toBe(400);
    const noDir = await post({ agent: "codex" });
    expect(noDir.status).toBe(400);
  });
});