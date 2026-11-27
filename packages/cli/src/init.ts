import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { CafeFile } from "@cafe/protocol";
import { readCafeFile } from "@cafe/protocol/cafe-file";

export interface InitOptions {
  dir?: string;
  name?: string;
  description?: string;
  tags?: string;
  scope?: string;
  role?: string;
  concurrency?: string;
  yes?: boolean;
  force?: boolean;
  /** Ask the person (default: only when stdin is a TTY and --yes is absent). */
  interactive?: boolean;
}

export interface InitResult {
  file: string;
  identity: CafeFile;
  next: string[];
}

function list(value: string | undefined): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const dir = resolve(opts.dir ?? ".");
  const file = join(dir, ".cafe");
  const existing = lstatSync(file, { throwIfNoEntry: false });
  if (existing?.isDirectory()) throw new Error(`${file} is a directory (cafe's data directory); refusing to replace it`);
  if (existing && !opts.force) throw new Error(`${file} already exists; edit it in place, or pass --force to replace a standalone identity`);
  if (existing && !existing.isFile()) throw new Error(`${file} is not a regular file; edit it in place`);

  let name = opts.name;
  let description = opts.description;
  let tags = opts.tags;
  let scope = opts.scope;
  let role = opts.role;
  let concurrency = opts.concurrency;

  mkdirSync(dir, { recursive: true });
  const ask = !opts.yes && opts.interactive !== false && process.stdin.isTTY && process.stdout.isTTY;
  if (ask) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const question = async (label: string, def: string) => (await rl.question(`${label} (${def}): `)).trim() || def;
      name = await question("name", name || basename(dir));
      description = await question("description", description || "");
      tags = await question("tags, comma-separated", tags || "");
      scope = await question("scope, comma-separated paths", scope || "");
      role = await question("role (barista/customer)", role || "barista");
      concurrency = await question("concurrency (headless workers)", concurrency || "1");
    } finally {
      rl.close();
    }
  }

  name = (name ?? basename(dir)).trim();
  const identity = CafeFile.safeParse({
    name,
    description: description ?? "",
    tags: list(tags),
    scope: list(scope),
    role: role ?? "barista",
    concurrency: Number(concurrency ?? 1),
  });
  if (!identity.success) {
    const issues = identity.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid .cafe: ${issues}`);
  }

  const id = identity.data;
  const content = `# Agent identity for cafe. ${basename(dir)} answers Orders matching this description.
# See \`cafe --help\` and the cafe skill. Edit this file, then reconnect the agent.
name: ${yamlString(id.name)}
description: ${yamlString(id.description)}
tags: [${id.tags.map(yamlString).join(", ")}]
scope: [${id.scope.map(yamlString).join(", ")}]
role: ${id.role}
concurrency: ${id.concurrency}
`;
  if (existing) {
    if (!existsSync(file)) throw new Error(`${file} disappeared while preparing the replacement`);
    let current: ReturnType<typeof readCafeFile>;
    try {
      current = readCafeFile(file);
    } catch (err) {
      throw new Error(`Repair ${file} in place before running init again. Original kept. ${(err as Error).message}`);
    }
    if (current.team) throw new Error(`${file} contains a team roster. Edit it in place. Original kept.`);
  }
  // Validate the serialized document before it can replace the old file.
  const scratch = mkdtempSync(join(dir, ".cafe-init-"));
  const candidate = join(scratch, ".cafe");
  try {
    writeFileSync(candidate, content, { mode: existing ? existing.mode & 0o777 : 0o644, flag: "wx" });
    readCafeFile(candidate);
    if (existing) {
      const current = lstatSync(file);
      if (!current.isFile() || current.dev !== existing.dev || current.ino !== existing.ino || current.ctimeMs !== existing.ctimeMs) {
        throw new Error(`${file} changed while preparing the replacement; edit it in place`);
      }
      renameSync(candidate, file);
    } else {
      writeFileSync(file, content, { mode: 0o644, flag: "wx" });
    }
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate);
    rmdirSync(scratch);
  }

  const next =
    id.role === "barista"
      ? [`cafe barista start --dir ${dir}`, `pi -e "$(cafe pi-extension-path)"`, `cafe daemon status`]
      : [`cafe mcp install`, `cafe ask "your first question"`, `cafe daemon status`];
  return { file, identity: id, next };
}
