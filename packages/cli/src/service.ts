import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Autostart: run `cafe daemon run` as a per-user service (launchd on macOS,
 * systemd --user on Linux). Restarted after a crash, not after `cafe daemon stop`.
 */

export const LABEL = "dev.cafe.daemon";

export interface ServiceSpec {
  platform: NodeJS.Platform;
  node: string;
  /** packages/cli/bin/cafe.js */
  bin: string;
  cafeHome: string;
  /** PATH for the service, so headless Baristas can find `pi`, `claude`, `codex`. */
  path: string;
  home?: string;
}

export interface ServiceFile {
  file: string;
  content: string;
  /** Commands that load the service, in order. */
  load: string[][];
  unload: string[][];
  /** Start an installed but stopped service. */
  start: string[][];
}

/**
 * PATH for the service: this shell's PATH without duplicates, missing dirs, or
 * dirs that belong to this terminal session only (temp dirs, per-session wrapper
 * shims such as cmux's) — the service outlives the shell, and a shim that
 * disappears later would make `pi`/`claude` unresolvable for headless Baristas.
 */
export function servicePath(envPath: string | undefined, exists: (d: string) => boolean = existsSync, tmp = tmpdir()): string {
  const transient = (d: string) =>
    d.startsWith(tmp) || d.startsWith("/tmp/") || d.startsWith("/private/tmp/") || d.startsWith("/private/var/folders/") || d.startsWith("/var/folders/") ||
    /\/cmux-cli-shims\//.test(d);
  return [...new Set((envPath ?? "/usr/bin:/bin").split(":"))].filter((d) => d && !transient(d) && exists(d)).join(":");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function serviceFile(spec: ServiceSpec): ServiceFile {
  const home = spec.home ?? homedir();
  // The daemon writes its own timestamped, capped `daemon.log` (#66). These files only catch what
  // escapes the daemon (a crash before the logger opens, a Node-level warning), so they get their
  // own small file instead of appending raw untimed output to the real log.
  const log = join(spec.cafeHome, "daemon.stdout.log");
  if (spec.platform === "darwin") {
    const file = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const uid = process.getuid?.() ?? 501;
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.node)}</string>
    <string>${xml(spec.bin)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CAFE_HOME</key><string>${xml(spec.cafeHome)}</string>
    <key>PATH</key><string>${xml(spec.path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    return {
      file,
      content,
      load: [["launchctl", "bootstrap", `gui/${uid}`, file]],
      unload: [["launchctl", "bootout", `gui/${uid}/${LABEL}`]],
      start: [["launchctl", "kickstart", `gui/${uid}/${LABEL}`]],
    };
  }
  if (spec.platform === "linux") {
    const file = join(home, ".config", "systemd", "user", "cafe.service");
    const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
    const content = `[Unit]
Description=cafe daemon
After=network-online.target

[Service]
ExecStart=${q(spec.node)} ${q(spec.bin)} daemon run
Environment=${q(`CAFE_HOME=${spec.cafeHome}`)}
Environment=${q(`PATH=${spec.path}`)}
Restart=on-failure
RestartSec=10
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
    return {
      file,
      content,
      load: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "cafe.service"],
      ],
      unload: [["systemctl", "--user", "disable", "--now", "cafe.service"]],
      start: [["systemctl", "--user", "start", "cafe.service"]],
    };
  }
  throw new Error(`autostart is not supported on ${spec.platform} yet; run \`cafe daemon start\` from your login script`);
}

function run(cmds: string[][], ignoreErrors = false): void {
  for (const [cmd, ...args] of cmds) {
    try {
      execFileSync(cmd!, args, { stdio: "pipe" });
    } catch (err) {
      if (!ignoreErrors) throw new Error(`${[cmd, ...args].join(" ")} failed: ${((err as { stderr?: Buffer }).stderr ?? "").toString().trim() || (err as Error).message}`);
    }
  }
}

export function installService(f: ServiceFile): void {
  mkdirSync(dirname(f.file), { recursive: true });
  if (existsSync(f.file)) run(f.unload, true);
  writeFileSync(f.file, f.content);
  run(f.load);
}

export function uninstallService(f: ServiceFile): boolean {
  if (!existsSync(f.file)) return false;
  run(f.unload, true);
  rmSync(f.file, { force: true });
  return true;
}

/**
 * If autostart is installed for this CAFE_HOME, start the daemon through the
 * service manager (so it stays supervised) and return true. Returns false when
 * there is no such service or the service manager refused; callers then spawn.
 */
export function startInstalledService(cafeHome: string, platform: NodeJS.Platform = process.platform, home?: string, runner = run): boolean {
  let f: ServiceFile;
  try {
    f = serviceFile({ platform, node: "", bin: "", cafeHome, path: "", home });
  } catch {
    return false;
  }
  if (!existsSync(f.file)) return false;
  const installed = readFileSync(f.file, "utf8");
  const marker = platform === "darwin" ? `<key>CAFE_HOME</key><string>${xml(cafeHome)}</string>` : `CAFE_HOME=${cafeHome}"`;
  if (!installed.includes(marker)) return false;
  try {
    runner(f.start);
    return true;
  } catch {
    return false;
  }
}

/**
 * Point an installed autostart service at `bin` (normally `current/bin/cafe.js`)
 * and restart it. Returns false when no service is installed for this CAFE_HOME.
 * `cafe update apply` needs this: otherwise launchd/systemd restarts the old
 * entry and the health check sees the old version, forcing a rollback (#27).
 */
export function retargetInstalledService(
  cafeHome: string,
  bin: string,
  opts: { platform?: NodeJS.Platform; home?: string; node?: string; path?: string; runner?: typeof run } = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  // Locate the installed unit first, then reuse its node/PATH when rewriting it:
  // the updater's own PATH may not be the one headless Baristas need.
  let probe: ServiceFile;
  try {
    probe = serviceFile({ platform, node: "", bin: "", cafeHome, path: "", home: opts.home });
  } catch {
    return false;
  }
  if (!existsSync(probe.file)) return false;
  const installed = readFileSync(probe.file, "utf8");
  const marker = platform === "darwin" ? `<key>CAFE_HOME</key><string>${xml(cafeHome)}</string>` : `CAFE_HOME=${cafeHome}"`;
  if (!installed.includes(marker)) return false;
  const installedNode =
    platform === "darwin" ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(installed)?.[1] : /ExecStart="([^"]*)"/.exec(installed)?.[1];
  const installedPath = platform === "darwin" ? /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(installed)?.[1] : /Environment="PATH=([^"]*)"/.exec(installed)?.[1];
  let f: ServiceFile;
  try {
    f = serviceFile({
      platform,
      node: opts.node ?? installedNode ?? process.execPath,
      bin,
      cafeHome,
      path: opts.path ?? installedPath ?? servicePath(process.env.PATH),
      home: opts.home,
    });
  } catch {
    return false;
  }
  const runner = opts.runner ?? run;
  try {
    if (installed !== f.content) {
      runner(f.unload, true);
      writeFileSync(f.file, f.content);
      runner(f.load);
    } else {
      // Already pointed at `current`: a restart is enough to load the new release.
      runner(f.start);
    }
    return true;
  } catch {
    return false;
  }
}
