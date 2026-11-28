import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";
import { X509Certificate } from "node:crypto";
import { discoverTls } from "../../daemon/src/tls/bootstrap.ts";
import { fingerprintOf, hostIdFromCertificate } from "../../daemon/src/tls/certs.ts";
import { normalizeFingerprint } from "../../daemon/src/tls/trust.ts";

export type DaemonRequest = (path: string, init?: RequestInit) => Promise<Response>;

export function isLoopbackDaemon(endpoint: URL): boolean {
  const hostname = endpoint.hostname;
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

export async function pinnedRootRequest(endpoint: URL, pins: { caPath: string; caFingerprint?: string; rootHostId?: string }): Promise<DaemonRequest> {
  const fingerprint = pins.caFingerprint && normalizeFingerprint(pins.caFingerprint);
  if (!fingerprint || !pins.rootHostId) throw new Error("tls_required: enroll this Host with the Root to pin its CA and Host ID before connecting remotely");
  let ca: string;
  try {
    ca = readFileSync(pins.caPath, "utf8");
  } catch (err) {
    throw new Error("tls_required: the pinned Root CA file is unavailable", { cause: err });
  }
  if (normalizeFingerprint(fingerprintOf(ca)) !== fingerprint) throw new Error("tls_required: the local CA does not match the pinned Root fingerprint");
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("invalid Cafe Daemon endpoint");
  if (endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("CAFE_DAEMON must be a Host and port without credentials or a path");
  }
  const origin = new URL(endpoint.origin);
  if (origin.protocol === "http:") {
    const hinted = await discoverTls(`${origin.hostname}:${origin.port || "80"}`, { ca });
    if (!Number.isInteger(hinted.tlsPort) || hinted.tlsPort < 1 || hinted.tlsPort > 65535) throw new Error("invalid Root TLS port");
    origin.protocol = "https:";
    origin.port = String(hinted.tlsPort);
  }

  return (path, init = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) throw new Error("daemon request must stay on the pinned Root");
    const headers = new Headers(init.headers);
    const body = init.body;
    if (body != null && typeof body !== "string" && !(body instanceof Uint8Array)) throw new TypeError("unsupported daemon request body");
    if (body != null && !headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(body)));
    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(url, {
        ca, agent: false, method: init.method, signal: init.signal ?? undefined, headers: Object.fromEntries(headers),
        checkServerIdentity(host, certificate) {
          const invalidName = checkServerIdentity(host, certificate);
          if (invalidName) return invalidName;
          if (hostIdFromCertificate(new X509Certificate(certificate.raw).toString()) !== pins.rootHostId) {
            return new Error("TLS certificate does not match the pinned Root Host ID");
          }
        },
      }, (res) => {
        const status = res.statusCode ?? 500;
        if (status >= 300 && status < 400 && status !== 304) {
          res.resume();
          reject(new Error("the pinned Root returned a redirect"));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(name, item);
        }
        const noBody = init.method === "HEAD" || status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
      req.once("error", reject);
      req.end(body ?? undefined);
    });
  };
}
