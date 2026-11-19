import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { CafeFile } from "./index.ts";

export const CAFE_FILE_NAME = ".cafe";

/** Walk from `start` up to the filesystem root and return the nearest `.cafe` regular file. */
export function findCafeFile(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CAFE_FILE_NAME);
    let st;
    try {
      st = statSync(candidate, { throwIfNoEntry: false });
    } catch (err) {
      throw new Error(`cannot inspect .cafe at ${candidate}: ${(err as Error).message}`);
    }
    // A directory named `.cafe` is the data directory (`~/.cafe`), not an identity file.
    if (st?.isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const MINIMAL = "minimal file:\nname: my-agent\ndescription: what this agent can answer\n";

export function readCafeFile(path: string): CafeFile {
  let raw: unknown;
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(st?.isDirectory() ? "expected a YAML file, but this path is a directory" : "file not found");
    raw = parse(readFileSync(path, "utf8")) ?? {};
  } catch (err) {
    throw new Error(`invalid .cafe at ${path}: ${(err as Error).message}`);
  }
  const parsed = CafeFile.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid .cafe at ${path}: ${issues}\n${MINIMAL}`);
  }
  return parsed.data;
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
