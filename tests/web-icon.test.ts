import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// #74: the tab icon was an inline ☕ emoji data-URI. It renders as a blurred colour glyph at 16 px,
// differs between light and dark tab bars, and does not match the sidebar's line-drawn cafe cup.
// The icon is now a real SVG asset the browser can scale crisply.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repo, "packages/web/index.html"), "utf8");

describe("web tab icon (#74)", () => {
  it("points at an SVG asset instead of an emoji data-URI", () => {
    const link = /<link[^>]+rel="icon"[^>]*>/.exec(html)?.[0] ?? "";
    expect(link).toContain('href="/icon.svg"');
    expect(link).not.toContain("data:image/svg+xml");
    expect(link).not.toContain("☕");
    expect(html).not.toContain("☕");
  });

  it("ships the icon asset with a vector cup", () => {
    const icon = join(repo, "packages/web/public/icon.svg");
    expect(existsSync(icon)).toBe(true);
    const svg = readFileSync(icon, "utf8");
    expect(svg).toContain("<svg");
    // No <text> node: an emoji/text glyph is what a 16 px tab bar renders badly.
    expect(svg).not.toContain("<text");
    expect((svg.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  // #84: a transparent icon put dark strokes straight onto a dark tab bar. The first shape must be an
  // opaque white plate covering the whole viewBox.
  it("draws on an opaque white plate so it reads on a dark tab bar", () => {
    const svg = readFileSync(join(repo, "packages/web/public/icon.svg"), "utf8");
    const first = /<svg[^>]*>\s*<(\w+)([^>]*)>/.exec(svg);
    expect(first?.[1]).toBe("rect");
    const attrs = first?.[2] ?? "";
    expect(attrs).toMatch(/\bwidth="24"/);
    expect(attrs).toMatch(/\bheight="24"/);
    expect(attrs).toMatch(/fill="(#fff|#ffffff|white)"/i);
    expect(attrs).not.toMatch(/opacity/);
  });
});
