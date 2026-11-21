import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CafeHttpClient } from "./client.ts";
import { openState, readJsonFile, type ConnectorState } from "./state.ts";

export type ConnectorConfig = Record<string, unknown>;

export interface ConnectorContext {
  /** HTTP/SSE view of the Daemon (Orders, Threads, replies). */
  cafe: CafeHttpClient;
  /** Contents of CAFE_CONNECTOR_CONFIG ({} when the file is absent). */
  config: ConnectorConfig;
  /** Writable directory for threads.json / seen-events.json / outbox.json. */
  stateDir: string;
  /** Connector name from CAFE_CONNECTOR_NAME. */
  name: string;
  /** Address recorded as `via` on Orders, e.g. `discord@host`. */
  address: string;
  threads: ConnectorState["threads"];
  seen: ConnectorState["seen"];
  outbox: ConnectorState["outbox"];
  /** Logging goes to stderr; stdout is reserved for the JSON line protocol. */
  log(line: string): void;
  /** Emit `{"type":"heartbeat","at":<ms>,"ok":true}` (also sent on an interval). */
  heartbeat(ok?: boolean): void;
  /** Emit `{"type":"error","message":"…"}`. */
  error(message: string): void;
  /** Emit one JSON line (used for connector-specific lines such as replies). */
  emit(line: Record<string, unknown>): void;
}

export type ConnectorHandler = (ctx: ConnectorContext) => Promise<void>;

export interface ConnectorOptions {
  /** Override the process environment (tests). */
  env?: NodeJS.ProcessEnv;
  /** Input used by a connector that reads stdin; defaults to process.stdin. */
  input?: NodeJS.ReadableStream | AsyncIterable<string | Buffer>;
  /** One JSON line sink; defaults to process.stdout. */
  output?: (line: Record<string, unknown>) => void;
  /** Human log sink; defaults to process.stderr. */
  log?: (line: string) => void;
  /** Heartbeat interval; 0 disables the interval (one heartbeat is still sent at start). */
  heartbeatMs?: number;
}

export interface ConnectorMain {
  run(): Promise<void>;
  stop(): void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeHost(): string {
  return hostname().replace(/\.local$/, "").replace(/[^a-zA-Z0-9_.-]/g, "-") || "host";
}

export function createConnectorContext(opts: ConnectorOptions = {}): ConnectorContext {
  const env = opts.env ?? process.env;
  const output = opts.output ?? ((line: Record<string, unknown>) => void process.stdout.write(`${JSON.stringify(line)}\n`));
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const stateDir = env.CAFE_CONNECTOR_STATE ?? join(process.cwd(), "connector-state");
  const configPath = env.CAFE_CONNECTOR_CONFIG;
  const config = configPath && existsSync(configPath) ? readJsonFile<ConnectorConfig>(configPath, {}) : {};
  if (configPath && !existsSync(configPath)) log(`config file ${configPath} does not exist; continuing with defaults`);
  const name = env.CAFE_CONNECTOR_NAME ?? "connector";
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const state = openState(stateDir);
  const configuredAddress = typeof config.address === "string" && config.address ? config.address : undefined;

  return {
    cafe: new CafeHttpClient({ daemon: env.CAFE_DAEMON, token: env.CAFE_TOKEN }),
    config,
    stateDir,
    name,
    address: configuredAddress ?? `${name}@${safeHost()}`,
    ...state,
    log,
    emit: output,
    heartbeat: (ok = true) => output({ type: "heartbeat", at: Date.now(), ok }),
    error: (message: string) => output({ type: "error", message }),
  };
}

/**
 * Define a connector's main function. The SDK builds the context (HTTP client,
 * config, persistent state, stdout protocol, heartbeat) so the connector only
 * adapts its platform's events.
 *
 * ```ts
 * const main = defineConnector(async (ctx) => { ... });
 * await main.run();
 * ```
 */
export function defineConnector(fn: ConnectorHandler, opts: ConnectorOptions = {}): ConnectorMain {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const run = async (): Promise<void> => {
    const env = opts.env ?? process.env;
    const ctx = createConnectorContext(opts);
    const envMs = Number(env.CAFE_CONNECTOR_HEARTBEAT_MS);
    const heartbeatMs = opts.heartbeatMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : 30_000);
    ctx.heartbeat(true);
    if (heartbeatMs > 0) {
      timer = setInterval(() => {
        if (!stopped) ctx.heartbeat(true);
      }, heartbeatMs);
      timer.unref?.();
    }
    try {
      await fn(ctx);
    } catch (err) {
      ctx.error(messageOf(err));
      throw err;
    } finally {
      stop();
    }
  };

  return { run, stop };
}

/** True when this module is the process entry point (`node connector.js`). */
export function isEntryPoint(url: string | URL): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    // On macOS /var is a symlink to /private/var: import.meta.url reports the
    // real path while argv keeps the path as typed.
    return realpathSync(resolve(argv)) === realpathSync(fileURLToPath(url));
  } catch {
    try {
      return resolve(argv) === resolve(fileURLToPath(url));
    } catch {
      return false;
    }
  }
}