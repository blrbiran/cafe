import { describe, expect, it } from "vitest";
import { pushBounded } from "../packages/daemon/src/bounded.ts";

describe("pushBounded", () => {
  it("keeps the newest items without growing past the cap", () => {
    const xs: number[] = [];
    for (const x of [1, 2, 3, 4, 5]) pushBounded(xs, x, 3);
    expect(xs).toEqual([3, 4, 5]);
  });

  it("does nothing beyond appending while under the cap", () => {
    const xs = ["a"];
    pushBounded(xs, "b", 5);
    expect(xs).toEqual(["a", "b"]);
  });
});