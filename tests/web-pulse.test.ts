import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #33: the "in progress" dot pulsed by animating box-shadow, which repaints every frame. Measured on an idle
// Feed with one active Thread: ~170 ms of main-thread work per second (2.7 ms/s without the pulse). An
// infinite animation must use compositor-only properties (transform, opacity).
const web = resolve(import.meta.dirname, "../packages/web/src");
const css = ["index.css", "styles.css"].map((f) => readFileSync(resolve(web, f), "utf8")).join("\n");

function keyframes(name: string): string {
  const at = css.indexOf(`@keyframes ${name}`);
  expect(at, `@keyframes ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unterminated @keyframes ${name}`);
}

describe("infinite animations stay on the compositor", () => {
  it("animates only transform and opacity in every infinite animation", () => {
    const infinite = [...css.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)].map((m) => m[1]!);
    expect(infinite.length).toBeGreaterThan(0);
    for (const name of infinite) {
      const props = [...keyframes(name).matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]!);
      expect(props.filter((p) => p !== "transform" && p !== "opacity"), name).toEqual([]);
    }
  });
});
