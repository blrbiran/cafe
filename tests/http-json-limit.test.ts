import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "./helpers.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const maxBytes = 1024 * 1024;

function post(base: string, body: string, chunked: boolean) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(`${base}/api/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer t0k",
        ...(chunked ? {} : { "content-length": Buffer.byteLength(body) }),
      },
    }, (res) => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("timed out waiting for JSON response")));
    if (chunked) {
      req.write(body.slice(0, body.length / 2));
      req.end(body.slice(body.length / 2));
    } else {
      // The declared length alone must be enough to reject the request.
      req.flushHeaders();
    }
  });
}

describe("HTTP JSON body limit", () => {
  it.each([false, true])("rejects bodies above 1 MiB before creating an Order (chunked=%s)", async (chunked) => {
    const d = await startDaemon("json-limit", { mode: "root" });
    cleanup.push(d.stop);
    const base = `http://${d.addr}`;
    const payload = JSON.stringify({ body: "a".repeat(maxBytes) });
    expect(await post(base, payload, chunked)).toMatchObject({ status: 413, body: { error: "body_too_large" } });
    expect(d.daemon.store.listThreads(1)).toEqual([]);
  });

  it("accepts a JSON body at the limit and persists the complete question", async () => {
    const d = await startDaemon("json-limit", { mode: "root" });
    cleanup.push(d.stop);
    const question = "a".repeat(maxBytes - Buffer.byteLength('{"body":""}'));
    const res = await post(`http://${d.addr}`, JSON.stringify({ body: question }), true);
    expect(res.status).toBe(200);
    const created = d.daemon.thread(res.body.threadId)?.events.find((e) => e.event.type === "order.created")?.event;
    expect(created?.type === "order.created" && created.order.body).toBe(question);
  });
});
