import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type HostAgent = "pi" | "omp";

export function piSettingsPath(home = homedir()): string {
  return join(home, ".pi/agent/settings.json");
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export interface PiExtensionState {
  installed: boolean;
  settingsPath: string;
  entries: string[];
  entry?: string;
}

export function piExtensionState(home: string, source: string): PiExtensionState {
  const settingsPath = piSettingsPath(home);
  const settings = readJson(settingsPath);
  const entries: string[] = Array.isArray(settings.extensions) ? settings.extensions.filter((e: unknown): e is string => typeof e === "string") : [];
  const target = resolve(source);
  const entry = entries.find((e) => resolve(e) === target);
  return { installed: entry !== undefined, settingsPath, entries, ...(entry ? { entry } : {}) };
}

export function installPiExtension(home: string, source: string, opts: { dryRun?: boolean } = {}): { changed: boolean; alreadyInstalled: boolean; settingsPath: string; dryRun?: boolean } {
  const state = piExtensionState(home, source);
  if (state.installed) return { changed: false, alreadyInstalled: true, settingsPath: state.settingsPath };
  if (opts.dryRun) return { changed: true, alreadyInstalled: false, settingsPath: state.settingsPath, dryRun: true };
  const settings = readJson(state.settingsPath);
  settings.extensions = [...state.entries, resolve(source)];
  saveJson(state.settingsPath, settings);
  return { changed: true, alreadyInstalled: false, settingsPath: state.settingsPath };
}

export function removePiExtension(home: string, source: string): { changed: boolean; settingsPath: string } {
  const settingsPath = piSettingsPath(home);
  const settings = readJson(settingsPath);
  const entries: string[] = Array.isArray(settings.extensions) ? settings.extensions.filter((e: unknown): e is string => typeof e === "string") : [];
  const target = resolve(source);
  const kept = entries.filter((e) => resolve(e) !== target);
  const changed = kept.length !== entries.length;
  if (changed) {
    settings.extensions = kept;
    saveJson(settingsPath, settings);
  }
  return { changed, settingsPath };
}

/** The host's own install command: omp links packages and single files the same way. */
export function ompExtensionCommand(action: "install" | "uninstall", source: string, opts: { dryRun?: boolean; force?: boolean }): string[] {
  return ["omp", action, source, ...(opts.dryRun ? ["--dry-run"] : []), ...(opts.force ? ["--force"] : []), "--json"];
}

export interface OmpExtensionState {
  available: boolean;
  installed: boolean;
  detail: string;
}

export function ompExtensionState(source: string): OmpExtensionState {
  const r = spawnSync("omp", ["plugin", "list", "--json"], { encoding: "utf8", timeout: 3000 });
  if (r.error || r.status !== 0) return { available: false, installed: false, detail: r.error ? "omp not found on PATH" : (r.stderr || "omp plugin list failed").trim() };
  const text = r.stdout;
  const installed = text.includes(source) || text.includes("@cafe/pi-extension");
  return { available: true, installed, detail: installed ? "listed by omp plugin list" : "not listed by omp plugin list" };
}

/** Walk up from the bundled extension file to its package directory (repo layout). */
export function extensionPackageDir(source: string): string | undefined {
  let dir = dirname(resolve(source));
  for (let i = 0; i < 5; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).name === "@cafe/pi-extension") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
