import { Agent, request } from "node:https";

/**
 * A tiny HTTPS GET that trusts exactly one CA. Used by the TLS tests instead of the global `fetch`
 * so each request can carry a different CA without touching process-wide state. Node's default
 * `checkServerIdentity` (SAN verification) is left in place: passing `ca` only changes which roots
 * are trusted, not whether the hostname is checked.
 */
export function httpsRequest(opts: { host: string; port: number; path: string; ca: string; servername?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        method: "GET",
        ca: opts.ca,
        // No SNI for a bare IP; use the DNS name when one is given.
        servername: opts.servername ?? (/\d+\.\d+\.\d+\.\d+/.test(opts.host) ? undefined : opts.host),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A `node:https` Agent that trusts one CA, for client-side tests. */
export function caAgent(ca: string): Agent {
  return new Agent({ ca });
}