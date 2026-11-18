// cafe worker guard: `node guard.mjs <command> [args...]`.
//
// Pattern from ccloop scripts/claude-phase-runner.mjs (watchParent / onParentGone): the supervisor spawns this
// guard as the leader of a new process group and hands it an extra pipe as fd 3 that it never writes to. When
// the supervisor dies (even by SIGKILL) the OS closes its end, fd 3 ends here, and the guard stops the whole
// group: SIGTERM to the worker, then SIGKILL to the group after a grace. The worker (pi) stays in the guard's
// group, so the supervisor can also stop everything with one signal to -guardPid.
import { spawn } from "node:child_process";
import { Socket } from "node:net";

const GRACE_MS = Number(process.env.CAFE_GUARD_GRACE_MS ?? 5000);
const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("[cafe-guard] usage: guard.mjs <command> [args...]\n");
  process.exit(2);
}

let child;
let stopping = false;

function killOwnGroup() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

function stop(reason) {
  if (stopping) return;
  stopping = true;
  process.stderr.write(`[cafe-guard] stopping worker: ${reason}\n`);
  try {
    child?.kill("SIGTERM");
  } catch {
    /* exited */
  }
  // Whatever happens, nothing in this group outlives the grace.
  setTimeout(killOwnGroup, GRACE_MS).unref?.();
}

function watchParent() {
  if (process.env.CAFE_GUARD_FD !== "3") return;
  let watch;
  try {
    watch = new Socket({ fd: 3, readable: true, writable: false });
  } catch {
    stop("parent watch pipe unavailable");
    return;
  }
  const gone = () => {
    process.stdout.on("error", () => {});
    process.stderr.on("error", () => {});
    process.on("exit", killOwnGroup);
    stop("supervisor (cafe daemon) is gone");
  };
  watch.on("end", gone);
  watch.on("close", gone);
  watch.on("error", gone);
  watch.resume();
  watch.unref();
}

// A SIGTERM/SIGINT sent to the group reaches the worker directly; the guard waits for it, bounded by the grace.
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGHUP", () => stop("SIGHUP"));

child = spawn(command, args, { stdio: ["inherit", "inherit", "inherit"], env: process.env });
child.on("error", (err) => {
  if (err.code === "ENOENT") process.stderr.write(`[cafe-guard] executable not found: ${command} (set CAFE_PI_BIN)\n`);
  else process.stderr.write(`[cafe-guard] spawn error: ${err.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  const status = code ?? (signal ? 128 + (signalNumber(signal) ?? 15) : 1);
  // Grandchildren still holding the group's pipes are SIGKILLed by the supervisor after a short drain.
  process.exit(status);
});
watchParent();

function signalNumber(name) {
  return { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[name];
}
