#!/usr/bin/env node
// Silence node:sqlite's ExperimentalWarning; keep other warnings.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});
await import("../src/main.ts");
