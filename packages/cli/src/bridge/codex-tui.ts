import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { AppServer } from "./codex.ts";
import type { Engine, EngineOptions, TurnRequest, TurnResult } from "./engine.ts";

type Json = Record<string, any>;

export interface CodexTuiOptions extends EngineOptions {
  /** Codex thread to use; default: the only idle session in `dir` (several open: ask for --thread). */
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

  /** Sessions whose cwd is `dir`, newest first. Ephemeral threads are not real sessions. */
  private async candidates(server: AppServer): Promise<Json[]> {
    const want = real(this.opts.dir);
    const res = await server.request<Json>("thread/list", { limit: 50 });
    const rows = ((res.data ?? []) as Json[]).filter((t) => !t.ephemeral && typeof t.cwd === "string" && (t.cwd === this.opts.dir || real(t.cwd) === want));
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    // codex app-server can repeat a thread in thread/list; the newest row for an id wins. Without
    // this the candidate list repeats one id and slice(0,10) can push a real session out (#107).
    const seen = new Set<string>();
    return rows.filter((t) => {
      const id = String(t.id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  /**
   * A session another process is in the middle of a turn shows `interrupted` with no `completedAt`
   * (see the class comment). Injecting there would start a turn in someone's live conversation (#100).
   */
  private async busy(server: AppServer, threadId: string): Promise<boolean> {
    const res = await server.request<Json>("thread/turns/list", { threadId, limit: 1 }).catch(() => undefined);
    const turn = ((res?.data ?? []) as Json[])[0];
    if (!turn) return false;
    return turn.completedAt == null && turn.status !== "completed";
  }

  /**
   * Which session to ask. `--thread` wins. A directory with one session uses it and names it; with
   * several open the command refuses and lists them, because "the most recently updated one" is very
   * often the session the person is typing in (#100). A running turn only matters when choosing
   * between several: queueing into one known session is the whole point of a TUI Barista.
   */
  async chooseThread(server: AppServer): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> {
    if (this.opts.thread) return { ok: true, threadId: this.opts.thread };
    const rows = await this.candidates(server);
    if (!rows.length) return { ok: false, error: `no Codex session in ${this.opts.dir}` };
    if (rows.length === 1) return { ok: true, threadId: rows[0]!.id };
    const idle: string[] = [];
    const busy: string[] = [];
    for (const row of rows.slice(0, 10)) (await this.busy(server, row.id) ? busy : idle).push(row.id);
    if (idle.length === 1) return { ok: true, threadId: idle[0]! };
    if (!idle.length) {
      return {
        ok: false,
        error: `every Codex session in ${this.opts.dir} is in the middle of a turn (${busy.join(", ")}); wait for the turn to finish and run this command again, or pass --thread <id>`,
      };
    }
    const names = [...idle, ...busy.map((id) => `${id} (busy)`)].join(", ");
    return {
      ok: false,
      error: `several Codex sessions in ${this.opts.dir}: ${names}; pass --thread <id> to choose one (cafe never guesses — the newest is often the session you are typing in)`,
    };
  }

  /** The session picked at startup stays the session: every question goes into the same queue. */
  private picked?: string;

  /**
   * Startup preflight (#40): a TUI Barista is only useful next to a running
   * Codex session. Without this, `barista start` registers an agent that looks
   * idle but declines every Order.
   */
  async probe(): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> {
    try {
      const server = await this.start();
      const choice = await this.chooseThread(server);
      if (!choice.ok) {
        await this.close();
        return choice;
      }
      this.picked = choice.threadId;
      return choice;
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
      threadId = this.opts.thread ?? this.picked;
      if (!threadId) {
        const choice = await this.chooseThread(server);
        if (!choice.ok) return { status: "failed", text: "", error: choice.error };
        threadId = this.picked = choice.threadId;
      }
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
