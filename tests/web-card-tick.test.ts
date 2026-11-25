import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #33: an in-progress Feed card ran `useNow(1_000)` at the top of ThreadCardImpl, so the whole card
// (status, asker, summary, preview) re-rendered every second while anything was in progress. Only the
// elapsed-time text needs a 1 s tick; it lives in its own small component, like <OutcomeText> in
// Conversation.tsx.
const feed = readFileSync(resolve(import.meta.dirname, "../packages/web/src/pages/Feed.tsx"), "utf8");

function body(name: string): string {
  const at = feed.indexOf(`function ${name}(`);
  expect(at, name).toBeGreaterThanOrEqual(0);
  const open = feed.indexOf("{\n", at);
  let depth = 0;
  for (let i = open; i < feed.length; i++) {
    if (feed[i] === "{") depth++;
    else if (feed[i] === "}" && --depth === 0) return feed.slice(at, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe("Feed card ticking (#33)", () => {
  it("does not tick the whole card every second", () => {
    const card = body("ThreadCardImpl");
    expect(card).not.toMatch(/useNow\([^)]*1_000/);
    expect(card).toMatch(/useNow\(30_000\)/);
  });

  it("ticks only the elapsed-time text each second", () => {
    const tick = body("ElapsedText");
    expect(tick).toMatch(/useNow\(1_000\)/);
    expect(body("ThreadCardImpl")).toContain("<ElapsedText");
  });
});
