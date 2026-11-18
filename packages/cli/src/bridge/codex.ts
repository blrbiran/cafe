import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Engine, EngineOptions, TurnRequest, TurnResult } from "./engine.ts";

type Json = Record<string, any>;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/**
 * Answers to server → client requests. A headless Barista has nobody to ask, so every approval is refused
 * (the read-only / workspace-write sandbox with `approvalPolicy: never` should not ask in the first place).
 * Shapes follow `codex app-server generate-json-schema` (codex-cli 0.170).
 */
export function refuseServerRequest(method: string): { result: Json } | { error: { code: number; message: string } } {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { result: { decision: "denied" } };
    case "item/permissions/requestApproval":
      return { result: { permissions: {}, scope: "turn" } };
    case "item/tool/requestUserInput":
      return { result: { answers: {} } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline" } };
    default:
      return { error: { code: -32601, message: `cafe headless barista does not handle ${method}` } };
  }
}

/** Minimal client for `codex app-server` (stdio, one JSON object per line, no `jsonrpc` field). */
class AppServer {
  private child: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: Json) => void>();
  private exitListeners = new Set<(why: string) => void>();
  exited?: string;
  stderrTail = "";

  constructor(bin: string, cwd: string, log: (m: string) => void) {
    // Not detached: the bridge runs inside the supervisor's guard group, which takes app-server down with it.
    this.child = spawn(bin, ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CAFE_HEADLESS: "1" } });
    this.child.on("error", (err) => this.gone(`cannot start ${bin}: ${err.message}`));
    this.child.on("exit", (code, signal) => this.gone(`${bin} app-server exited (code ${code}, signal ${signal})`));
    this.child.stdin?.on("error", () => {});
    this.child.stderr?.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        return log(`codex: unparsable line: ${line.slice(0, 200)}`);
      }
      if (msg.method && msg.id !== undefined) {
        const answer = refuseServerRequest(msg.method);
        if (msg.method.includes("pproval")) log(`codex asked for approval (${msg.method}); refused: headless barista`);
        this.write({ id: msg.id, ...answer });
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg.method, msg.params ?? {});
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
  }

  private gone(why: string): void {
    if (this.exited) return;
    this.exited = why;
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
    for (const fn of this.exitListeners) fn(why);
  }

  private write(msg: Json): void {
    if (this.exited) return;
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  request<T = Json>(method: string, params: Json): Promise<T> {
    if (this.exited) return Promise.reject(new Error(this.exited));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Json): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  on(fn: (method: string, params: Json) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onExit(fn: (why: string) => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGTERM");
  }
}

/**
 * A Barista backed by one long-lived `codex app-server` (v3-1 Q73). A cafe Thread maps to a Codex thread:
 * the first Order starts it, Follow-ups (and restarts, via the Daemon's mapping) resume it.
 */
export class CodexEngine implements Engine {
  readonly kind = "codex" as const;
  private server?: AppServer;
  private ready?: Promise<AppServer>;
  /** Codex threads already loaded in the current app-server (no `thread/resume` needed). */
  private loaded = new Set<string>();
  private readonly bin: string;
  private readonly log: (m: string) => void;
  private readonly opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.bin = opts.bin ?? process.env.CAFE_CODEX_BIN ?? "codex";
    this.log = opts.log ?? (() => {});
  }

  private start(): Promise<AppServer> {
    if (this.server && !this.server.exited && this.ready) return this.ready;
    const server = new AppServer(this.bin, this.opts.dir, this.log);
    this.server = server;
    this.loaded.clear();
    this.ready = (async () => {
      await server.request("initialize", { clientInfo: { name: "cafe", title: "cafe barista", version: "1" }, capabilities: { experimentalApi: true } });
      server.notify("initialized");
      return server;
    })();
    this.ready.catch(() => {});
    return this.ready;
  }

  private threadParams(): Json {
    return {
      cwd: this.opts.dir,
      approvalPolicy: "never",
      sandbox: this.opts.access,
      ...(this.opts.model ? { model: this.opts.model } : {}),
    };
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    let server: AppServer;
    try {
      server = await this.start();
    } catch (err) {
      const tail = this.server?.stderrTail.trim();
      return { status: "failed", text: "", error: `${(err as Error).message}${tail ? `: ${tail.slice(-300)}` : ""}` };
    }

    const first = await this.attempt(server, req, req.resume);
    // A resumed thread the server no longer knows (turn/start refused, no model call made): start over.
    if (first.rejected && first.resumed) {
      this.log(`codex: thread ${first.sessionId} refused the turn (${first.error}); starting a new one`);
      if (first.sessionId) this.loaded.delete(first.sessionId);
      const { rejected: _r, resumed: _s, ...again } = await this.attempt(server, req, undefined);
      return again;
    }
    const { rejected: _r, resumed: _s, ...result } = first;
    return result;
  }

  private async attempt(server: AppServer, req: TurnRequest, resume: string | undefined): Promise<TurnResult & { rejected?: boolean; resumed?: boolean }> {
    let threadId: string | undefined;
    let resumed = false;
    if (resume && this.loaded.has(resume)) {
      threadId = resume;
      resumed = true;
    } else if (resume) {
      try {
        const r = await server.request<{ thread: { id: string } }>("thread/resume", { threadId: resume, excludeTurns: true, ...this.threadParams() });
        threadId = r.thread.id;
        resumed = true;
      } catch (err) {
        this.log(`codex: cannot resume thread ${resume} (${(err as Error).message}); starting a new one`);
      }
    }
    try {
      if (!threadId) threadId = (await server.request<{ thread: { id: string } }>("thread/start", this.threadParams())).thread.id;
    } catch (err) {
      return { status: "failed", text: "", error: `thread/start failed: ${(err as Error).message}` };
    }
    this.loaded.add(threadId);
    req.onSession?.(threadId);
    const tid = threadId;

    return new Promise((resolve) => {
      let turnId: string | undefined;
      let finalAnswer: string | undefined;
      let lastMessage = "";
      let done = false;
      let interruptWanted = req.signal.aborted;
      const finish = (r: TurnResult & { rejected?: boolean }) => {
        if (done) return;
        done = true;
        off();
        offExit();
        req.signal.removeEventListener("abort", onAbort);
        resolve({ ...r, sessionId: tid, resumed });
      };
      const interrupt = () => {
        if (!turnId) return;
        server.request("turn/interrupt", { threadId: tid, turnId }).catch((e) => this.log(`codex: interrupt failed: ${(e as Error).message}`));
      };
      const onAbort = () => {
        interruptWanted = true;
        interrupt();
      };
      req.signal.addEventListener("abort", onAbort);
      const off = server.on((method, p) => {
        if (p.threadId !== tid) return;
        if (method === "item/completed" && p.item?.type === "agentMessage" && (!turnId || p.turnId === turnId)) {
          const text = String(p.item.text ?? "");
          if (p.item.phase === "final_answer") finalAnswer = text;
          if (text.trim()) lastMessage = text;
        } else if (method === "turn/completed" && (!turnId || p.turn?.id === turnId)) {
          const status = p.turn?.status;
          const text = (finalAnswer ?? lastMessage).trim();
          if (status === "completed") finish({ status: "completed", text });
          else if (status === "interrupted") finish({ status: "interrupted", text });
          else finish({ status: "failed", text, error: p.turn?.error?.message ?? `turn ${status ?? "ended"}` });
        }
      });
      const offExit = server.onExit((why) => finish({ status: "failed", text: "", error: why }));
      server
        .request<{ turn: { id: string } }>("turn/start", { threadId: tid, input: [{ type: "text", text: resumed ? req.followup : req.prompt, text_elements: [] }] })
        .then((r) => {
          turnId = r.turn.id;
          if (interruptWanted) interrupt();
        })
        .catch((err) => finish({ status: "failed", text: "", error: `turn/start failed: ${(err as Error).message}`, rejected: !server.exited }));
    });
  }

  async close(): Promise<void> {
    this.server?.kill();
  }
}
