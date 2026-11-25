import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { DEFAULT_PORT } from "@cafe/protocol";

export const CafeConfig = z.object({
  mode: z.enum(["daemon", "root"]).default("daemon"),
  host: z.string().default(() => hostname().replace(/\.local$/, "").replace(/[^a-zA-Z0-9_.-]/g, "-")),
  port: z.number().int().default(DEFAULT_PORT),
  /** User-visible name for this Host (defaults to `host`). Renaming does not change Addresses. */
  displayName: z.string().optional(),
  /** Previous display names that still identify this Host. */
  aliases: z.array(z.string()).default([]),
  /** Old names kept for routing only (automatic on rename); not shown as the current label. */
  legacyAliases: z.array(z.string()).default([]),
  /** Address other Daemons should use to reach this one; defaults to first LAN IPv4. */
  advertise: z.string().optional(),
  token: z.string().default(() => randomBytes(16).toString("hex")),
  /** host:port of the Root Daemon (mode=daemon). */
  root: z.string().optional(),
  router: z
    .object({
      /** `provider/model`, resolved through pi's ModelRuntime. Unset = rules only. */
      model: z.string().optional(),
      fallback: z.enum(["rules", "root"]).default("rules"),
      /** Use recent declines as a weak tie-breaker between Baristas (docs/specs/v2-1-routing-hints.md). */
      learn: z.boolean().default(true),
      /** Give up on the model after this long and route with rules. */
      timeoutMs: z.number().int().positive().default(10_000),
      /** At most this many Order routings may ask the model at once. */
      concurrency: z.number().int().min(1).default(2),
    })
    .default({}),
  /** Automatic pruning: delete finished threads and stats older than `days`. Unset = never (use `cafe prune`). */
  retention: z.object({ days: z.number().int().positive().optional() }).default({}),
  /** Order / reply files. Blobs live under CAFE_HOME/artifacts, never in the Thread JSONL. */
  attachments: z
    .object({
      maxMb: z.number().int().positive().default(25),
      threadMaxMb: z.number().int().positive().default(100),
      maxCount: z.number().int().positive().default(10),
    })
    .default({}),
  /** LAN discovery over mDNS: the Root answers, a Daemon without `root` looks for one. */
  discovery: z.boolean().default(true),
  /** Root only: last known URLs of Daemons, for dial-back after the Root moves. */
  knownDaemons: z.record(z.string(), z.string()).default({}),
  /**
   * Root only: addresses a person set by hand. They win over whatever a child reports about itself,
   * because a child behind Docker/NAT only knows an address that is useless to everyone else (#75).
   */
  pinnedDaemons: z.record(z.string(), z.string()).default({}),
  /** Root only: display-name overrides for Daemons that may be offline when renamed. */
  hostNames: z.record(z.string(), z.object({ displayName: z.string().optional(), aliases: z.array(z.string()).default([]), legacyAliases: z.array(z.string()).default([]) })).default({}),
  /**
   * Transport security (v4-6 #61). `tls` is the default and there is no plaintext fallback; a TLS
   * failure is an error. `plaintext` is a deliberate local/isolation escape hatch, not a mode the
   * daemon picks by itself.
   */
  security: z
    .object({
      mode: z.enum(["tls", "plaintext"]).default("tls"),
      tls: z
        .object({
          /** Plaintext stays on `port`; this is the TLS listener's port (0 = pick a free one). */
          port: z.number().int().min(0).default(4778),
          /** CA certificate path; defaults to `CAFE_HOME/tls/ca.crt`. */
          ca: z.string().optional(),
          /** TOFU pin for the CA (`cafe connect --ca-fingerprint`). */
          caFingerprint: z.string().optional(),
          /** Per-peer leaf pin, keyed by `host:port`. */
          pins: z.record(z.string(), z.string()).default({}),
          /**
           * Extra names other machines dial this Host by (a VPN address, a DNS name), added to the
           * leaf next to every local IPv4 address (#91). `cafe daemon renew-cert --san` appends here.
           */
          sans: z.array(z.string()).default([]),
        })
        .default({}),
    })
    .default({}),
});
export type CafeConfig = z.infer<typeof CafeConfig>;

/** The object shape under defaults/optionals, or undefined for a leaf. */
function shapeOf(type: unknown): Record<string, unknown> | undefined {
  let t: any = type;
  for (let i = 0; i < 5 && t; i++) {
    const shape = t._def?.shape;
    if (shape) return typeof shape === "function" ? shape() : shape;
    t = t._def?.innerType;
  }
  return undefined;
}

function isRecord(type: unknown): boolean {
  let t: any = type;
  for (let i = 0; i < 5 && t; i++) {
    if (t._def?.typeName === "ZodRecord" || t._def?.type === "record") return true;
    t = t._def?.innerType;
  }
  return false;
}

function walkKeys(shape: Record<string, unknown>, prefix: string, keys: string[], records: string[]): void {
  for (const [name, type] of Object.entries(shape)) {
    const key = `${prefix}${name}`;
    keys.push(key);
    if (isRecord(type)) records.push(key);
    const inner = shapeOf(type);
    if (inner) walkKeys(inner, `${key}.`, keys, records);
  }
}

