/** What a bridged Barista may do in its directory (v3-1 Q75). Never full access. */
export type Access = "read-only" | "workspace-write";

export type AgentKind = "codex" | "claude";

export interface TurnRequest {
  /** Full prompt for a fresh session (identity, history, question). */
  prompt: string;
  /** Short prompt used when `resume` continues a session that already holds the earlier turns. */
  followup: string;
  /** External session to continue (Codex thread id, Claude session id). */
  resume?: string;
  signal: AbortSignal;
  /** Called once the session id is known, before the turn finishes (so a crash mid-turn still resumes). */
  onSession?: (sessionId: string) => void;
}

export interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  text: string;
  sessionId?: string;
  error?: string;
}

/** One coding agent driven by a bridge: runs one turn at a time. */
export interface Engine {
  readonly kind: AgentKind;
  run(req: TurnRequest): Promise<TurnResult>;
  close(): Promise<void>;
}

export interface EngineOptions {
  dir: string;
  access: Access;
  model?: string;
  /** Executable (tests use fakes); defaults to `codex` / `claude`, or CAFE_CODEX_BIN / CAFE_CLAUDE_BIN. */
  bin?: string;
  log?: (msg: string) => void;
}
