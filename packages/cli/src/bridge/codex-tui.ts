import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { AppServer } from "./codex.ts";
import type { Engine, EngineOptions, TurnRequest, TurnResult } from "./engine.ts";

type Json = Record<string, any>;

export interface CodexTuiOptions extends EngineOptions {
  /** Codex thread to use; default: the most recently active one whose cwd is `dir`. */
  thread?: string;
  /** How long a queued question may wait for the session to pick it up (default CAFE_INJECT_TIMEOUT_MS or 120 s). */
  injectTimeoutMs?: number;
  /** How long a started turn may run before we give up waiting (default CAFE_CODEX_TUI_MAX_MS or 1 h). */
  maxTurnMs?: number;
  /** Poll interval for the session's turns (default 1 s). */
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * A running Codex session (the TUI, or anything else on the same CODEX_HOME) as a Barista (v3-1 phase 2, Q86).
 *
 * Each question goes into the session's queue (`thread/queue/add`); Codex starts it when the session is idle and
 * the TUI shows it like a typed message. Our own `codex app-server` never loads the thread, so it never runs the
 * turn itself; it reads the outcome from the stored turns (`thread/turns/list`), matched by `clientUserMessageId`.
 * That works whether the TUI uses the shared app-server daemon or its own embedded one (cmux and `-c` flags force
 * the latter, which picks up the queue every few seconds).
 *
 * Read from another process, a turn the TUI is still running looks `interrupted` with no `completedAt`; one the
 * person really interrupted has `completedAt` set. A cancel removes a question that has not started; a started turn
 * runs on in the TUI (we cannot interrupt another process's turn), and its answer is dropped.
 */
export class CodexTuiEngine implements Engine {
  readonly kind = "codex" as const;
  private server?: AppServer;
  private ready?: Promise<AppServer>;
  private readonly bin: string;
  private readonly log: (m: string) => void;
  private readonly opts: CodexTuiOptions;

  constructor(opts: CodexTuiOptions) {
    this.opts = opts;
    this.bin = opts.bin ?? process.env.CAFE_CODEX_BIN ?? "codex";
    this.log = opts.log ?? (() => {});
  }

  private start(): Promise<AppServer> {
    if (this.server && !this.server.exited && this.ready) return this.ready;
    const server = new AppServer(this.bin, this.opts.dir, this.log);
    this.server = server;
    this.ready = (async () => {
      await server.request("initialize", { clientInfo: { name: "cafe", title: "cafe barista", version: "1" }, capabilities: { experimentalApi: true } });
      server.notify("initialized");
      return server;
    })();
    this.ready.catch(() => {});
    return this.ready;
  }

  /** The session to ask: the configured thread, else the newest non-ephemeral thread started in `dir`. */
  async findThread(server: AppServer): Promise<string | undefined> {
    if (this.opts.thread) return this.opts.thread;
    const want = real(this.opts.dir);
    const res = await server.request<Json>("thread/list", { limit: 50 });
    const rows = ((res.data ?? []) as Json[]).filter((t) => !t.ephemeral && typeof t.cwd === "string" && (t.cwd === this.opts.dir || real(t.cwd) === want));
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return rows[0]?.id;
  }

  /**
   * Startup preflight (#40): a TUI Barista is only useful next to a running
   * Codex session. Without this, `barista start` registers an agent that looks
   * idle but declines every Order.
   */
  async probe(): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> {
    try {
      const server = await this.start();
      const threadId = await this.findThread(server);
      if (!threadId) {
        await this.close();
        return { ok: false, error: `no Codex session in ${this.opts.dir}` };
      }
      return { ok: true, threadId };
    } catch (err) {
      await this.close();
      return { ok: false, error: (err as Error).message };
    }
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const injectTimeoutMs = this.opts.injectTimeoutMs ?? (Number(process.env.CAFE_INJECT_TIMEOUT_MS) || 120_000);
    const maxTurnMs = this.opts.maxTurnMs ?? (Number(process.env.CAFE_CODEX_TUI_MAX_MS) || 3_600_000);
    const pollMs = this.opts.pollMs ?? 1000;
    let server: AppServer;
    let threadId: string | undefined;
    try {
      server = await this.start();
      threadId = await this.findThread(server);
    } catch (err) {
      return { status: "failed", text: "", error: (err as Error).message };
    }
    if (!threadId) return { status: "failed", text: "", error: `no Codex session in ${this.opts.dir}; start codex there first` };

    // The daemon remembers which Codex thread answered this cafe Thread: the same session needs no repeated history.
    const text = req.resume === threadId ? req.followup : req.prompt;
    const clientId = `cafe-${randomUUID()}`;
    let queued: string | undefined;
    try {
      const r = await server.request<Json>("thread/queue/add", { threadId, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: clientId });
      queued = r.queuedSubmission?.id;
    } catch (err) {
      return { status: "failed", text: "", sessionId: threadId, error: `cannot queue in Codex session ${threadId}: ${(err as Error).message}` };
    }
    req.onSession?.(threadId);
    this.log(`queued in ${threadId} (${clientId})`);

    const withdraw = async () => {
      if (!queued) return false;
      const r = await server.request<Json>("thread/queue/delete", { threadId, queuedSubmissionId: queued }).catch(() => ({ deleted: false }));
      return !!r.deleted;
    };

    const queuedAt = Date.now();
    let startedAt: number | undefined;
    while (true) {
      if (req.signal.aborted) {
        if (!startedAt && (await withdraw())) return { status: "interrupted", text: "", sessionId: threadId };
        this.log(`cancel: the turn already runs in the Codex session; its answer will be dropped`);
        return { status: "interrupted", text: "", sessionId: threadId };
      }
      if (server.exited) return { status: "failed", text: "", sessionId: threadId, error: server.exited };
      const turn = await this.turnOf(server, threadId, clientId).catch((err) => {
        this.log(`codex: turns/list failed: ${(err as Error).message}`);
        return undefined;
      });
      if (turn) {
        startedAt ??= Date.now();
        const done = this.outcome(turn);
        if (done) return { ...done, sessionId: threadId };
        if (Date.now() - startedAt > maxTurnMs) return { status: "failed", text: "", sessionId: threadId, error: "the Codex session did not finish the turn in time" };
      } else if (Date.now() - queuedAt > injectTimeoutMs) {
        // Not started: the session is busy, stopped or closed. Take it back so it never runs later.
        if (await withdraw()) return { status: "failed", text: "", sessionId: threadId, error: "the Codex session did not take the question (busy, stopped or closed)" };
      }
      await sleep(pollMs);
    }
  }

  private async turnOf(server: AppServer, threadId: string, clientId: string): Promise<Json | undefined> {
    const res = await server.request<Json>("thread/turns/list", { threadId, limit: 20 });
    return ((res.data ?? []) as Json[]).find((t) => ((t.items ?? []) as Json[]).some((it) => it.type === "userMessage" && it.clientId === clientId));
  }

  private outcome(turn: Json): Omit<TurnResult, "sessionId"> | undefined {
    const msgs = ((turn.items ?? []) as Json[]).filter((it) => it.type === "agentMessage" && typeof it.text === "string");
    const answer = (msgs.find((m) => m.phase === "final_answer") ?? msgs.at(-1))?.text ?? "";
    if (turn.status === "completed") return { status: "completed", text: answer };
    if (turn.status === "failed") return { status: "failed", text: "", error: turn.error?.message ?? "the Codex turn failed" };
    // Another process's running turn reads as interrupted without completedAt.
    if (turn.status === "interrupted" && turn.completedAt) return { status: "failed", text: "", error: "the answer was interrupted in the Codex session" };
    return undefined;
  }

  async close(): Promise<void> {
    this.server?.kill();
    this.server = undefined;
    this.ready = undefined;
  }
}