const SCHEMA_KEYS: string[] = [];
const RECORD_KEYS: string[] = [];
walkKeys(CafeConfig.shape as Record<string, unknown>, "", SCHEMA_KEYS, RECORD_KEYS);

/** Every dotted key the schema knows, down to the leaves (#94), for `cafe config get` and `set`. */
export const CONFIG_KEYS: readonly string[] = SCHEMA_KEYS;

/**
 * Is `key` one `cafe config get` / `set` accept? A known key, or an entry of a map-valued key
 * (`security.tls.pins.<host:port>`, `knownDaemons.<host>`).
 */
export function isConfigKey(key: string): boolean {
  return CONFIG_KEYS.includes(key) || RECORD_KEYS.some((r) => key.startsWith(`${r}.`) && key.length > r.length + 1);
}

/**
 * The path segments of a config key. A map entry's own name stays one segment even when it has dots
 * (`security.tls.pins.10.0.0.5:4778` → `security`, `tls`, `pins`, `10.0.0.5:4778`).
 */
export function configKeyPath(key: string): string[] {
  const record = RECORD_KEYS.filter((r) => key.startsWith(`${r}.`)).sort((a, b) => b.length - a.length)[0];
  return record ? [...record.split("."), key.slice(record.length + 1)] : key.split(".");
}

export function cafeHome(): string {
  return process.env.CAFE_HOME ?? join(homedir(), ".cafe");
}

/**
 * How a config change reaches the running daemon: `hot` keys are applied by
 * `/api/reload`; everything else needs `cafe daemon restart`. Kept next to the
 * schema so CLI and Web describe the same contract.
 */
export function configApplyMode(key: string): "hot" | "restart-required" {
  // A pin changes nothing the listener owns: it is checked per connection, so it can change live.
  if (key === "security.tls.caFingerprint" || key.startsWith("security.tls.pins.")) return "hot";
  return key === "root" || key.startsWith("router.") ? "hot" : "restart-required";
}

/** Leaves worth comparing between config.yml and the running daemon. */
const DIFF_KEYS = [
  "mode",
  "host",
  "displayName",
  "port",
  "advertise",
  "root",
  "router.model",
  "router.fallback",
  "router.learn",
  "router.timeoutMs",
  "router.concurrency",
  "retention.days",
  "attachments.maxMb",
  "attachments.threadMaxMb",
  "attachments.maxCount",
  "discovery",
  "security.mode",
  "security.tls.port",
  "security.tls.ca",
  "security.tls.caFingerprint",
] as const;

function leaf(obj: unknown, key: string): unknown {
  return key.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

export interface ConfigDiff {
  key: string;
  file: unknown;
  running: unknown;
  mode: "hot" | "restart-required";
}

/** Compare what is saved in config.yml with what the daemon is actually using. */
export function diffConfig(file: unknown, running: unknown): ConfigDiff[] {
  const out: ConfigDiff[] = [];
  for (const key of DIFF_KEYS) {
    const a = leaf(file, key);
    const b = leaf(running, key);
    // port: 0 means "pick a free port"; the running daemon reports the one it got.
    if (key === "port" && (a === 0 || a == null)) continue;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push({ key, file: a, running: b, mode: configApplyMode(key) });
  }
  return out;
}

export function configPath(home = cafeHome()): string {
  return join(home, "config.yml");
}

/**
 * A short, stable id for a CAFE_HOME (its resolved path, hashed). The daemon reports it in
 * /api/health so `cafe daemon stop|restart` can tell its own daemon from another home's daemon
 * on the same port (#88). The path itself is not exposed.
 */
export function homeId(home = cafeHome()): string {
  let path = resolve(home);
  try {
    path = realpathSync(path);
  } catch {
    // A home that does not exist yet still has a stable id.
  }
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export function configInitialized(home = cafeHome()): boolean {
  return existsSync(configPath(home));
}

/**
 * Read the config. Defaults fill anything missing. Only the daemon (and explicit writes such as
 * `cafe config set`) persist a generated config: a read-only command on an empty CAFE_HOME must
 * not create one, or "is this home initialized?" stops being answerable (#88).
 */
export function loadConfig(home = cafeHome(), opts: { persist?: boolean } = {}): CafeConfig {
  const path = configPath(home);
  const raw = existsSync(path) ? (parse(readFileSync(path, "utf8")) ?? {}) : {};
  const cfg = CafeConfig.parse(raw);
  // Persist generated defaults (token, host) so they stay stable across runs.
  if (opts.persist && !existsSync(path)) saveConfig(cfg, home);
  return cfg;
}

export function saveConfig(cfg: CafeConfig, home = cafeHome()): void {
  mkdirSync(home, { recursive: true });
  const path = configPath(home);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, stringify(cfg), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Set a dotted key (e.g. `router.model`) and persist. Returns the new config. */
export function setConfigValue(key: string, value: string, home = cafeHome()): CafeConfig {
  const cfg = loadConfig(home) as Record<string, any>;
  if (!isConfigKey(key)) throw new Error(`unknown config key '${key}'`);
  const parts = configKeyPath(key);
  let obj = cfg;
  for (const p of parts.slice(0, -1)) obj = obj[p] ??= {};
  const last = parts.at(-1)!;
  obj[last] = /^\d+$/.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value === "" ? undefined : value;
  const next = CafeConfig.parse(cfg);
  saveConfig(next, home);
  return next;
}
