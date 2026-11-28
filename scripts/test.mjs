import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const scratch = mkdtempSync(join(tmpdir(), "cafe-test-"));
const env = { ...process.env, CAFE_HOME: scratch, CAFE_DAEMON: "127.0.0.1:1", CAFE_DISCOVERY: "0" };
delete env.CAFE_TOKEN;

// Test clients must never fall through to the user's running daemon or local credentials.
const result = spawnSync(process.execPath, [vitest, "run", "--attachmentsDir", join(scratch, "attachments"), ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
