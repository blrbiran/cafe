import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCafeFile, loadIdentity, readCafeFile } from "@cafe/protocol/cafe-file";

const dirs: string[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("findCafeFile", () => {
  it("skips a directory named .cafe and keeps walking up", () => {
    const home = temp("cafe-home-");
    mkdirSync(join(home, ".cafe")); // the data directory, not an identity file
    const project = join(home, "project", "sub");
    mkdirSync(project, { recursive: true });

    expect(findCafeFile(project)).toBeUndefined();
    const id = loadIdentity(project);
    expect(id.file).toBeUndefined();
    expect(id.cafe).toMatchObject({ name: "sub", role: "customer" });
  });

  it("still finds a real .cafe file in a parent directory", () => {
    const home = temp("cafe-home-");
    writeFileSync(join(home, ".cafe"), "name: parent\ndescription: parent identity\n");
    mkdirSync(join(home, "project", ".cafe"), { recursive: true });
    const project = join(home, "project", "sub");
    mkdirSync(project, { recursive: true });

    expect(findCafeFile(project)).toBe(join(home, ".cafe"));
    expect(loadIdentity(project).cafe.name).toBe("parent");
  });
});

describe("readCafeFile", () => {
  it("explains that a .cafe directory is not an identity file", () => {
    const dir = temp("cafe-dir-");
    const path = join(dir, ".cafe");
    mkdirSync(path);
    expect(() => readCafeFile(path)).toThrow(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*expected a YAML file`));
  });

  it("reports the field and a minimal template for an empty file", () => {
    const dir = temp("cafe-empty-");
    const path = join(dir, ".cafe");
    writeFileSync(path, "");
    expect(() => readCafeFile(path)).toThrow(/name.*minimal file|minimal file[\s\S]*name/is);
  });
});
