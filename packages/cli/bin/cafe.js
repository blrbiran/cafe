#!/usr/bin/env node
import { checkNode } from "./node-check.mjs";

// Type stripping needs Node >= 22.18. Check before importing the .ts entry, or the
// user sees Node's ERR_UNKNOWN_FILE_EXTENSION instead of an actionable message.
checkNode();

// Silence node:sqlite's ExperimentalWarning; keep other warnings.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});
await import("../src/main.ts");
