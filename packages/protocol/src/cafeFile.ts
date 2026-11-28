import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { CafeDocument, type AgentIdentity, type CafeFile, type TeamMember, type TeamSpec } from "./index.ts";

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

export function readCafeFile(path: string): CafeDocument {
  let raw: unknown;
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(st?.isDirectory() ? "expected a YAML file, but this path is a directory" : "file not found");
    raw = parse(readFileSync(path, "utf8")) ?? {};
  } catch (err) {
    throw new Error(`invalid .cafe at ${path}: ${(err as Error).message}`);
  }
  const parsed = CafeDocument.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid .cafe at ${path}: ${issues}\n${MINIMAL}`);
  }
  validateTeam(parsed.data, path);
  return parsed.data;
}

/** Lowercase and replace anything outside `[a-z0-9_-]`; dots (valid in a name) become dashes. */
export function sanitizeChannel(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Cross-field team rules that zod cannot express. Mutates the parsed team so callers see the
 * concrete channel and each member's effective channel list.
 */
function validateTeam(doc: CafeDocument, path: string): void {
  const team = doc.team;
  if (!team) return;
  const fail = (msg: string): never => {
    throw new Error(`invalid .cafe at ${path}: ${msg}`);
  };
  const teamName = team.name ?? doc.name;
  const channel = team.channel ?? sanitizeChannel(teamName);
  if (!/^[a-z0-9_-]{1,64}$/.test(channel) || channel === "default") {
    fail(`team channel '${channel}' is invalid or reserved; set team.channel explicitly`);
  }
  team.name = teamName;
  team.channel = channel;
  const seen = new Set<string>();
  let orchestrators = 0;
  for (const m of team.members) {
    if (seen.has(m.name)) fail(`team member '${m.name}' is listed twice`);
    seen.add(m.name);
    if (m.mode === "tui" && m.access !== undefined) fail(`TUI member '${m.name}' cannot declare access; Cafe cannot restrict tools inside a user-owned terminal`);
    if (m.name === teamName) fail(`team member '${m.name}' may not have the same name as the team; \`to: ${m.name}\` would be ambiguous`);
    m.channels = m.channels?.length ? m.channels : [channel];
    if (!m.channels.includes(channel)) fail(`team member '${m.name}' must include the team channel '${channel}' in channels`);
    if (m.observer && !m.channels.includes(channel)) fail(`observer '${m.name}' must include the team channel '${channel}'`);
    // v4-13: the orchestrator is structural. Normalise the spelling once so every consumer
    // (`teams()`, the playbook, `to: <team>`) sees the same value.
    if (m.duty && m.duty.trim().toLowerCase() === "orchestrator") {
      m.duty = "orchestrator";
      orchestrators++;
      if (m.observer) fail(`'${m.name}' cannot be both the orchestrator and an observer`);
    }
  }
  if (orchestrators !== 1) {
    fail(`team '${teamName}' must list exactly one member with duty: orchestrator (found ${orchestrators}); the orchestrator is the team's front door (v4-13)`);
  }
}

/** Load a team roster member by name. `teamDir` is the directory holding the roster `.cafe`. */
export function loadTeamMember(teamDir: string, memberName: string): { file: string; cafe: CafeDocument; team: TeamSpec; member: TeamMember } {
  const file = join(resolve(teamDir), CAFE_FILE_NAME);
  const cafe = readCafeFile(file);
  if (!cafe.team) throw new Error(`${file} has no team block`);
  const member = cafe.team.members.find((m) => m.name === memberName);
  if (!member) {
    throw new Error(`unknown team member '${memberName}' in ${file}; roster: ${cafe.team.members.map((m) => m.name).join(", ")}`);
  }
  return { file, cafe, team: cafe.team, member };
}

/**
 * The identity a process should register. A member selected by `member`/`CAFE_TEAM_MEMBER` (with
 * `teamDir`/`CAFE_TEAM_DIR`) wins over the top-level `.cafe` identity; its roster is authoritative
 * even when the member's own directory has no `.cafe` (v4-11).
 */
/** Captures launch-critical roster settings for the lifetime of a TUI session. */
export function memberLaunchHash(rosterDir: string, team: TeamSpec, member: TeamMember, memberDir?: string): string {
  const root = realpathSync(rosterDir);
  const path = memberDir ?? realpathSync(resolve(root, member.dir));
  return createHash("sha256").update(JSON.stringify([
    root, team.name, team.channel, member.name, member.mode, member.agent ?? team.agent ?? "pi",
    member.bin ?? null, path, member.access ?? null, member.channels ?? [team.channel], Boolean(member.observer), member.collect ?? "any",
  ])).digest("hex");
}

export function loadAgentIdentity(cwd: string): { file?: string; cafe: CafeDocument; team?: TeamSpec; member?: TeamMember; identity: Omit<AgentIdentity, "mode" | "cwd"> } {
  const memberName = process.env.CAFE_TEAM_MEMBER;
  const teamDir = process.env.CAFE_TEAM_DIR;
  if (memberName) {
    const rosterDir = teamDir ?? cwd;
    const loaded = loadTeamMember(rosterDir, memberName);
    const { team, member, file } = loaded;
    return {
      file,
      cafe: loaded.cafe,
      team,
      member,
      identity: {
        name: member.name,
        description: member.description,
        tags: member.tags,
        scope: member.scope,
        role: "barista",
        concurrency: 1,
        team: team.name,
        teamChannel: team.channel,
        teamDir: resolve(rosterDir),
        member: member.name,
        ...(member.mode === "tui" ? { memberLaunchHash: memberLaunchHash(rosterDir, team, member) } : {}),
        ...(member.duty ? { duty: member.duty } : {}),
        channels: member.channels ?? [team.channel!],
        ...(member.observer ? { observer: true } : {}),
      },
    };
  }
  const file = findCafeFile(cwd);
  const cafe = file ? readCafeFile(file) : CafeDocument.parse({ name: (resolve(cwd).split(/[\\/]/).filter(Boolean).pop() ?? "anon").replace(/[^a-zA-Z0-9_.-]/g, "-") || "anon", role: "customer" });
  return {
    file,
    cafe,
    identity: { name: cafe.name, description: cafe.description, tags: cafe.tags, scope: cafe.scope, role: cafe.role, concurrency: cafe.concurrency },
  };
}
export function loadIdentity(cwd: string): { file?: string; cafe: CafeFile; document: CafeDocument } {
  const file = findCafeFile(cwd);
  if (file) {
    const document = readCafeFile(file);
    // `cafe` keeps the pre-v4-11 shape (no team block), so spreading it into an AgentIdentity stays valid.
    return { file, cafe: document, document };
  }
  const base = resolve(cwd).split(/[\\/]/).filter(Boolean).pop() ?? "anon";
  const name = base.replace(/[^a-zA-Z0-9_.-]/g, "-") || "anon";
  const document = CafeDocument.parse({ name, role: "customer" });
  return { cafe: document, document };
}
