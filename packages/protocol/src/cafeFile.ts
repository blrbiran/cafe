import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { AgentAssignment, AgentResumeState, AgentResumeStore } from "./client.ts";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { CafeDocument, type AgentIdentity, type CafeFile, type TeamMember, type TeamSpec } from "./index.ts";

export const CAFE_FILE_NAME = ".cafe";

function loadAgentState<T>(file: string, maxBytes: number): T | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > maxBytes) throw new Error("invalid managed Agent state file");
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } finally {
    closeSync(fd);
  }
}

function saveAgentState(file: string, state: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}

/** The supervisor supplies a dedicated state file for each managed Worker. */
export function managedAgentResumeStore(file = process.env.CAFE_AGENT_RESUME_FILE): AgentResumeStore | undefined {
  if (!file) return undefined;
  const queueFile = `${file}.queue`;
  type Entry = { item: AgentAssignment; claimed: boolean };
  const readQueue = () => loadAgentState<Entry[]>(queueFile, 64 * 1024 * 1024) ?? [];
  const storeQueue = (entries: Entry[]) => {
    if (Buffer.byteLength(JSON.stringify(entries)) > 64 * 1024 * 1024) throw new Error("managed Agent queue is full");
    saveAgentState(queueFile, entries);
  };
  return {
    daemonScope: file,
    load: () => loadAgentState<AgentResumeState>(file, 8192),
    save: (state) => saveAgentState(file, state),
    queue: {
      put(item) {
        const entries = readQueue();
        const existing = entries.find((entry) => entry.item.assignmentId === item.assignmentId);
        if (existing) {
          if (existing.item.order.orderId !== item.order.orderId || existing.item.order.threadId !== item.order.threadId) throw new Error("conflicting managed Agent assignment");
          return;
        }
        if (entries.length >= 500) throw new Error("managed Agent queue is full");
        storeQueue([...entries, { item, claimed: false }]);
      },
      list: () => readQueue().map(({ item }) => item),
      isClaimed: (assignmentId) => readQueue().find(({ item }) => item.assignmentId === assignmentId)?.claimed ?? false,
      claim(assignmentId) {
        const entries = readQueue();
        const entry = entries.find(({ item }) => item.assignmentId === assignmentId);
        if (!entry || entry.claimed) return false;
        entry.claimed = true;
        storeQueue(entries);
        return true;
      },
      forgetOrder(orderId, threadId) {
        const entries = readQueue();
        const remaining = entries.filter(({ item }) => item.order.orderId !== orderId || item.order.threadId !== threadId);
        if (remaining.length < entries.length) storeQueue(remaining);
      },
    },
  };
}

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

type CafeFileReadOptions = { onIgnoredTuiAccess?: (member: string) => void };

export function readCafeFile(path: string, options?: CafeFileReadOptions): CafeDocument {
  let source: string;
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(st?.isDirectory() ? "expected a YAML file, but this path is a directory" : "file not found");
    source = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`invalid .cafe at ${path}: ${(err as Error).message}`);
  }
  return parseCafeFile(source, path, options);
}

export function parseCafeFile(source: string, path: string, options?: CafeFileReadOptions): CafeDocument {
  let raw: unknown;
  try {
    raw = parse(source) ?? {};
  } catch (err) {
    throw new Error(`invalid .cafe at ${path}: ${(err as Error).message}`);
  }
  const parsed = CafeDocument.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid .cafe at ${path}: ${issues}\n${MINIMAL}`);
  }
  const ignored = validateTeam(parsed.data, path);
  for (const member of ignored) options?.onIgnoredTuiAccess?.(member);
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
function validateTeam(doc: CafeDocument, path: string): string[] {
  const team = doc.team;
  const ignored: string[] = [];
  if (!team) return ignored;
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
    if (m.mode === "tui" && m.access !== undefined) {
      ignored.push(m.name);
      delete m.access;
    }
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
  return ignored;
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
export function tuiAccessNotice(members: string[]): string {
  return `Ignored TUI access settings for ${members.join(", ")}. Your terminal controls their permissions. You can remove these access settings.`;
}

export function loadIdentity(cwd: string, options?: CafeFileReadOptions): { file?: string; cafe: CafeFile; document: CafeDocument } {
  const file = findCafeFile(cwd);
  if (file) {
    const document = readCafeFile(file, options);
    // `cafe` keeps the pre-v4-11 shape (no team block), so spreading it into an AgentIdentity stays valid.
    return { file, cafe: document, document };
  }
  const base = resolve(cwd).split(/[\\/]/).filter(Boolean).pop() ?? "anon";
  const name = base.replace(/[^a-zA-Z0-9_.-]/g, "-") || "anon";
  const document = CafeDocument.parse({ name, role: "customer" });
  return { cafe: document, document };
}
