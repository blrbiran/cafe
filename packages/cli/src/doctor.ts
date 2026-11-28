import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadIdentity, tuiAccessNotice } from "@cafe/protocol/cafe-file";
import { CURRENT_FEATURES, missingFeatures } from "@cafe/protocol";
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
    // v4-12: a Daemon that does not advertise the current feature set is likely older than this CLI.
    if (Array.isArray(daemonInfo.features)) {
      const missing = missingFeatures(daemonInfo.features, [...CURRENT_FEATURES]);
      checks.push(
        missing.length
          ? { name: "features", level: "warn", detail: `${daemonInfo.host} (cafe ${daemonInfo.version ?? "unknown"}) does not advertise ${missing.join(", ")}`, next: `restart the daemon on ${daemonInfo.host} (cafe daemon restart) after upgrading it` }
          : { name: "features", level: "ok", detail: `${daemonInfo.features.length} feature(s) advertised` },
      );
    } else {
      checks.push({ name: "features", level: "warn", detail: `${daemonInfo.host} does not advertise features (older build, or a v4-11 build before this release)`, next: "restart the daemon after upgrading (cafe daemon restart); teammates keep working meanwhile" });
    }
  } catch (err) {
    checks.push({ name: "daemon", level: "fail", detail: `not reachable at ${opts.base}: ${(err as Error).message}`, next: "cafe daemon start" });
  }

  try {
    const ignored: string[] = [];
    const id = loadIdentity(opts.cwd, { onIgnoredTuiAccess: (member) => ignored.push(member) });
    if (id.file && ignored.length) checks.push({ name: "identity", level: "warn", detail: `${id.file}: ${tuiAccessNotice(ignored)}`, next: "cafe team status" });
    else if (id.file) checks.push({ name: "identity", level: "ok", detail: `${id.file} (${id.cafe.name}, ${id.cafe.role})` });
    else checks.push({ name: "identity", level: "warn", detail: `${opts.cwd} has no .cafe; this session is an anonymous customer`, next: "cafe init" });
  } catch (err) {
    checks.push({ name: "identity", level: "fail", detail: (err as Error).message, next: "back up the existing .cafe and fix the reported YAML or settings in place" });
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

  // Native Barista runtimes (optional unless you use --agent codex / claude).
  for (const [bin, flag] of [
    ["codex", "--agent codex"],
    ["claude", "--agent claude"],
  ] as const) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
    if (r.error || r.status !== 0) {
      checks.push({ name: bin, level: "warn", detail: `${bin} not on PATH (needed for ${flag})`, next: `install ${bin} and sign in` });
    } else {
      const line = (r.stdout || r.stderr || "").trim().split("\n")[0] ?? "";
      checks.push({ name: bin, level: "ok", detail: line.slice(0, 120) });
    }
  }

  const skillLinks = [join(userHome, ".claude/skills/cafe"), join(userHome, ".agents/skills/cafe")].filter((p) => existsSync(p));
  checks.push(
    skillLinks.length
      ? { name: "skill", level: "ok", detail: skillLinks.join(", ") }
      : { name: "skill", level: "warn", detail: "the cafe skill is not linked for Claude Code / Codex", next: "cafe skill install" },
  );

  const command = claudeCommandState(userHome);
  if (command.state === "ours") checks.push({ name: "command", level: "ok", detail: `/cafe (${command.path})` });
  else if (command.state === "foreign") {
    checks.push({ name: "command", level: "warn", detail: `/cafe at ${command.path} is not managed by cafe`, next: "cafe commands install --agent claude --force" });
  } else {
    checks.push({ name: "command", level: "ok", detail: "/cafe is not installed (optional; /cafe-barista comes from the Claude plugin)", next: "cafe commands install --agent claude" });
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

  let rootFromDaemon = false;
  if (cfg.mode === "root") {
    checks.push({ name: "root", level: "ok", detail: "this daemon is the Root" });
  } else if (!cfg.root) {
    checks.push({ name: "root", level: "warn", detail: "no root configured; mDNS discovery may find one on the LAN", next: "cafe root set <host:port>" });
  } else if (cfg.security.mode !== "plaintext") {
    // TLS invariant (v4-6 §10.3): the CLI never dials the Root in plaintext with the token. The daemon
    // holds the encrypted uplink, so its own view of the hub is reported below (from /api/doctor).
    if (!daemonInfo) checks.push({ name: "root", level: "warn", detail: `${cfg.root}: cannot check the hub while the daemon is not running (it holds the encrypted link)`, next: "cafe daemon start" });
    else rootFromDaemon = true;
  } else {
    try {
      const res = await get(`http://${cfg.root}/api/health`, { signal: AbortSignal.timeout(1500), headers });
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? cfg.token
              ? "unauthorized (token mismatch; compare `cafe config get token` on both hosts)"
              : "unauthorized (no token configured; run `cafe connect <root> --token <token>`)"
            : `HTTP ${res.status}`,
        );
      }
      const info: any = await res.json();
      checks.push({ name: "root", level: "ok", detail: `${cfg.root} online${info.version ? ` (cafe ${info.version})` : ""}` });
    } catch (err) {
      const msg = (err as Error).message;
      const next = msg.startsWith("unauthorized") && cfg.token ? "cafe config get token" : msg.startsWith("unauthorized") ? `cafe connect ${cfg.root} --token <token>` : `cafe root set ${cfg.root}`;
      checks.push({ name: "root", level: "fail", detail: `${cfg.root}: ${msg}`, next });
    }
  }

  // Transport and supervised-Barista state live in the daemon (v4-6 §10.3 #81A, #82): show its view.
  if (daemonInfo) {
    try {
      const res = await get(`${opts.base}/api/doctor`, { signal: AbortSignal.timeout(1500), headers });
      if (res.ok) {
        const remote = ((await res.json()) as { checks?: DoctorCheck[] }).checks ?? [];
        for (const c of remote) {
          if (c.name === "tls" || c.name === "tls-links" || c.name === "barista") checks.push(c);
          else if (c.name === "root" && rootFromDaemon) {
            checks.push(c);
            rootFromDaemon = false;
          }
        }
      }
    } catch {
      // An older daemon without /api/doctor: nothing more to add.
    }
  }
  if (rootFromDaemon) checks.push({ name: "root", level: "warn", detail: `${cfg.root}: this daemon does not report the hub's state (older cafe)`, next: "cafe daemon status" });

  return { ok: checks.every((c) => c.level !== "fail"), checks };
}
