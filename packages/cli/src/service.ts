import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function serviceFile(spec: ServiceSpec): ServiceFile {
  const home = spec.home ?? homedir();
  const log = join(spec.cafeHome, "daemon.log");
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
