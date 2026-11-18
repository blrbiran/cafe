import { describe, expect, it } from "vitest";
import { LABEL, serviceFile } from "../packages/cli/src/service.ts";

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

  it("refuses other platforms with a hint", () => {
    expect(() => serviceFile({ ...spec, platform: "win32" })).toThrow(/cafe daemon start/);
  });
});
