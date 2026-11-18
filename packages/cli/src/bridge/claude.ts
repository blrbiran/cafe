import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Access, Engine, EngineOptions, TurnRequest, TurnResult } from "./engine.ts";

const MAX_OUTPUT = 4 * 1024 * 1024;
/** Built-in tools per access level (v3-1 Q75). No Bash, no web: a headless Barista only reads, or edits files. */
export const CLAUDE_TOOLS: Record<Access, string> = {
  "read-only": "Read,Grep,Glob",
  "workspace-write": "Read,Grep,Glob,Edit,Write",
};

/**
 * Arguments for one `claude -p` turn (v3-1 Q74/Q76). The prompt goes on stdin.
 * - Permissions: `dontAsk` refuses anything not pre-approved; only the access level's tools exist and are allowed.
 * - Login: the local `claude` login, loading user settings only (no project hooks or `.mcp.json`);
 *   with ANTHROPIC_API_KEY set, `--bare` (API key only, no hooks, no settings).
 */
export function claudeArgs(o: { access: Access; model?: string; resume?: string; sessionId?: string; apiKey: boolean }): string[] {
  const tools = CLAUDE_TOOLS[o.access];
  return [
    "-p",
    "--output-format",
    "json",
    ...(o.apiKey ? ["--bare"] : ["--setting-sources", "user"]),
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools,
    "--allowedTools",
    tools,
    ...(o.model ? ["--model", o.model] : []),
    ...(o.resume ? ["--resume", o.resume] : ["--session-id", o.sessionId ?? randomUUID()]),
  ];
}

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

/**
 * A Barista backed by `claude -p`, one process per turn (v3-1 Q74 A). A cafe Thread maps to a Claude session:
 * the first Order fixes its id with `--session-id`, Follow-ups continue it with `--resume`.
 */
export class ClaudeEngine implements Engine {
  readonly kind = "claude" as const;
  private readonly bin: string;
  private readonly log: (m: string) => void;
  private readonly opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.bin = opts.bin ?? process.env.CAFE_CLAUDE_BIN ?? "claude";
    this.log = opts.log ?? (() => {});
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const apiKey = !!process.env.ANTHROPIC_API_KEY;
    if (req.resume) {
      req.onSession?.(req.resume);
      const out = await this.exec(claudeArgs({ access: this.opts.access, model: this.opts.model, resume: req.resume, apiKey }), req.followup, req.signal);
      const r = this.result(out, req.resume);
      // The session is gone (deleted, other machine): start over with the full prompt. Only for that error, so a
      // real failure is never paid for twice.
      if (r.status === "failed" && /no conversation found|session .*not found/i.test(`${r.error} ${out.stderr}`)) {
        this.log(`claude: cannot resume session ${req.resume}; starting a new one`);
      } else {
        return r;
      }
    }
    const sessionId = randomUUID();
    req.onSession?.(sessionId);
    const out = await this.exec(claudeArgs({ access: this.opts.access, model: this.opts.model, sessionId, apiKey }), req.prompt, req.signal);
    return this.result(out, sessionId);
  }

  private result(out: RunOutcome, sessionId: string): TurnResult {
    if (out.aborted) return { status: "interrupted", text: "", sessionId };
    let parsed: { result?: string; is_error?: boolean; session_id?: string; subtype?: string } | undefined;
    const last = out.stdout.trim().split("\n").filter(Boolean).at(-1);
    try {
      parsed = last ? JSON.parse(last) : undefined;
    } catch {
      parsed = undefined;
    }
    const sid = parsed?.session_id ?? sessionId;
    if (out.code !== 0 || !parsed || parsed.is_error) {
      const why = parsed?.result ?? (out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`);
      return { status: "failed", text: "", sessionId: sid, error: `claude ${parsed?.subtype ?? `exit ${out.code}`}: ${why.slice(-500)}` };
    }
    return { status: "completed", text: String(parsed.result ?? "").trim(), sessionId: sid };
  }

  private exec(args: string[], stdin: string, signal: AbortSignal): Promise<RunOutcome> {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, CAFE_HEADLESS: "1" };
      // A Barista started from inside a Claude Code session must not look like a nested one.
      delete env.CLAUDECODE;
      const child = spawn(this.bin, args, { cwd: this.opts.dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let aborted = false;
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        resolve({ code, stdout, stderr, aborted });
      };
      // SIGINT ends the turn (headless docs); escalate if it lingers.
      const onAbort = () => {
        aborted = true;
        child.kill("SIGINT");
        timers.push(setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 3000));
        timers.push(setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 6000));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
      child.on("error", (err) => {
        stderr += `cannot start ${this.bin}: ${err.message}`;
        done(127);
      });
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-8192);
      });
      child.on("close", (code) => done(code));
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    });
  }

  async close(): Promise<void> {}
}
