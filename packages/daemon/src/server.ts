import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSecureContext, type SecureContext } from "node:tls";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { networkInterfaces } from "node:os";
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import { WebSocketServer } from "ws";
import { CreateOrderParams, Methods, type ThreadEnvelope } from "@cafe/protocol";
import { RpcError } from "@cafe/protocol/peer";
import type { Daemon } from "./daemon.ts";
import { homeId, loadConfig, saveConfig } from "./config.ts";
import { eventMatches, parseEventFilter, replayAfter } from "./events.ts";
import { listRouterModels } from "./router.ts";
import { connectorStatuses } from "./connector-status.ts";

/** pi's model catalogue is expensive to build; settings can ask for it repeatedly. */
let modelCache: { at: number; models: string[] } | undefined;
async function routerModels(search?: string): Promise<string[]> {
  if (!modelCache || Date.now() - modelCache.at > 60_000) {
    modelCache = { at: Date.now(), models: await listRouterModels() };
  }
  const q = search?.toLowerCase();
  return q ? modelCache.models.filter((m) => m.toLowerCase().includes(q)) : modelCache.models;
}

/** Barista kinds `cafe barista start --agent` accepts; anything else (a raw `bin`) is refused (#65). */
const AGENT_NAMES = ["pi", "omp", "codex", "claude"] as const;

/**
 * The UI is a local app: nothing loads from elsewhere, styles are Tailwind classes plus a few inline
 * ones, and the WebSocket is same-origin. `ws:`/`wss:` keep the live stream working over either (#69).
 */
const CSP = "default-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/** The built web UI: from the installed `@cafe/web` package, else the sibling workspace package. */
export function defaultWebDist(): string {
  // Published package: dist/cli.js, with the web build in ../web.
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  if (existsSync(join(bundled, "index.html"))) return bundled;
  try {
    return join(dirname(fileURLToPath(import.meta.resolve("@cafe/web/package.json"))), "dist");
  } catch {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  }
}

/** A static file: raw bytes, a gzip copy when that is smaller, and an ETag over the content (#69). */
interface StaticFile {
  body: Buffer;
  gz?: Buffer;
  type: string;
  etag: string;
}

/** Read the built web UI into memory once (flat, exact-match lookup; no path traversal). */
function loadStatic(dist: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  if (!existsSync(dist)) return files;
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}${name}/`);
        continue;
      }
      const body = readFileSync(full);
      const type = MIME[extname(name)] ?? "application/octet-stream";
      const gz = /^(text\/|application\/(javascript|json))/.test(type) && body.length > 1024 ? gzipSync(body) : undefined;
      files.set(`${prefix}${name}`, { body, ...(gz && gz.length < body.length ? { gz } : {}), type, etag: `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"` });
    }
  };
  walk(dist, "");
  return files;
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** `host:port`, `[::1]:port` and a bare IPv6 address all reduce to the host part. */
function hostOnly(host: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (v6) return v6[1]!;
  const withPort = /^([^:]+):\d+$/.exec(host);
  return (withPort ? withPort[1]! : host).toLowerCase();
}

/**
 * Hosts a browser may use to reach this daemon (#65). A page can only be trusted
 * when it came from one of these: a DNS-rebinding page arrives with its own
 * domain in `Host`, and an IP that belongs to this machine cannot be rebound.
 */
function allowedHosts(daemon: Daemon, fresh = false): Set<string> {
  if (hostCache?.daemon === daemon && !fresh) return hostCache.hosts;
  const hosts = new Set<string>(["localhost", "127.0.0.1", "::1", daemon.config.host.toLowerCase()]);
  const advertise = daemon.config.advertise;
  if (advertise) hosts.add(hostOnly(advertise));
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.address) hosts.add(ni.address.toLowerCase());
  }
  hostCache = { daemon, hosts };
  return hosts;
}
let hostCache: { daemon: Daemon; hosts: Set<string>; at?: number } | undefined;

/**
 * An address that came up after the cache was built (a VPN, a DHCP change) is ours too. Rebuild on a
 * miss, at most once a second, so an unknown Host cannot make every request walk the interfaces.
 */
function isOurHost(daemon: Daemon, host: string): boolean {
  if (allowedHosts(daemon).has(host)) return true;
  const now = Date.now();
  if (hostCache && hostCache.daemon === daemon && hostCache.at && now - hostCache.at < 1000) return false;
  const hosts = allowedHosts(daemon, true);
  hostCache!.at = now;
  return hosts.has(host);
}

function hostAllowed(req: IncomingMessage, daemon: Daemon): boolean {
  const raw = req.headers.host;
  // HTTP/1.1 requires Host; a missing one is not a browser we can vouch for.
  if (!raw) return false;
  return isOurHost(daemon, hostOnly(raw));
}

/**
 * A browser sends `Origin` on every cross-origin write, and a page cannot forge
 * it. A request from the console/CLI/MCP has no Origin at all, so it is allowed;
 * what must never pass is a page on some other site (CSRF, #65). Same-origin means
 * the Origin names exactly the scheme + host + port the request arrived on, not
 * merely a hostname this machine answers to (#65 follow-up).
 */
function originAllowed(req: IncomingMessage, daemon: Daemon): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const scheme = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  if (url.protocol !== `${scheme}:`) return false;
  if (url.host.toLowerCase() !== hostOnlyPort(host)) return false;
  // Belt and braces: a forged Host that is not one of ours still fails.
  return isOurHost(daemon, hostOnly(url.host.toLowerCase()));
}

