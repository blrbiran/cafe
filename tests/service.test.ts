import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, serviceFile, servicePath, startInstalledService } from "../packages/cli/src/service.ts";

const spec = { node: "/opt/node/bin/node", bin: "/repo/packages/cli/bin/cafe.js", cafeHome: "/u/.cafe", path: "/opt/node/bin:/usr/bin", home: "/u" };

describe("autostart service files", () => {
  it("writes a launchd agent that restarts only after a crash", () => {
    const f = serviceFile({ ...spec, platform: "darwin" });
    expect(f.file).toBe(`/u/Library/LaunchAgents/${LABEL}.plist`);
    expect(f.content).toContain("<string>/opt/node/bin/node</string>\n    <string>/repo/packages/cli/bin/cafe.js</string>\n    <string>daemon</string>\n    <string>run</string>");
    expect(f.content).toContain("<key>SuccessfulExit</key><false/>");
    expect(f.content).toContain("<key>CAFE_HOME</key><string>/u/.cafe</string>");
    expect(f.content).toContain("<string>/u/.cafe/daemon.log</string>");
    expect(f.load[0]!.slice(0, 2)).toEqual(["launchctl", "bootstrap"]);
  });

  it("writes a systemd user unit on Linux", () => {
    const f = serviceFile({ ...spec, platform: "linux" });
    expect(f.file).toBe("/u/.config/systemd/user/cafe.service");
    expect(f.content).toContain('ExecStart="/opt/node/bin/node" "/repo/packages/cli/bin/cafe.js" daemon run');
    expect(f.content).toContain("Restart=on-failure");
    expect(f.load.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "cafe.service"]);
  });

  it("keeps PATH entries that outlive the terminal session", () => {
    const p = servicePath(
      "/u/.cmuxterm/cmux-cli-shims/020F/:/opt/node/bin:/tmp/x:/var/folders/ab/T/y:/gone:/usr/bin:/opt/node/bin",
      (d) => d !== "/gone",
      "/var/folders/ab/T",
    );
    expect(p).toBe("/opt/node/bin:/usr/bin");
  });

  it("starts the daemon through the service only when it is installed for this CAFE_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-svc-"));
    const ran: string[][] = [];
    const runner = (cmds: string[][]) => void ran.push(...cmds);
    expect(startInstalledService("/u/.cafe", "darwin", home, runner)).toBe(false);
    const f = serviceFile({ ...spec, home, platform: "darwin" });
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(f.file, f.content);
    expect(startInstalledService("/other/.cafe", "darwin", home, runner)).toBe(false);
    expect(startInstalledService("/u/.cafe", "darwin", home, runner)).toBe(true);
    expect(ran).toEqual([["launchctl", "kickstart", expect.stringMatching(new RegExp(`^gui/\\d+/${LABEL}$`))]]);
    const failing = () => {
      throw new Error("not loaded");
    };
    expect(startInstalledService("/u/.cafe", "darwin", home, failing)).toBe(false);
  });

  it("refuses other platforms with a hint", () => {
    expect(() => serviceFile({ ...spec, platform: "win32" })).toThrow(/cafe daemon start/);
  });
});
