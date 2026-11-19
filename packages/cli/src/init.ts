import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
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
  if (existing && !opts.force) throw new Error(`${file} already exists; pass --force to overwrite it`);

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
name: ${id.name}
description: ${yamlString(id.description)}
tags: [${id.tags.map(yamlString).join(", ")}]
scope: [${id.scope.map(yamlString).join(", ")}]
role: ${id.role}
concurrency: ${id.concurrency}
`;
  if (existing && !existsSync(file)) throw new Error(`${file} disappeared while writing`);  writeFileSync(file, content, { mode: 0o644, flag: opts.force ? "w" : "wx" });
  readCafeFile(file); // prove the file we wrote is what the rest of cafe will read

  const next =
    id.role === "barista"
      ? [`cafe barista start --dir ${dir}`, `pi -e "$(cafe pi-extension-path)"`, `cafe daemon status`]
      : [`cafe mcp install`, `cafe ask "your first question"`, `cafe daemon status`];
  return { file, identity: id, next };
}
