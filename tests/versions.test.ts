import { afterEach, describe, expect, it } from "vitest";
import { onlineVersions, PROTOCOL_VERSION } from "@cafe/protocol";
import { startDaemon, waitFor } from "./helpers.ts";

type D = Awaited<ReturnType<typeof startDaemon>>;
const running: D[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});

/** Send one raw `initialize` frame and return the response frame. */
function rawInitialize(addr: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${addr}/ws`);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "initialize", params })));
    ws.addEventListener("message", (e) => {
      resolve(JSON.parse(String(e.data)));
      ws.close();
    });
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
}

describe("cafe versions across Daemons", () => {
  it("each side learns the other's cafe version", async () => {
    const root = await startDaemon("vr", { config: { mode: "root" }, version: "0.2.0" });
    running.push(root);
    const child = await startDaemon("vc", { config: { root: root.addr }, version: "0.1.0" });
    running.push(child);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "vc" && d.online));
    const seenByRoot = Object.fromEntries(root.daemon.daemons().map((d) => [d.host, d.version]));
    expect(seenByRoot).toEqual({ vr: "0.2.0", vc: "0.1.0" });
    expect(onlineVersions(root.daemon.daemons())).toEqual(["0.1.0", "0.2.0"]);
    await waitFor(() => child.daemon.daemons().some((d) => d.isRoot && d.online));
    expect(child.daemon.daemons().find((d) => d.isRoot)?.version).toBe("0.2.0");
  });

  it("refuses another protocol version and says how to fix it", async () => {
    const root = await startDaemon("vp", { config: { mode: "root" }, version: "0.3.0" });
    running.push(root);
    const res = await rawInitialize(root.addr, { protocolVersion: PROTOCOL_VERSION + 1, kind: "daemon", token: "t0k", host: "old", url: "ws://x", cafeVersion: "9.0.0" });
    expect(res.error.code).toBe("protocol_mismatch");
    expect(res.error.message).toContain("old (cafe 9.0.0)");
    expect(res.error.message).toContain("vp (cafe 0.3.0)");
    expect(res.error.message).toContain("@blrbiran/cafe@0.3.0");
  });
});
