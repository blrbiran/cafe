import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The production default is `security.mode: tls` on the fixed port 4778 (v4-6). A scratch Daemon
// that writes its own config without a `security` block therefore fights the real Root — and every
// other scratch Daemon — for 4778, and `npm run test:release` fails on any machine with a Root.
// Observed live on 2026-11-24: the release smoke's `daemon start` died with
// `listen EADDRINUSE: address already in use 0.0.0.0:4778`.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function scratchConfigs(): Array<{ file: string; text: string }> {
  return [
    { file: "scripts/test-release.mjs", text: readFileSync(join(repo, "scripts/test-release.mjs"), "utf8") },
    { file: "scripts/sim-hosts.sh", text: readFileSync(join(repo, "scripts/sim-hosts.sh"), "utf8") },
  ];
}

describe("scratch Daemon configs stay off the TLS port", () => {
  for (const { file, text } of scratchConfigs()) {
    it(`${file} writes security.mode: plaintext`, () => {
      expect(text).toMatch(/security:\s*\\?n?\s*mode:\s*plaintext|mode: plaintext/);
    });
  }
});