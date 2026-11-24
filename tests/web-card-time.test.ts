import { describe, expect, it } from "vitest";
import { cardTime } from "../packages/web/src/format.ts";

// A follow-up (for example a Discord message hours later) kept the card at "10 hours ago" because the card showed
// when the first question was asked. The card now shows the Thread's latest activity; the title stays the first question.
describe("Conversation card time", () => {
  it("is the latest activity, not when the first question was asked", () => {
    expect(cardTime({ createdAt: 1_000, lastActivityAt: 9_000 })).toBe(9_000);
  });
  it("falls back to the creation time when nothing happened since", () => {
    expect(cardTime({ createdAt: 1_000 })).toBe(1_000);
  });
});
