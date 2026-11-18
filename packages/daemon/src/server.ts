import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { CreateOrderParams, Methods, type ThreadEnvelope } from "@cafe/protocol";
import { RpcError } from "@cafe/protocol/peer";
import type { Daemon } from "./daemon.ts";
import { loadConfig } from "./config.ts";

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

export function defaultWebDist(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
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

export interface ServerHandle {
  close(): Promise<void>;
  port: number;
}

/** One port serves the HTTP API, the WebSocket endpoint (`/ws`) and the web UI. */
export function startServer(daemon: Daemon, opts: { port: number; bind?: string; webDist?: string }): Promise<ServerHandle> {
  const statics = loadStatic(opts.webDist ?? defaultWebDist());
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      if (path.startsWith("/api/")) {
        if (!isLoopback(req) && tokenOf(req, url) !== daemon.config.token) return send(res, 401, { error: "unauthorized" });
        return await api(daemon, req, res, url);
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
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

async function api(daemon: Daemon, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const m = req.method ?? "GET";
  let match: RegExpExecArray | null;

  if (m === "GET" && path === "/api/health") return send(res, 200, { ok: true, host: daemon.host, isRoot: daemon.isRoot, pid: process.pid });
  if (m === "GET" && path === "/api/snapshot") return send(res, 200, daemon.snapshot());
  if (m === "GET" && path === "/api/agents") return send(res, 200, daemon.registry.all());
  if (m === "GET" && path === "/api/agents/stats") {
    const since = Number(url.searchParams.get("since") ?? Date.now() - 24 * 3600_000);
    return send(res, 200, daemon.store.agentStats(since));
  }
  if (m === "GET" && path === "/api/routing/hints") return send(res, 200, { learn: daemon.config.router.learn, hints: daemon.routingHints() });
  if (m === "GET" && path === "/api/daemons") return send(res, 200, daemon.daemons());
  if (m === "GET" && path === "/api/threads") {
    return send(res, 200, daemon.store.listThreads(Number(url.searchParams.get("limit") ?? 200), url.searchParams.get("status") ?? undefined));
  }
  if (m === "GET" && (match = /^\/api\/threads\/([^/]+)$/.exec(path))) {
    const t = daemon.thread(match[1]!);
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
      const { dir, args } = await readJson(req);
      return send(res, 200, sup.start({ dir, args }));
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
    await daemon.initRouter();
    if (!daemon.isRoot && fresh.root && fresh.root !== daemon.config.root) daemon.setRoot(fresh.root);
    return send(res, 200, { ok: true });
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
  // Follow one Order (default: the Thread's latest) until it closes; earlier turns are replayed for context.
  const until = orderId ?? daemon.thread(threadId)?.meta.orderId;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const write = (env: ThreadEnvelope) => {
    res.write(`data: ${JSON.stringify(env)}\n\n`);
    if (env.event.type === "order.closed" && (!until || env.orderId === until)) res.end();
  };
  const seen = new Set<string>();
  const onEvent = (env: ThreadEnvelope) => {
    if (env.threadId !== threadId || seen.has(env.eventId)) return;
    seen.add(env.eventId);
    write(env);
  };
  daemon.on("thread", onEvent);
  for (const env of daemon.thread(threadId)?.events ?? []) onEvent(env);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  const done = () => {
    clearInterval(ping);
    daemon.off("thread", onEvent);
  };
  req.on("close", done);
  res.on("close", done);
}

export { Methods };
