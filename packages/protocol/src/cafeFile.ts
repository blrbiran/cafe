import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { CafeFile } from "./index.ts";

export const CAFE_FILE_NAME = ".cafe";

/** Walk from `start` up to the filesystem root and return the nearest `.cafe` path. */
export function findCafeFile(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CAFE_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readCafeFile(path: string): CafeFile {
  const raw = parse(readFileSync(path, "utf8")) ?? {};
  return CafeFile.parse(raw);
}

/**
 * Resolve the identity for an Agent started in `cwd`. Without a `.cafe`,
 * the Agent joins anonymously as a Customer named after the directory.
 */
export function loadIdentity(cwd: string): { file?: string; cafe: CafeFile } {
  const file = findCafeFile(cwd);
  if (file) return { file, cafe: readCafeFile(file) };
  const base = resolve(cwd).split(/[\\/]/).filter(Boolean).pop() ?? "anon";
  const name = base.replace(/[^a-zA-Z0-9_.-]/g, "-") || "anon";
  return { cafe: CafeFile.parse({ name, role: "customer" }) };
}
