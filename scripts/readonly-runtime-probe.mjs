#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [binary, agent, extensionPath, ...flags] = process.argv.slice(2);
if (!binary || !agent || !extensionPath) {
  process.stderr.write("usage: readonly-runtime-probe.mjs <binary> <pi|omp> <extension> [...flags]\n");
  process.exit(64);
}
const here = fileURLToPath(import.meta.url);
const repoRoot = process.env.CAFE_REPO_ROOT ?? resolve(here, "../..");
const isolatedHome = join(tmpdir(), `cafe-runtime-probe-${process.pid}`);
mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
const expected = agent === "pi"
  ? ["read", "grep", "find", "ls", "cafe_agents", "cafe_ask", "cafe_reply", "cafe_decline"]
  : ["read", "grep", "glob", "cafe_agents", "cafe_ask", "cafe_reply", "cafe_decline"];
const child = spawn(binary, ["--mode", "rpc", "--no-session", ...flags], {
  cwd: isolatedHome,
  env: { ...process.env, HOME: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, "config"), CAFE_DAEMON: "", CAFE_TOKEN: "", CAFE_PROBE: "1", CAFE_REPO_ROOT: repoRoot, PI_OFFLINE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.resume();
for (let id = 1; id <= 3; id++) child.stdin.write(`${JSON.stringify({ id })}\n`);
child.stdin.end();
const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
child.on("close", () => {
  clearTimeout(killer);
  const messages = parse(stdout);
  const tools = names(messages.find((m) => m.id === 1));
  const call = messages.find((m) => m.id === 2);
  const probe = messages.find((m) => m.id === 3);
  const cafe = tools.filter((name) => name.startsWith("cafe_")).sort().join();
  const ok = tools.length === expected.length && expected.every((name) => tools.includes(name)) &&
    cafe === ["cafe_agents", "cafe_ask", "cafe_reply", "cafe_decline"].sort().join() &&
    (call?.error !== undefined || call?.success === false || call?.unavailable === true) &&
    probe?.success !== false;
  respond(ok, ok ? undefined : "runtime exposes or hides disallowed tools");
});
child.on("error", (error) => respond(false, error.message));

function parse(value) {
  return value.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { const parsed = JSON.parse(line); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; }
  });
}
function names(message) {
  const value = message?.tools ?? message?.result?.tools ?? message?.result?.names ?? message?.names ?? [];
  return [...new Set((Array.isArray(value) ? value : []).map((entry) => typeof entry === "string" ? entry : entry?.name).filter(Boolean))];
}
function respond(supported, reason) {
  const binaryHash = createHash("sha256").update(readFileSync(resolve(binary))).digest("hex");
  process.stdout.write(`${JSON.stringify({ supported, binaryHash, ...(reason ? { reason } : {}) })}\n`);
  process.exit(supported ? 0 : 1);
}
