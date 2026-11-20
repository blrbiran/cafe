import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadIdentity } from "@cafe/protocol/cafe-file";
import { defaultExtensionPath, loadConfig } from "@cafe/daemon";
import { ompExtensionState, piExtensionState } from "./extension.ts";
import { claudeCommandState } from "./commands.ts";

export interface DoctorCheck {
  name: string;
  level: "ok" | "warn" | "fail";
  detail: string;
  next?: string;
}

export interface DoctorOptions {
  base: string;
  home: string;
  cwd: string;
  token?: string;
  userHome?: string;
  source?: string;
  fetchImpl?: typeof fetch;
}

export async function runDoctor(opts: DoctorOptions): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const get = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  let daemonInfo: any;
  try {
    const res = await get(`${opts.base}/api/health`, { signal: AbortSignal.timeout(1500), headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    daemonInfo = await res.json();
    checks.push({ name: "daemon", level: "ok", detail: `${daemonInfo.host}${daemonInfo.isRoot ? " (root)" : ""} at ${opts.base}${daemonInfo.version ? `, cafe ${daemonInfo.version}` : ""}` });
  } catch (err) {
    checks.push({ name: "daemon", level: "fail", detail: `not reachable at ${opts.base}: ${(err as Error).message}`, next: "cafe daemon start" });
  }

  try {
    const id = loadIdentity(opts.cwd);
    if (id.file) checks.push({ name: "identity", level: "ok", detail: `${id.file} (${id.cafe.name}, ${id.cafe.role})` });
    else checks.push({ name: "identity", level: "warn", detail: `${opts.cwd} has no .cafe; this session is an anonymous customer`, next: "cafe init" });
  } catch (err) {
    checks.push({ name: "identity", level: "fail", detail: (err as Error).message, next: "cafe init" });
  }

  const userHome = opts.userHome ?? homedir();
  const source = opts.source ?? defaultExtensionPath();
  const pi = piExtensionState(userHome, source);
  checks.push(
    pi.installed
      ? { name: "extension", level: "ok", detail: `pi: installed in ${pi.settingsPath}` }
      : { name: "extension", level: "warn", detail: `pi: not installed (${source})`, next: "cafe extension install --agent pi" },
  );
  const omp = ompExtensionState(source);
  if (omp.available && !omp.installed) checks.push({ name: "omp", level: "warn", detail: `omp: ${omp.detail}`, next: "cafe extension install --agent omp" });

  const skillLinks = [join(userHome, ".claude/skills/cafe"), join(userHome, ".agents/skills/cafe")].filter((p) => existsSync(p));
  checks.push(
    skillLinks.length
      ? { name: "skill", level: "ok", detail: skillLinks.join(", ") }
      : { name: "skill", level: "warn", detail: "the cafe skill is not linked for Claude Code / Codex", next: "cafe skill install" },
  );

  const command = claudeCommandState(userHome);
  if (command.state === "ours") checks.push({ name: "command", level: "ok", detail: `/cafe-ask (${command.path})` });
  else if (command.state === "foreign") {
    checks.push({ name: "command", level: "warn", detail: `/cafe-ask at ${command.path} is not managed by cafe`, next: "cafe commands install --agent claude --force" });
  } else {
    checks.push({ name: "command", level: "ok", detail: "/cafe-ask is not installed (optional; the Claude plugin already provides /cafe)", next: "cafe commands install --agent claude" });
  }

  const cfg = loadConfig(opts.home);
  if (cfg.router.model && daemonInfo) {
    if (daemonInfo.router !== "llm") {
      checks.push({ name: "router", level: "fail", detail: `configured ${cfg.router.model}, but the daemon is using rules${daemonInfo.error ? ` (${daemonInfo.error})` : ""}`, next: `cafe router set ${cfg.router.model}` });
    } else if (daemonInfo.model !== cfg.router.model) {
      checks.push({ name: "router", level: "fail", detail: `configured ${cfg.router.model}, running ${daemonInfo.model}`, next: `cafe router set ${cfg.router.model}` });
    } else {
      checks.push({ name: "router", level: "ok", detail: `llm (${daemonInfo.model})` });
    }
  } else {
    checks.push(
      cfg.router.model
        ? { name: "router", level: "ok", detail: `llm (${cfg.router.model} configured; daemon not running)` }
        : { name: "router", level: "ok", detail: "rules (no router.model configured)", next: "cafe config set router.model <provider/model>" },
    );
  }

  if (cfg.mode === "root") {
    checks.push({ name: "root", level: "ok", detail: "this daemon is the Root" });
  } else if (!cfg.root) {
    checks.push({ name: "root", level: "warn", detail: "no root configured; mDNS discovery may find one on the LAN", next: "cafe root set <host:port>" });
  } else {
    try {
      const res = await get(`http://${cfg.root}/api/health`, { signal: AbortSignal.timeout(1500), headers });
      if (!res.ok) throw new Error(res.status === 401 ? "unauthorized (check token)" : `HTTP ${res.status}`);
      const info: any = await res.json();
      checks.push({ name: "root", level: "ok", detail: `${cfg.root} online${info.version ? ` (cafe ${info.version})` : ""}` });
    } catch (err) {
      checks.push({ name: "root", level: "fail", detail: `${cfg.root}: ${(err as Error).message}`, next: `cafe root set ${cfg.root}` });
    }
  }

  return { ok: checks.every((c) => c.level !== "fail"), checks };
}
