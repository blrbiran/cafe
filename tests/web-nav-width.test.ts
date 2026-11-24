import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #62: the sidebar width used to be two independent hardcoded values — the nav's Tailwind class and
 * `--nav-width` in the stylesheet. Changing one left the wide-screen drawer geometry subtracting the
 * other, so the two disagreed. The width must come from `--nav-width` only, because the drawer's
 * `calc(100vw - var(--nav-width) - 680px)` reads the same variable.
 */

const web = join(import.meta.dirname, "..", "packages", "web", "src");
const shell = readFileSync(join(web, "Shell.tsx"), "utf8");
const styles = readFileSync(join(web, "styles.css"), "utf8");
const index = readFileSync(join(web, "index.css"), "utf8");

describe("resizable sidebar (#62)", () => {
  it("keeps the width in one place: --nav-width", () => {
    expect(styles).toMatch(/--nav-width:\s*\d+px/);
    // The nav reads the variable; it must not carry a second literal width.
    expect(shell).toMatch(/w-\[var\(--nav-width\)\]/);
    expect(shell).not.toMatch(/w-\[240px\]/);
  });

  it("keeps the wide-screen drawer geometry on the same variable", () => {
    expect(index).toMatch(/calc\(100vw - var\(--nav-width\) - 680px\)/);
  });

  it("resizes by dragging, remembers the width, and restores the default on double-click", () => {
    expect(shell).toMatch(/cafe\.nav\.width/);
    expect(shell).toMatch(/role="separator"/);
    expect(shell).toMatch(/onPointerDown=\{startNavResize\}/);
    expect(shell).toMatch(/onDoubleClick=\{resetNavWidth\}/);
    // Keyboard parity for the drag, so the divider is usable without a pointer.
    expect(shell).toMatch(/ArrowLeft/);
    expect(shell).toMatch(/ArrowRight/);
  });
});