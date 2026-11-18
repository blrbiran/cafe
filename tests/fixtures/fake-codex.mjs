#!/usr/bin/env node
// Fake `codex app-server` for tests: the v2 methods the cafe bridge uses, no model.
// Threads persist as files in FAKE_CODEX_STATE (so a new process can thread/resume them); every message
// received is appended to FAKE_CODEX_LOG. Questions containing SLOW wait for turn/interrupt; DECLINE declines.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") process.exit(2);
const state = process.env.FAKE_CODEX_STATE;
const logFile = process.env.FAKE_CODEX_LOG;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const log = (m) => logFile && appendFileSync(logFile, JSON.stringify(m) + "\n");
const threadFile = (id) => join(state, `${id}.json`);
const waiting = new Map(); // server request id -> resolve
const interrupts = new Map(); // turnId -> resolve
let srv = 0;

function ask(method, params) {
  const id = `srv-${++srv}`;
  return new Promise((r) => {
    waiting.set(id, r);
    send({ id, method, params });
  });
}

async function runTurn(threadId, turnId, text) {
  const t = JSON.parse(readFileSync(threadFile(threadId), "utf8"));
  t.turns.push(text);
  writeFileSync(threadFile(threadId), JSON.stringify(t));
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
  await ask("item/commandExecution/requestApproval", { threadId, turnId, itemId: "cmd-1", command: "rm -rf /" });
  const lines = text.split("\n");
  const followup = text.startsWith("Follow-up from");
  const q = followup ? lines[2] : lines[lines.indexOf("Question:") + 1];
  if (q.includes("SLOW")) {
    await new Promise((r) => interrupts.set(turnId, r));
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } } });
    return;
  }
  const answer = q.includes("DECLINE") ? "CAFE_DECLINE: not my topic" : `turn=${t.turns.length} kind=${followup ? "followup" : "fresh"} q=${q}`;
  send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "m1", text: "looking…", phase: "commentary" } } });
  send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "m2", text: answer, phase: "final_answer" } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m.result);
    waiting.delete(m.id);
    return;
  }
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { userAgent: "fake-codex", platformOs: "test" } });
    case "initialized":
      return;
    case "thread/start": {
      const id = randomUUID();
      writeFileSync(threadFile(id), JSON.stringify({ turns: [], params: p }));
      return send({ id: m.id, result: { thread: { id }, sandbox: p.sandbox, approvalPolicy: p.approvalPolicy } });
    }
    case "thread/resume":
      if (!existsSync(threadFile(p.threadId))) return send({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${p.threadId}` } });
      return send({ id: m.id, result: { thread: { id: p.threadId } } });
    case "turn/start": {
      if (!existsSync(threadFile(p.threadId))) return send({ id: m.id, error: { code: -32600, message: "thread not loaded" } });
      const turnId = randomUUID();
      send({ id: m.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      void runTurn(p.threadId, turnId, p.input?.[0]?.text ?? "");
      return;
    }
    case "turn/interrupt":
      interrupts.get(p.turnId)?.();
      return send({ id: m.id, result: {} });
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
});
