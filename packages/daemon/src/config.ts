import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { DEFAULT_PORT } from "@cafe/protocol";

export const CafeConfig = z.object({
  mode: z.enum(["daemon", "root"]).default("daemon"),
  host: z.string().default(() => hostname().replace(/\.local$/, "").replace(/[^a-zA-Z0-9_.-]/g, "-")),
  port: z.number().int().default(DEFAULT_PORT),
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
    })
    .default({}),
  /** LAN discovery over mDNS: the Root answers, a Daemon without `root` looks for one. */
  discovery: z.boolean().default(true),
  /** Root only: last known URLs of Daemons, for dial-back after the Root moves. */
  knownDaemons: z.record(z.string(), z.string()).default({}),
});
export type CafeConfig = z.infer<typeof CafeConfig>;

export function cafeHome(): string {
  return process.env.CAFE_HOME ?? join(homedir(), ".cafe");
}

export function configPath(home = cafeHome()): string {
  return join(home, "config.yml");
}

export function loadConfig(home = cafeHome()): CafeConfig {
  const path = configPath(home);
  const raw = existsSync(path) ? (parse(readFileSync(path, "utf8")) ?? {}) : {};
  const cfg = CafeConfig.parse(raw);
  // Persist generated defaults (token, host) so they stay stable across runs.
  if (!existsSync(path)) saveConfig(cfg, home);
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
  const parts = key.split(".");
  let obj = cfg;
  for (const p of parts.slice(0, -1)) obj = obj[p] ??= {};
  const last = parts.at(-1)!;
  obj[last] = /^\d+$/.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value === "" ? undefined : value;
  const next = CafeConfig.parse(cfg);
  saveConfig(next, home);
  return next;
}
