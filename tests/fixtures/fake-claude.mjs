#!/usr/bin/env node
// Fake `claude -p --output-format json` for tests, no model. Sessions persist as files in FAKE_CLAUDE_STATE;
// argv is appended to FAKE_CLAUDE_LOG. Questions with SLOW wait for SIGINT, DECLINE decline, FAIL fail.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\n");
const state = process.env.FAKE_CLAUDE_STATE;
const resume = opt("--resume");
const sessionId = resume ?? opt("--session-id");
const file = join(state, `${sessionId}.json`);
if (resume && !existsSync(file)) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: `No conversation found with session ID: ${resume}`, session_id: resume }) + "\n");
  process.exit(1);
}
let text = "";
process.stdin.on("data", (d) => (text += d));
process.stdin.on("end", () => {
  const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { turns: [] };
  s.turns.push(text);
  writeFileSync(file, JSON.stringify(s));
  const lines = text.split("\n");
  const followup = text.startsWith("Follow-up from");
  const q = followup ? lines[2] : lines[lines.indexOf("Question:") + 1];
  if (q.includes("SLOW")) {
    process.on("SIGINT", () => process.exit(130));
    setInterval(() => {}, 1000);
    return;
  }
  if (q.includes("FAIL")) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "it broke", session_id: sessionId }) + "\n");
    process.exit(1);
  }
  const result = q.includes("DECLINE") ? "CAFE_DECLINE: not my topic" : `turn=${s.turns.length} kind=${followup ? "followup" : "fresh"} q=${q}`;
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: sessionId }) + "\n");
});