/** `Host` header reduced to what an Origin must match: lowercase host:port, default port dropped. */
function hostOnlyPort(host: string): string {
  const lower = host.trim().toLowerCase();
  try {
    return new URL(`http://${lower}`).host;
  } catch {
    return lower;
  }
}

/**
 * A content-hashed asset name. Vite's hash is base64url-ish (`index-BZg5MLuf.js`,
 * `index-lV5otHzq.css`), not hex, so only the shape `-<8+ word chars>.<ext>` may be
 * assumed; anything else must be revalidated (#69).
 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

/** GET/HEAD change nothing; everything else can. */
function isWrite(method: string | undefined): boolean {
  return !!method && method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * The caller's token. Only `Authorization: Bearer` is accepted (v4-6 §3.6): a `?token=` parameter
 * ends up in logs, shell history and every proxy along the way.
 */
function tokenOf(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_LIMIT = 1000;
const THREAD_STATUSES = ["routing", "delivering", "working", "done", "failed", "cancelled"];

/** A page-size query parameter. SQLite treats LIMIT -1 as "no limit", so nothing invalid may reach it. */
function parseLimit(raw: string | null, def: number, opts: { zeroOk?: boolean } = {}): number {
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  const min = opts.zeroOk ? 0 : 1;
  if (!Number.isInteger(n) || n < min || n > MAX_LIMIT) throw new RpcError("bad_request", `invalid limit: expected integer in ${min}..${MAX_LIMIT}`);
  return n;
}

function parseBefore(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new RpcError("bad_request", "invalid before: expected a positive timestamp");
  return n;
}

function parseStatus(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (!THREAD_STATUSES.includes(raw)) throw new RpcError("bad_request", `invalid status: expected ${THREAD_STATUSES.join("|")}`);
  return raw;
}

/** Stream an upload to disk while hashing; never buffer the whole file. */
async function readUpload(req: IncomingMessage, dest: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
  const out = createWriteStream(dest);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > maxBytes) throw new RpcError("attachment_too_large", `file exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);
      hash.update(buf);
      out.write(buf);
    }
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    try {
      unlinkSync(dest);
    } catch {
      // already gone
    }
    throw err;
  }
  return { size, sha256: hash.digest("hex") };
}

/** Only real raster images keep their type; everything else is an opaque download. */
function artifactHeaders(a: { name: string; mime: string; size: number; sha256: string }): Record<string, string> {
  const type = /^image\/(png|jpeg|webp|gif)$/.test(a.mime) ? a.mime : "application/octet-stream";
  const name = a.name.replace(/["\r\n]/g, "_");
  return {
    "content-type": type,
    "content-length": String(a.size),
    "content-disposition": `attachment; filename="${name}"`,
    "x-content-type-options": "nosniff",
    "x-cafe-sha256": a.sha256,
    "cache-control": "private, max-age=0",
  };
}

/** Ring of recent events per daemon, for SSE Last-Event-ID resumption. */
const recentEvents = new WeakMap<Daemon, ThreadEnvelope[]>();

export interface ServerHandle {
  close(): Promise<void>;
  port: number;
  /** Port of the TLS listener (v4-6); undefined in `mode: plaintext`. */
  tlsPort?: number;
}

export interface TlsServerOptions {
  /** CA PEM used to verify peers; also the trust anchor advertised to clients. */
  ca: string;
  /**
   * The leaf to present. Called per new connection and per SNI, so a hot renewal takes effect
   * without a restart. Live connections keep theirs.
   */
  current(): { cert: string; key: string };
  /** Registers a callback the daemon calls after swapping in a renewed leaf. Returns an unsubscribe. */
  onRenew?(fn: () => void): () => void;
}

/**
 * Two listeners share one request handler (v4-6 §3.1): the plaintext port (4777) serves the Web UI
 * and loopback calls; the TLS port (4778) serves the same API and `/ws` for agents, the CLI,
 * connectors and other Daemons. There is no protocol sniffing and no plaintext fallback.
 */
export function startServer(daemon: Daemon, opts: { port: number; bind?: string; webDist?: string; tlsPort?: number; tls?: TlsServerOptions }): Promise<ServerHandle> {
  const webDir = opts.webDist ?? defaultWebDist();
  const statics = loadStatic(webDir);
  // The UI is read into memory at start; remember which build that was so the page can say
  // "restart the daemon" instead of silently serving old HTML/JS. Compare *content*, not mtime:
  // `build:web` is deterministic, so an unchanged rebuild rewrites the same bytes with a new mtime
  // and used to insist on a restart that changed nothing (#105).
  const indexHtml = join(webDir, "index.html");
  const digestOf = () => {
    try {
      return `"${createHash("sha1").update(readFileSync(indexHtml)).digest("hex").slice(0, 16)}"`;
    } catch {
      return undefined;
    }
  };
  const loadedStamp = statics.get("index.html")?.etag ?? digestOf();
  const webStale = () => {
    if (!loadedStamp) return false;
    const current = digestOf();
    return current !== undefined && current !== loadedStamp;
  };
  const wss = new WebSocketServer({ noServer: true });
  // A short ring of recent events, so an SSE client that reconnects with
  // Last-Event-ID resumes where it stopped instead of losing the gap.
  const recent: ThreadEnvelope[] = [];
  recentEvents.set(daemon, recent);
  const remember = (env: ThreadEnvelope) => {
    recent.push(env);
    if (recent.length > 500) recent.splice(0, recent.length - 500);
  };
  daemon.on("thread", remember);

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      // Any Host we do not answer to is a DNS-rebinding attempt (#65). Static files are included:
      // the page itself decides which API calls it makes, so a rebound page must not load at all.
      // Only loopback needs this: a non-loopback request still has to present the token.
      if (isLoopback(req) && !hostAllowed(req, daemon)) {
        return send(res, 403, { error: "forbidden_host", message: `this daemon does not answer to Host '${req.headers.host ?? ""}'` });
      }
      if (path.startsWith("/api/")) {
        // A cross-site page must not be able to write, even though the socket is loopback (#65).
        if (isWrite(req.method) && !originAllowed(req, daemon)) {
          return send(res, 403, { error: "forbidden_origin", message: "cross-site requests cannot change this daemon; use the Web UI or the CLI" });
        }
        // GET /api/tls is public: the CA certificate and the TLS port are what a joining Host needs
        // *before* it may send its token anywhere, and neither is secret (v4-6 §10.3).
        const publicTls = req.method === "GET" && path === "/api/tls";
        if (!publicTls && !isLoopback(req) && tokenOf(req) !== daemon.config.token) {
          return send(res, 401, { error: "unauthorized", message: "token mismatch or wrong Root address; compare `cafe config get token` on both hosts" });
        }
        return await api(daemon, req, res, url, webStale, recent);
      }
      // The CA as a file a phone or laptop can install to trust the TLS port's Web UI (v4-9). Public
      // like GET /api/tls: a CA certificate is not a secret; the key never leaves tls/ca.key.
      // Only once the Host is on the network: a temporary CA (Root unreachable) is replaced at enrolment.
      if (path === "/ca.crt" && (req.method === "GET" || req.method === "HEAD") && daemon.tlsContext?.network) {
        res.writeHead(200, {
          "content-type": "application/x-x509-ca-cert",
          "content-disposition": 'attachment; filename="cafe-ca.crt"',
          "cache-control": "no-cache",
        });
        return void res.end(req.method === "HEAD" ? undefined : daemon.tlsContext.ca);
      }
      const key = path === "/" ? "index.html" : path.slice(1);
      const file = statics.get(key);
      if (!file) {
        if (statics.size === 0 && path === "/") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end("cafe daemon is running. Web UI not built: run `npm run build:web`.\n");
        }
        return send(res, 404, { error: "not found" });
      }
      // The HTML names the entry script, so it must be revalidated. Only a content-hashed name can be
      // cached for a year: an unhashed file (`index.js`) keeps that name across releases (#69).
      const html = key.endsWith(".html");
      const hashed = HASHED_ASSET.test(key);
      const headers: Record<string, string> = {
        "content-type": file.type,
        etag: file.etag,
        "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
        vary: "accept-encoding",
      };
      if (html) headers["content-security-policy"] = CSP;
      if (req.headers["if-none-match"] === file.etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      const accepts = (req.headers["accept-encoding"] ?? "").toString();
      const useGzip = file.gz !== undefined && /\bgzip\b/.test(accepts);
      if (useGzip) headers["content-encoding"] = "gzip";
      res.writeHead(200, headers);
      res.end(useGzip ? file.gz! : file.body);
    } catch (err) {
      const e = err as RpcError;
      send(res, e.code === "not_found" ? 404 : e.code === "host_online" ? 409 : 400, { error: e.code ?? "error", message: e.message });
    }
  };

  const handleUpgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws") return socket.destroy();
    // A browser always sends Origin on a WebSocket handshake and cannot forge it; CLI clients send
    // none. Without this a page on any site could open the socket (loopback skips the token, #65).
    // Host matters for loopback only, exactly as on the HTTP side.
    if ((isLoopback(req) && !hostAllowed(req, daemon)) || !originAllowed(req, daemon)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const counts = daemon.streamCounts;
      counts.ws++;
      ws.on("close", () => (counts.ws = Math.max(0, counts.ws - 1)));
      // The same handler serves both listeners; only a socket from the TLS listener is encrypted (#89).
      daemon.accept(ws, isLoopback(req), (req.socket as { encrypted?: boolean }).encrypted === true);
    });
  };

  const server = createServer(handleRequest);
  server.on("upgrade", handleUpgrade);

  return new Promise((resolveP, reject) => {
    server.once("error", (err) => reject(portInUse(err, "port", opts.port)));
    server.listen(opts.port, opts.bind ?? "0.0.0.0", () => {
      const addr = server.address();
      const httpPort = typeof addr === "object" && addr ? addr.port : opts.port;
      const finish = (tlsServer?: import("node:https").Server, tlsPort?: number) => {
        resolveP({
          port: httpPort,
          ...(tlsPort !== undefined ? { tlsPort } : {}),
          close: () =>
            new Promise<void>((r) => {
              daemon.off("thread", remember);
              for (const c of wss.clients) c.terminate();
              wss.close();
              server.closeAllConnections();
              const closeTls = tlsServer
                ? new Promise<void>((done) => {
                    tlsServer.closeAllConnections();
                    tlsServer.close(() => done());
                  })
                : Promise.resolve();
              server.close(() => void closeTls.then(() => r()));
            }),
        });
      };
      if (!opts.tls) return finish();
      // A TLS listener that fails to bind (port taken, bad certificate) is a startup failure, not a
      // reason to fall back to plaintext.
      let tlsServer: import("node:https").Server;
      try {
        tlsServer = createTlsServer(opts.tls, handleRequest, handleUpgrade);
      } catch (err) {
        server.close();
        return reject(err);
      }
      tlsServer.once("error", (err) => {
        server.close();
        reject(portInUse(err, "security.tls.port", opts.tlsPort));
      });
      tlsServer.listen(opts.tlsPort ?? 0, opts.bind ?? "0.0.0.0", () => {
        const a = tlsServer.address();
        finish(tlsServer, typeof a === "object" && a ? a.port : opts.tlsPort ?? 0);
      });
    });
  });
}

/**
 * A bind failure in words the user can act on: which port, what it is for, and the setting that moves it
 * (a second Daemon on one machine collides on 4777 and the TLS port 4778).
 */
function portInUse(err: Error, key: "port" | "security.tls.port", port: number | undefined): Error {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") return err;
  const what = key === "port" ? "port" : "TLS port";
  const out = new Error(
    `${what} ${port} is already in use (another cafe daemon on this machine, or another program). ` +
      `Stop it, or give this CAFE_HOME its own: cafe config set ${key} <free port>` +
      (key === "security.tls.port" ? " (or security.mode: plaintext for a throwaway test daemon)" : ""),
  );
  (out as NodeJS.ErrnoException).code = "EADDRINUSE";
  return out;
}

/**
 * The `https` server. The leaf is read through `tls.current()` on every new connection and in
 * `SNICallback`, so a renewed leaf is used by new connections without a restart (v4-6 §3.5); live
 * connections keep the context they negotiated.
 */
function createTlsServer(
  tls: TlsServerOptions,
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  onUpgrade: (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void,
): import("node:https").Server {
  const leaf = () => tls.current();
  let current = createSecureContext(leaf());
  const server = createHttpsServer(
    {
      ...leaf(),
      ca: tls.ca,
      // No client certificate this round: agent identity/cert lifecycle is phase 2.
      requestCert: false,
      SNICallback: (_servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => {
        try {
          cb(null, current);
        } catch (err) {
          cb(err as Error);
        }
      },
    },
    onRequest,
  );
  /**
   * A renewed leaf becomes the context used by new connections. `setSecureContext` swaps the
   * default context `https` uses when the client sends no SNI (an IP dial sends none); a client that
   * does send SNI gets the same new context through `SNICallback`. Live connections keep the
   * context they negotiated, so renewal never interrupts them.
   */
  tls.onRenew?.(() => {
    const fresh = leaf();
    current = createSecureContext(fresh);
    server.setSecureContext(fresh);
  });
  server.on("upgrade", onUpgrade);
  // A plaintext client hitting the TLS port fails its handshake; do not let that kill the process.
  server.on("tlsClientError", (_err, socket) => (socket as { destroy(): void }).destroy());
  return server;
}

async function api(daemon: Daemon, req: IncomingMessage, res: ServerResponse, url: URL, webStale: () => boolean, recent: ThreadEnvelope[]): Promise<void> {
  const path = url.pathname;
  const m = req.method ?? "GET";
  let match: RegExpExecArray | null;

  if (m === "GET" && path === "/api/health") {
    const root = daemon.isRoot
      ? {}
      : { root: daemon.config.root, rootOnline: daemon.rootOnline, rootConnected: daemon.rootConnected, rootLastSeenAt: daemon.rootLastSeen };
    return send(res, 200, { ok: true, host: daemon.host, homeId: homeId(daemon.store.home), startedAt: daemon.startedAt, tls: daemon.tlsStatus(), isRoot: daemon.isRoot, pid: process.pid, version: daemon.version, draining: daemon.isDraining, ...root, ...daemon.routerStatus(), metrics: daemon.metrics() });
  }
  if (m === "GET" && path === "/api/router/models") {
    return send(res, 200, { models: await routerModels(url.searchParams.get("search") ?? undefined) });
  }
  if (m === "POST" && path === "/api/router") {
    const { model } = await readJson(req);
    if (model !== null && model !== undefined && typeof model !== "string") throw new RpcError("bad_request", "model must be a string or null");
    return send(res, 200, await daemon.setRouterModel(model ?? null));
  }
  if (m === "GET" && path === "/api/events/history") {
    const after = url.searchParams.get("after") ?? undefined;
    if (!after) return send(res, 200, { events: [], gap: false });
    const at = recent.findIndex((e) => e.eventId === after);
    return send(res, 200, at >= 0 ? { events: recent.slice(at + 1), gap: false } : { events: [], gap: true });
  }
  if (m === "GET" && path === "/api/events") return eventStream(daemon, url, req, res, recentEvents.get(daemon) ?? []);
  if (m === "GET" && path === "/api/snapshot") {
    const snap = daemon.snapshot();
    return send(res, 200, webStale() ? { ...snap, webStale: true } : snap);
  }
  if (m === "POST" && path === "/api/tls/renew") {
    // Reissue this Host's leaf and swap it for new connections. The Root signs locally; a child asks
    // its Root for a leaf over TLS (#91: adding a VPN address must not need a restart on either side).
    const ca = daemon.tlsContext;
    if (!ca?.renew) return send(res, 400, { error: "tls_off", message: "TLS is off (security.mode: plaintext)" });
    const body = await readJson(req);
    const sans = Array.isArray(body.sans) ? body.sans.filter((s: unknown): s is string => typeof s === "string" && !!s) : [];
    // `cafe daemon renew-cert --san` saved these to config.yml; the running daemon adopts them so its
    // own renewal check and `cafe doctor` keep naming them.
    if (Array.isArray(body.extra)) daemon.config.security.tls.sans = body.extra.filter((s: unknown): s is string => typeof s === "string" && !!s);
    // `renew` keeps the existing key and writes through to disk: a swap that only changed memory
    // would be undone by the next restart, which then serves the stale (possibly expiring) leaf.
    await ca.renew(sans.length ? sans : undefined);
    const current = ca.current();
    // Report the certificate's own fingerprint, the value `cafe daemon renew-cert` prints.
    const fp = new (await import("node:crypto")).X509Certificate(current.cert).fingerprint256;
    return send(res, 200, { ok: true, fingerprint256: fp });
  }
  if (m === "POST" && path === "/api/tls/pins") {
    // Clear one peer's leaf-key pin so the next connection pins its current key (a deliberate
    // reinstall, or a key that was replaced out of band). Pins are a hot setting: nothing the listener
    // owns changes, so no restart is needed.
    const { peer, clear } = await readJson(req);
    if (typeof peer !== "string" || !peer) throw new RpcError("bad_request", "peer is required (host:port)");
    if (clear !== true) throw new RpcError("bad_request", "only clearing a pin is supported; set clear: true");
    delete daemon.config.security.tls.pins[peer];
    saveConfig(daemon.config, daemon.store.home);
    return send(res, 200, { ok: true, peer, pins: daemon.config.security.tls.pins });
  }
  if (m === "GET" && path === "/api/tls") {
    // The trust anchor a person or a child Host needs to enrol: the CA and its fingerprint. Public
    // on purpose (a CA certificate is not a secret); the private key never appears here.
    return daemon.tlsContext
      ? send(res, 200, {
          ca: daemon.tlsContext.ca,
          fingerprint256: daemon.tlsContext.caFingerprint,
          ...(daemon.tlsPort ? { tlsPort: daemon.tlsPort } : {}),
          // The encrypted Web addresses the leaf names (v4-9); public like the rest of this answer, so
          // the token prompt can offer them before the person has a token.
          ...(daemon.webHttps() ? { web: daemon.webHttps() } : {}),
        })
      : send(res, 200, { ca: null, fingerprint256: null, note: "TLS is off (security.mode: plaintext)" });
  }
  if (m === "POST" && path === "/api/tls/leaf") {
    // A child Host with this network's token asks the Root to issue its leaf. Only the Root has the
    // CA key; every other Host gets a clear refusal instead of a fake certificate.
    if (!daemon.isRoot || !daemon.tlsContext?.issue) return send(res, 400, { error: "not_root", message: "only the Root issues leaf certificates; set security.tls.ca to the Root's ca.crt on this Host" });
    const issue = daemon.tlsContext.issue;
    const body = await readJson(req);
    const sans = Array.isArray(body.sans) ? body.sans.filter((s: unknown): s is string => typeof s === "string" && !!s) : [];
    if (!sans.length) throw new RpcError("bad_request", "sans must be a non-empty string array");
    const publicKey = typeof body.publicKey === "string" && body.publicKey.includes("PUBLIC KEY") ? body.publicKey : undefined;
    const issued = await issue(sans, publicKey);
    // A reissue for the caller's own key returns the certificate only: the Root must never send a
    // private key. The child keeps the key it already has.
    return send(res, 200, publicKey ? { cert: issued.cert } : issued);
  }
  if (m === "GET" && path === "/api/agents") return send(res, 200, daemon.registry.all());
  if (m === "POST" && path === "/api/host") {
    const { displayName, aliases, removeAliases } = await readJson(req);
    if (displayName !== undefined && (typeof displayName !== "string" || !displayName.trim())) throw new RpcError("bad_request", "displayName must be a non-empty string");
    return send(
      res,
      200,
      daemon.setHostIdentity(
        typeof displayName === "string" ? displayName.trim() : undefined,
        Array.isArray(aliases) ? aliases.filter((a: unknown): a is string => typeof a === "string" && !!a) : [],
        Array.isArray(removeAliases) ? removeAliases.filter((a: unknown): a is string => typeof a === "string" && !!a) : [],
      ),
    );
  }
  if (m === "POST" && path === "/api/hosts/rename") {
    const { host, displayName, aliases, removeAliases } = await readJson(req);
    if (typeof host !== "string" || !host) throw new RpcError("bad_request", "host is required");
    if (displayName !== undefined && typeof displayName !== "string") throw new RpcError("bad_request", "displayName must be a string");
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);
    return send(res, 200, daemon.renameHost(host, typeof displayName === "string" ? displayName : "", { aliases: list(aliases), removeAliases: list(removeAliases) }));
  }
  if (m === "POST" && path === "/api/hosts/address") {
    const { host, url } = await readJson(req);
    if (typeof host !== "string" || !host) throw new RpcError("bad_request", "host required");
    if (url !== null && (typeof url !== "string" || !url.trim())) throw new RpcError("bad_request", "url must be a host:port string or null");
    return send(res, 200, await daemon.setHostAddress(host, url === null ? null : url.trim()));
  }
  if (m === "POST" && path === "/api/hosts/forget") {
    const { host } = await readJson(req);
    if (typeof host !== "string" || !host) throw new RpcError("bad_request", "host required");
    return send(res, 200, await daemon.forgetHost(host));
  }
  if (m === "POST" && path === "/api/hosts/test") {
    const { host } = await readJson(req);
    if (typeof host !== "string" || !host) throw new RpcError("bad_request", "host required");
    return send(res, 200, await daemon.testHost(host));
  }
  if (m === "POST" && path === "/api/hosts/reconnect") {
    const { host } = await readJson(req);
    if (typeof host !== "string" || !host) throw new RpcError("bad_request", "host required");
    return send(res, 200, await daemon.reconnectHost(host));
  }
  if (m === "POST" && path === "/api/agents/rename") {
    const { address, displayName, alias, removeAlias } = await readJson(req);
    if (typeof address !== "string" || !address) throw new RpcError("bad_request", "address is required");
    if (typeof displayName === "string" && displayName.trim()) return send(res, 200, await daemon.renameAgentAny(address, displayName.trim()));
    if (typeof alias === "string" && alias.trim()) return send(res, 200, await daemon.aliasAgentAny(address, alias.trim()));
    if (typeof removeAlias === "string" && removeAlias.trim()) return send(res, 200, await daemon.removeAgentAliasAny(address, removeAlias.trim()));
    throw new RpcError("bad_request", "displayName, alias or removeAlias is required");
  }
  if (m === "GET" && path === "/api/agents/stats") {
    const since = Number(url.searchParams.get("since") ?? Date.now() - 24 * 3600_000);
    return send(res, 200, daemon.store.agentStats(since));
  }
  if (m === "GET" && path === "/api/routing/hints") return send(res, 200, { learn: daemon.config.router.learn, hints: daemon.routingHints() });
  if (m === "GET" && path === "/api/routing/stats") return send(res, 200, daemon.routingStats(parseLimit(url.searchParams.get("limit"), 200)));
  if (m === "GET" && path === "/api/daemons") return send(res, 200, daemon.daemons());
  if (m === "GET" && path === "/api/connectors") {
    res.setHeader("cache-control", "no-store");
    try {
      return send(res, 200, await connectorStatuses(daemon.store.home));
    } catch {
      return send(res, 503, { error: "unavailable", message: "connector status is unavailable" });
    }
  }
  if (m === "GET" && path === "/api/settings") {
    const token = daemon.config.token ?? "";
    return send(res, 200, {
      root: daemon.config.root,
      tokenSet: !!token,
      // The last 4 characters help tell tokens apart; a short token would be shown whole, so mask it all.
      ...(token ? { tokenHint: token.length >= 12 ? `${"•".repeat(token.length - 4)}${token.slice(-4)}` : "•".repeat(8) } : {}),
      // How another machine joins this Root (#18): the address and CA pin, never the token itself.
      ...(daemon.isRoot ? { join: daemon.joinHint() } : {}),
      // Where another device opens this Web encrypted (v4-9); absent when TLS is off.
      ...(daemon.webHttps() ? { web: { https: daemon.webHttps() } } : {}),
    });
  }
  if (m === "GET" && path === "/api/config") return send(res, 200, daemon.runtimeConfig());
  if (m === "GET" && path === "/api/update") {
    // The updater is CLI-side; the daemon only reports the state file it left behind.
    const file = join(daemon.store.home, "update.json");
    const state = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : { updatedAt: 0, log: [] };
    return send(res, 200, { ...state, running: { version: daemon.version } });
  }
  if (m === "POST" && path === "/api/config") {
    // A small whitelist: these are restart-required values the Web Settings may edit.
    const { advertise, retentionDays } = await readJson(req);
    if (advertise !== undefined && advertise !== null && (typeof advertise !== "string" || !advertise.trim())) throw new RpcError("bad_request", "advertise must be a non-empty string or null");
    if (retentionDays !== undefined && retentionDays !== null && (typeof retentionDays !== "number" || !Number.isInteger(retentionDays) || retentionDays < 1)) throw new RpcError("bad_request", "retentionDays must be a positive integer or null");
    const cfg = loadConfig(daemon.store.home);
    if (advertise !== undefined) {
      if (advertise === null) delete cfg.advertise;
      else cfg.advertise = advertise.trim();
    }
    if (retentionDays !== undefined) {
      if (retentionDays === null) delete cfg.retention.days;
      else cfg.retention.days = retentionDays;
    }
    saveConfig(cfg, daemon.store.home);
    return send(res, 200, { ok: true, restartRequired: true, pending: daemon.runtimeConfig().pending });
  }
  if (m === "GET" && path === "/api/doctor") return send(res, 200, daemon.doctor(webStale()));
  if (m === "POST" && path === "/api/artifacts") {
    const name = (url.searchParams.get("name") ?? "file").slice(0, 200);
    const mime = url.searchParams.get("mime") ?? "application/octet-stream";
    if (!name || /[\\/]/.test(name) || name.includes("..") || /[\x00-\x1f]/.test(name)) throw new RpcError("bad_request", "invalid attachment name");
    const id = ulid();
    const dest = daemon.artifactPath({ id, name });
    daemon.ensureArtifactDir();
    const { size, sha256 } = await readUpload(req, dest, daemon.attachmentLimits().maxBytes);
    if (size === 0) {
      try {
        unlinkSync(dest);
      } catch {
        // already gone
      }
      throw new RpcError("bad_request", "empty files are not accepted");
    }
    return send(res, 200, { attachment: daemon.registerStaged({ id, name, mime, size, sha256 }) });
  }
  const artifactId = /^\/api\/artifacts\/([^/]+)$/.exec(path)?.[1];
  if (m === "GET" && artifactId) {
    const id = decodeURIComponent(artifactId);
    const local = daemon.readArtifact(id);
    if (local) {
      res.writeHead(200, artifactHeaders(local.artifact));
      createReadStream(local.path).pipe(res);
      return;
    }
    const stored = daemon.store.getArtifact(id);
    if (!stored) throw new RpcError("not_found", `unknown attachment ${id}`);
    if (stored.host === daemon.host) throw new RpcError("not_found", `attachment ${id} is no longer on this host`);
    const base = daemon.artifactOrigin(stored.host);
    if (!base) throw new RpcError("attachment_unavailable", `origin host ${stored.host} is not known`);
    const r = await fetch(`${base}/api/artifacts/${encodeURIComponent(id)}`, {
      headers: daemon.config.token ? { authorization: `Bearer ${daemon.config.token}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok || !r.body) throw new RpcError("attachment_unavailable", `origin ${stored.host} returned HTTP ${r.status}`);
    res.writeHead(200, artifactHeaders(stored));
    await pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), res);
    return;
  }
  if (m === "GET" && path === "/api/threads") {
    const rows = daemon.store.listThreads(parseLimit(url.searchParams.get("limit"), 200), parseStatus(url.searchParams.get("status")), parseBefore(url.searchParams.get("before")));
    return send(res, 200, rows.map((r) => daemon.summaryMeta(r)));
  }
  if (m === "GET" && path === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) throw new RpcError("bad_request", "q required");
    const limit = parseLimit(url.searchParams.get("limit"), 20, { zeroOk: true });
    // `stats=1` adds scan/elapsed/truncated without changing the default array shape the CLI and Web use.
    if (url.searchParams.get("stats") === "1") {
      const stats = { scanned: 0, elapsedMs: 0, truncated: false };
      const results = daemon.search(q, limit, { stats });
      return send(res, 200, { results, ...stats });
    }
    return send(res, 200, daemon.search(q, limit));
  }
  if (m === "POST" && path === "/api/prune") {
    const { olderThanDays, dryRun } = await readJson(req);
    if (typeof olderThanDays !== "number" || olderThanDays < 1) throw new RpcError("bad_request", "olderThanDays (>= 1) required");
    return send(res, 200, daemon.prune(olderThanDays, dryRun !== false));
  }
  if (m === "GET" && (match = /^\/api\/threads\/([^/]+)$/.exec(path))) {
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : parseLimit(rawLimit, 200);
    const before = url.searchParams.get("before") ?? undefined;
    const t = daemon.thread(match[1]!, { ...(limit !== undefined ? { limit } : {}), ...(before ? { before } : {}) });
    return t ? send(res, 200, t) : send(res, 404, { error: "not_found" });
  }
  if (m === "GET" && (match = /^\/api\/threads\/([^/]+)\/stream$/.exec(path))) return stream(daemon, match[1]!, url.searchParams.get("orderId") ?? undefined, req, res);
  if (m === "POST" && path === "/api/orders") {
    const p = CreateOrderParams.parse(await readJson(req));
    return send(res, 200, await daemon.createOrder(p));
  }
  if (m === "POST" && (match = /^\/api\/threads\/([^/]+)\/cancel$/.exec(path))) {
    return send(res, 200, daemon.cancel(match[1]!, "cli"));
  }
  if (m === "POST" && (match = /^\/api\/threads\/([^/]+)\/reply$/.exec(path))) {
    const p = await readJson(req);
    if (typeof p.agent !== "string" || !p.agent || typeof p.text !== "string") throw new RpcError("bad_request", "agent and text are required");
    return send(res, 200, daemon.replyAs(match[1]!, p));
  }
  if (m === "DELETE" && (match = /^\/api\/agents\/([^/]+)$/.exec(path))) {
    daemon.kick(match[1]!);
    return send(res, 200, { ok: true });
  }
  if (path === "/api/baristas") {
    const sup = daemon.supervisor;
    if (m !== "POST" && !sup) throw new RpcError("unavailable", "barista supervisor disabled");
    if (m === "GET") return send(res, 200, sup!.list());
    if (m === "POST") {
      const body = await readJson(req);
      // Unknown fields are refused, not ignored: `bin`/`args` used to start any local executable,
      // and silently ignoring them would start the default pi instead (#65).
      const allowed = new Set(["dir", "agent", "access", "model", "tui", "thread"]);
      const extra = Object.keys(body).filter((k) => !allowed.has(k));
      if (extra.length) throw new RpcError("bad_request", `unknown field(s): ${extra.join(", ")}; cafe only starts its own agents (pi, omp, codex, claude)`);
      const { dir, agent, access, model, tui, thread } = body;
      // Only cafe's own agents (#65). A free-form `bin`/`args` meant any local executable could be
      // started with any argv by any page that reached this API; `cafe barista start --agent` is the
      // supported path and it never needed more than these fields.
      if (typeof dir !== "string" || !dir) throw new RpcError("bad_request", "dir is required");
      if (agent !== undefined && !AGENT_NAMES.includes(agent)) throw new RpcError("bad_request", `agent must be one of ${AGENT_NAMES.join(", ")}`);
      if (access !== undefined && access !== "read-only" && access !== "workspace-write") throw new RpcError("bad_request", "access must be read-only or workspace-write");
      if (access !== undefined && agent !== "codex" && agent !== "claude") throw new RpcError("bad_request", "access is for agent codex or claude");
      if (model !== undefined && (typeof model !== "string" || !/^[\w./:@-]+$/.test(model))) throw new RpcError("bad_request", "bad model name");
      if (model !== undefined && agent !== "codex" && agent !== "claude") throw new RpcError("bad_request", "model is for agent codex or claude");
      if (tui !== undefined && (tui !== true || agent !== "codex")) throw new RpcError("bad_request", "tui is for agent codex");
      if (thread !== undefined && (!tui || typeof thread !== "string" || !/^[\w-]+$/.test(thread))) throw new RpcError("bad_request", "bad thread id (needs tui)");
      // pi and omp are the local extension binaries the supervisor already knows how to run.
      const native = agent === "codex" || agent === "claude" ? { agent } : agent === "omp" ? { bin: "omp" } : {};
      if (!sup) throw new RpcError("unavailable", "barista supervisor disabled");
      return send(res, 200, sup.start({ dir, ...native, ...(access ? { access } : {}), ...(model ? { model } : {}), ...(tui ? { tui } : {}), ...(thread ? { thread } : {}) }));
    }
    if (m === "DELETE") return send(res, 200, { stopped: sup!.stop(url.searchParams.get("dir") ?? "") });
  }
  if (m === "POST" && path === "/api/root") {
    const { root } = await readJson(req);
    if (typeof root !== "string" || !root) throw new RpcError("bad_request", "root required");
    daemon.setRoot(root);
    return send(res, 200, { root });
  }
  if (m === "POST" && path === "/api/reload") {
    const fresh = loadConfig(daemon.store.home);
    daemon.config.router = fresh.router;
    const applied = await daemon.initRouter();
    if (!daemon.isRoot && fresh.root && fresh.root !== daemon.config.root) daemon.setRoot(fresh.root);
    return send(res, 200, applied);
  }
  if (m === "POST" && path === "/api/shutdown") {
    send(res, 200, { ok: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
    return;
  }
  if (m === "POST" && path === "/api/drain") {
    const { timeoutMs } = await readJson(req).catch(() => ({}) as { timeoutMs?: number });
    return send(res, 200, await daemon.drain(typeof timeoutMs === "number" ? timeoutMs : 30_000));
  }
  send(res, 404, { error: "not_found" });
}

/** The most events an SSE `after=` resume replays; beyond that the client is told about a gap (#31). */
const SSE_AFTER_MAX = 5_000;

/** SSE: replay the Thread so far, then follow live events until it closes. */
function stream(daemon: Daemon, threadId: string, orderId: string | undefined, req: IncomingMessage, res: ServerResponse): void {
  const thread = daemon.thread(threadId);
  if (!thread) {
    // Without this, SSE opens a 200 stream that never closes: `cafe wait <typo>` hangs forever.
    send(res, 404, { error: "not_found", message: `no thread '${threadId}'` });
    return;
  }
  // Follow one Order (default: the Thread's latest) until it closes; earlier turns are replayed for context.
  const until = orderId ?? thread.meta.orderId;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  // A follow-up Thread keeps events after an earlier turn's close, and a late
  // broadcast can arrive after the response ended: never write then (#54).
  let finished = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  const write = (env: ThreadEnvelope) => {
    if (finished || res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(env)}\n\n`);
    if (env.event.type === "order.closed" && (!until || env.orderId === until)) {
      done();
      res.end();
    }
  };
  const seen = new Set<string>();
  const onEvent = (env: ThreadEnvelope) => {
    if (env.threadId !== threadId || seen.has(env.eventId)) return;
    seen.add(env.eventId);
    write(env);
  };
  daemon.on("thread", onEvent);
  const counts = daemon.streamCounts;
  counts.sse++;
  const done = () => {
    if (finished) return;
    finished = true;
    if (ping) clearInterval(ping);
    daemon.off("thread", onEvent);
    counts.sse = Math.max(0, counts.sse - 1);
  };
  // Register cleanup before the replay: the replay itself can end the response.
  req.on("close", done);
  res.on("close", done);
  const pingMs = Number(process.env.CAFE_SSE_PING_MS) || 15_000;
  ping = setInterval(() => {
    if (!finished && !res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, pingMs);
  // Resume from a cursor by reading after it, not by slicing the default page: a cursor older than the
  // page would otherwise replay the page and drop everything between the cursor and the page (#31).
  // A cursor the Thread does not have (or one with more than SSE_AFTER_MAX events behind it) is
  // announced as a named `gap` event, then the page is replayed for context.
  const after = new URL(req.url ?? "/", "http://x").searchParams.get("after");
  let replay = thread.events;
  if (after) {
    const r = daemon.store.readEventsAfter(thread.meta.file, after, SSE_AFTER_MAX);
    if (r.found) replay = r.events;
    else if (!finished) res.write(`event: gap\ndata: ${JSON.stringify({ after, reason: "unknown_cursor" })}\n\n`);
  }
  for (const env of replay) onEvent(env);
  // The page above is bounded: when the turn being followed closed before that page starts, its
  // `order.closed` is missing and the stream would keep the caller waiting forever (#31/#60). A replay
  // that did include the close has already finished the stream here.
  if (!finished && until) {
    const closed = daemon.closingEvent(threadId, until);
    if (closed) onEvent(closed);
  }
}

/** SSE: every Thread event on the network, filtered. Heartbeats are hidden unless asked for. */
function eventStream(daemon: Daemon, url: URL, req: IncomingMessage, res: ServerResponse, recent: ThreadEnvelope[]): void {
  const filter = parseEventFilter(url);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  let finished = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  const write = (env: ThreadEnvelope) => {
    if (finished || res.writableEnded || res.destroyed) return;
    if (!eventMatches(env, filter)) return;
    res.write(`id: ${env.eventId}\ndata: ${JSON.stringify(env)}\n\n`);
  };
  // Resume after the last event the client saw; an id too old for the ring
  // replays nothing and the client re-syncs (the Web UI uses snapshots).
  const header = req.headers["last-event-id"];
  const lastId = Array.isArray(header) ? header[0] : (header ?? url.searchParams.get("lastEventId") ?? undefined);
  for (const env of replayAfter(recent, lastId)) write(env);
  const onEvent = (env: ThreadEnvelope) => write(env);
  daemon.on("thread", onEvent);
  const counts = daemon.streamCounts;
  counts.sse++;
  const done = () => {
    if (finished) return;
    finished = true;
    if (ping) clearInterval(ping);
    daemon.off("thread", onEvent);
    counts.sse = Math.max(0, counts.sse - 1);
  };
  req.on("close", done);
  res.on("close", done);
  const pingMs = Number(process.env.CAFE_SSE_PING_MS) || 15_000;
  ping = setInterval(() => {
    if (!finished && !res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, pingMs);
}

export { Methods };
