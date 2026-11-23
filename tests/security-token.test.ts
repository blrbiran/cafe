import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { startDaemon } from "./helpers.ts";

/**
 * Remote authentication (v4-6 §3.6): the token comes from `Authorization: Bearer` only. A `?token=`
 * query string puts the secret into logs, shell history and every proxy in between.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

function remote(addr: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const port = Number(addr.split(":")[1]);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers,
        // A non-loopback source address is what makes `remote` real: the Daemon skips the token for
        // loopback, so bind the socket explicitly to the machine's LAN interface when there is one.
        localAddress: lanLocalAddress(),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** An address that is not loopback, so the Daemon applies token auth. Falls back to loopback when
 *  the machine has no LAN interface (then the loopback exemption makes the assertion moot and the
 *  test says so). */
function lanLocalAddress(): string | undefined {
  const nets = require("node:os").networkInterfaces() as Record<string, Array<{ family: string; internal: boolean; address: string }>>;
  for (const list of Object.values(nets)) for (const ni of list ?? []) if (ni.family === "IPv4" && !ni.internal) return ni.address;
  return undefined;
}

describe("token authentication", () => {
  it("rejects ?token= on a non-loopback request and accepts Authorization: Bearer", async () => {
    const d = await startDaemon("auth", { config: { advertise: "127.0.0.1" } });
    cleanup.push(d.stop);
    // If this machine has no non-loopback interface, the Daemon would treat the request as loopback
    // and skip auth entirely; skip rather than assert the wrong thing.
    if (!lanLocalAddress()) return;

    const viaQuery = await remote(d.addr, "/api/health?token=t0k");
    expect(viaQuery.status).toBe(401);

    const viaHeader = await remote(d.addr, "/api/health", { authorization: "Bearer t0k" });
    expect(viaHeader.status).toBe(200);

    const wrong = await remote(d.addr, "/api/health", { authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);
  }, 30_000);
});