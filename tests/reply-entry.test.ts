import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAttachMarkers } from "../packages/cli/src/artifacts.ts";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function upload(addr: string, name: string, body: string) {
  const res = await fetch(`http://${addr}/api/artifacts?name=${encodeURIComponent(name)}&mime=text/plain`, { method: "POST", body });
  expect(res.status).toBe(200);
  return (await res.json()) as { attachment: { id: string; name: string; host?: string } };
}

describe("reply attachments (v4-1 phase 2)", () => {
  it("parses CAFE_ATTACH lines out of a reply", () => {
    const { text, files } = parseAttachMarkers("answer\nCAFE_ATTACH: /tmp/a.log\nmore\n  CAFE_ATTACH: /tmp/b.txt  \n");
    expect(text).toBe("answer\nmore");
    expect(files).toEqual(["/tmp/a.log", "/tmp/b.txt"]);
  });

  it("accepts an HTTP reply from a target Barista with an attachment", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("helper"), async (h) => {
      await h.ack();
      await new Promise((r) => setTimeout(r, 5000));
    });
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "hi", to: "helper" });
    await waitFor(() => d.daemon.thread(res.threadId)?.meta.status === "working");

    const up = await upload(d.addr, "note.txt", "from the cli");
    // A non-target cannot reply while the Order is open.
    const bad = await fetch(`http://${d.addr}/api/threads/${res.threadId}/orders/${res.orderId}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cafe-operator-key": readFileSync(join(d.home, "operator.key"), "utf8") },
      body: JSON.stringify({ agent: "nobody@pc1", text: "x" }),
    });
    expect(bad.status).toBe(400);

    const reply = await fetch(`http://${d.addr}/api/threads/${res.threadId}/orders/${res.orderId}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cafe-operator-key": readFileSync(join(d.home, "operator.key"), "utf8") },
      body: JSON.stringify({ agent: "helper@pc1", text: "here it is", attachments: [up.attachment] }),
    });
    expect(reply.status).toBe(200);

    const events = await untilClosed(c, res.threadId, res.orderId);
    const ev = events.find((e) => e.event.type === "order.replied")!.event as { text: string; source?: string; attachments?: Array<{ name: string }> };
    expect(ev.text).toBe("here it is");
    expect(ev.source).toBe("operator");
    expect(ev.attachments).toMatchObject([{ name: "note.txt" }]);
  });

  it("rejects a reply to an Order that is not open", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("helper"));
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "hi", to: "helper" });
    await untilClosed(c, res.threadId, res.orderId);
    const late = await fetch(`http://${d.addr}/api/threads/${res.threadId}/orders/${res.orderId}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cafe-operator-key": readFileSync(join(d.home, "operator.key"), "utf8") },
      body: JSON.stringify({ agent: "helper@pc1", text: "late" }),
    });
    expect(late.status).toBe(400);
    expect(((await late.json()) as { error: string }).error).toBe("not_open");
  });
});