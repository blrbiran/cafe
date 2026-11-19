#!/usr/bin/env node
// Fake `codex app-server` seen from outside a running Codex TUI: the stored-session methods the cafe TUI Barista
// uses (thread/list, thread/queue/add|delete, thread/turns/list). State lives as JSON files in FAKE_CODEX_STATE:
//   threads.json        [{ id, cwd, updatedAt, ephemeral }]
//   queue-<thread>.json [{ id, clientUserMessageId, text }]
//   turns-<thread>.json [{ id, status, completedAt, items }]  (newest first, as Codex lists them)
// The test plays the TUI: it takes items off the queue and writes turns. Every message is logged to FAKE_CODEX_LOG.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") process.exit(2);
const state = process.env.FAKE_CODEX_STATE;
const logFile = process.env.FAKE_CODEX_LOG;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const log = (m) => logFile && appendFileSync(logFile, JSON.stringify(m) + "\n");
const read = (name, fallback) => (existsSync(join(state, name)) ? JSON.parse(readFileSync(join(state, name), "utf8")) : fallback);
const write = (name, v) => {
  writeFileSync(join(state, `${name}.tmp`), JSON.stringify(v));
  renameSync(join(state, `${name}.tmp`), join(state, name));
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  const p = m.params ?? {};
  const ok = (result) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize":
      if (!p.capabilities?.experimentalApi) return send({ id: m.id, error: { code: -32600, message: "needs experimentalApi" } });
      return ok({ userAgent: "fake-codex-tui" });
    case "initialized":
      return;
    case "thread/list":
      return ok({ data: read("threads.json", []), nextCursor: null });
    case "thread/queue/add": {
      if (!read("threads.json", []).some((t) => t.id === p.threadId)) return send({ id: m.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } });
      const item = { id: randomUUID(), clientUserMessageId: p.clientUserMessageId, text: p.input?.[0]?.text ?? "" };
      write(`queue-${p.threadId}.json`, [...read(`queue-${p.threadId}.json`, []), item]);
      return ok({ queuedSubmission: { id: item.id, input: p.input, clientUserMessageId: p.clientUserMessageId } });
    }
    case "thread/queue/delete": {
      const q = read(`queue-${p.threadId}.json`, []);
      const left = q.filter((i) => i.id !== p.queuedSubmissionId);
      write(`queue-${p.threadId}.json`, left);
      return ok({ deleted: left.length !== q.length });
    }
    case "thread/turns/list":
      return ok({ data: read(`turns-${p.threadId}.json`, []).slice(0, p.limit ?? 20), nextCursor: null });
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
});
