import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
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
import { loadConfig, saveConfig } from "./config.ts";
import { eventMatches, parseEventFilter, replayAfter } from "./events.ts";
import { listRouterModels } from "./router.ts";

/** pi's model catalogue is expensive to build; settings can ask for it repeatedly. */
let modelCache: { at: number; models: string[] } | undefined;
async function routerModels(search?: string): Promise<string[]> {
  if (!modelCache || Date.now() - modelCache.at > 60_000) {
    modelCache = { at: Date.now(), models: await listRouterModels() };
  }
  const q = search?.toLowerCase();
  return q ? modelCache.models.filter((m) => m.toLowerCase().includes(q)) : modelCache.models;
}

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

/** Read the built web UI into memory once (flat, exact-match lookup; no path traversal). */
function loadStatic(dist: string): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  if (!existsSync(dist)) return files;
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else files.set(`${prefix}${name}`, { body: readFileSync(full), type: MIME[extname(name)] ?? "application/octet-stream" });
    }
  };
  walk(dist, "");
  return files;
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function tokenOf(req: IncomingMessage, url: URL): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return url.searchParams.get("token") ?? undefined;
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
}

/** One port serves the HTTP API, the WebSocket endpoint (`/ws`) and the web UI. */
export function startServer(daemon: Daemon, opts: { port: number; bind?: string; webDist?: string }): Promise<ServerHandle> {
  const webDir = opts.webDist ?? defaultWebDist();
  const statics = loadStatic(webDir);
  // The UI is read into memory at start; remember which build that was so the
  // page can say "restart the daemon" instead of silently serving old HTML/JS.
  const stampOf = () => {
    try {
      const s = statSync(join(webDir, "index.html"));
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return undefined;
    }
  };
  const loadedStamp = stampOf();
  const webStale = () => !!loadedStamp && stampOf() !== undefined && stampOf() !== loadedStamp;
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      if (path.startsWith("/api/")) {
        if (!isLoopback(req) && tokenOf(req, url) !== daemon.config.token) {
          return send(res, 401, { error: "unauthorized", message: "token mismatch or wrong Root address; compare `cafe config get token` on both hosts" });
        }
        return await api(daemon, req, res, url, webStale, recent);
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
      res.writeHead(200, { "content-type": file.type });
      res.end(file.body);
    } catch (err) {
      const e = err as RpcError;
      send(res, e.code === "not_found" ? 404 : 400, { error: e.code ?? "error", message: e.message });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => daemon.accept(ws, isLoopback(req)));
  });

  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.bind ?? "0.0.0.0", () => {
      const addr = server.address();
      resolveP({
        port: typeof addr === "object" && addr ? addr.port : opts.port,
        close: () =>
          new Promise<void>((r) => {
            daemon.off("thread", remember);
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

async function api(daemon: Daemon, req: IncomingMessage, res: ServerResponse, url: URL, webStale: () => boolean, recent: ThreadEnvelope[]): Promise<void> {
  const path = url.pathname;
  const m = req.method ?? "GET";
  let match: RegExpExecArray | null;

  if (m === "GET" && path === "/api/health") return send(res, 200, { ok: true, host: daemon.host, isRoot: daemon.isRoot, pid: process.pid, version: daemon.version, ...daemon.routerStatus() });
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
  if (m === "GET" && path === "/api/daemons") return send(res, 200, daemon.daemons());
  if (m === "GET" && path === "/api/settings") {
    const token = daemon.config.token ?? "";
    return send(res, 200, {
      root: daemon.config.root,
      tokenSet: !!token,
      ...(token ? { tokenHint: `${"•".repeat(Math.max(0, token.length - 4))}${token.slice(-4)}` } : {}),
    });
  }
  if (m === "GET" && path === "/api/config") return send(res, 200, daemon.runtimeConfig());
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
    return send(res, 200, daemon.search(q, parseLimit(url.searchParams.get("limit"), 20, { zeroOk: true })));
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
  if (m === "DELETE" && (match = /^\/api\/agents\/([^/]+)$/.exec(path))) {
    daemon.kick(match[1]!);
    return send(res, 200, { ok: true });
  }
  if (path === "/api/baristas") {
    const sup = daemon.supervisor;
    if (!sup) throw new RpcError("unavailable", "barista supervisor disabled");
    if (m === "GET") return send(res, 200, sup.list());
    if (m === "POST") {
      const { dir, args, bin, agent, access, model, tui, thread } = await readJson(req);
      if (bin !== undefined && (typeof bin !== "string" || !/^[\w./-]+$/.test(bin))) throw new RpcError("bad_request", "bin must be an executable name or path");
      if (agent !== undefined && agent !== "codex" && agent !== "claude") throw new RpcError("bad_request", "agent must be codex or claude");
      if (access !== undefined && access !== "read-only" && access !== "workspace-write") throw new RpcError("bad_request", "access must be read-only or workspace-write");
      if (model !== undefined && (typeof model !== "string" || !/^[\w./:@-]+$/.test(model))) throw new RpcError("bad_request", "bad model name");
      if (tui !== undefined && (tui !== true || agent !== "codex")) throw new RpcError("bad_request", "tui is for agent codex");
      if (thread !== undefined && (!tui || typeof thread !== "string" || !/^[\w-]+$/.test(thread))) throw new RpcError("bad_request", "bad thread id (needs tui)");
      return send(res, 200, sup.start({ dir, args, ...(bin ? { bin } : {}), ...(agent ? { agent } : {}), ...(access ? { access } : {}), ...(model ? { model } : {}), ...(tui ? { tui } : {}), ...(thread ? { thread } : {}) }));
    }
    if (m === "DELETE") return send(res, 200, { stopped: sup.stop(url.searchParams.get("dir") ?? "") });
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
  send(res, 404, { error: "not_found" });
}

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
  const done = () => {
    if (finished) return;
    finished = true;
    if (ping) clearInterval(ping);
    daemon.off("thread", onEvent);
  };
  // Register cleanup before the replay: the replay itself can end the response.
  req.on("close", done);
  res.on("close", done);
  const pingMs = Number(process.env.CAFE_SSE_PING_MS) || 15_000;
  ping = setInterval(() => {
    if (!finished && !res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, pingMs);
  const after = new URL(req.url ?? "/", "http://x").searchParams.get("after");
  const replay = thread.events;
  const from = after ? replay.findIndex((e) => e.eventId === after) + 1 : 0;
  for (const env of replay.slice(Math.max(0, from))) onEvent(env);
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
  const done = () => {
    if (finished) return;
    finished = true;
    if (ping) clearInterval(ping);
    daemon.off("thread", onEvent);
  };
  req.on("close", done);
  res.on("close", done);
  const pingMs = Number(process.env.CAFE_SSE_PING_MS) || 15_000;
  ping = setInterval(() => {
    if (!finished && !res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, pingMs);
}

export { Methods };
