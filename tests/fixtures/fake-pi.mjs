#!/usr/bin/env node
// Stand-in for `pi --mode rpc` in supervisor tests: ignores its args, records its pid, chatters, sleeps.
import { appendFileSync } from "node:fs";

if (process.env.FAKE_PI_PIDFILE) appendFileSync(process.env.FAKE_PI_PIDFILE, `${process.pid}\n`);
const timer = setInterval(() => process.stdout.write(`fake pi ${process.pid} alive ${Date.now()}\n`), 100);
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
const exitAfter = Number(process.env.FAKE_PI_EXIT_AFTER_MS ?? 0);
if (exitAfter > 0) setTimeout(() => process.exit(3), exitAfter);
