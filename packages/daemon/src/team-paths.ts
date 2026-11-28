import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readCafeFile } from "@cafe/protocol/cafe-file";

export type PathGrantState = "active" | "stale" | "revoked" | "revoked-pending";
export interface PathGrant {
  grantId: string;
  rosterRoot: string;
  team: string;
  member: string;
  target: string;
  dev: number;
  ino: number;
  state: PathGrantState;
  createdAt: string;
}
export interface ResolvedMemberPath {
  rosterRoot: string;
  realPath: string;
  dev: number;
  ino: number;
  insideRoot: boolean;
}
export interface RevokedPathGrant extends PathGrant { state: "revoked"; }

const GRANTS_FILE = "team-path-grants.json";
function grantsPath(home: string): string { return join(home, GRANTS_FILE); }
function safeInput(memberDir: string): void {
  if (typeof memberDir !== "string" || memberDir.length === 0) throw new Error("member directory path must not be empty");
  if (memberDir.includes("\0")) throw new Error("member directory path contains NUL");
  if (isAbsolute(memberDir) || /^[a-zA-Z]:[\\/]/.test(memberDir) || memberDir.startsWith("\\")) {
    throw new Error("member directory path must be relative to the roster root");
  }
}
function canonicalRoot(rosterRoot: string): string {
  try { return realpathSync(resolve(rosterRoot)); }
  catch { throw new Error(`roster root does not exist: ${rosterRoot}`); }
}

/** Resolve existing path components while retaining a missing tail for stale owner lookups. */
export function canonicalPathOrMissing(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(cursor), ...suffix); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
function requireSeparator(): string { return process.platform === "win32" ? "\\" : "/"; }

export function resolveMemberPath(rosterRoot: string, memberDir: string): ResolvedMemberPath {
  safeInput(memberDir);
  const root = canonicalRoot(rosterRoot);
  let realPath: string;
  try { realPath = realpathSync(resolve(root, memberDir)); }
  catch { throw new Error(`member directory does not exist or cannot be resolved: ${memberDir}`); }
  const stat = statSync(realPath);
  if (!stat.isDirectory()) throw new Error(`member path is not a directory: ${memberDir}`);
  const insideRoot = realPath === root || realPath.startsWith(root + requireSeparator());
  if (!insideRoot) throw new Error(`member path escapes roster root; authorize it with an exact local path grant: ${realPath}`);
  return { rosterRoot: root, realPath, dev: stat.dev, ino: stat.ino, insideRoot };
}

function readRaw(home: string): PathGrant[] {
  const path = grantsPath(home);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((grant) => !grant || typeof grant.grantId !== "string" || typeof grant.rosterRoot !== "string" || typeof grant.member !== "string" || typeof grant.target !== "string")) {
    throw new Error(`invalid local path grant file: ${path}`);
  }
  return parsed as PathGrant[];
}
function save(home: string, grants: PathGrant[]): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = grantsPath(home);
  const tmp = join(home, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}
function grantState(grant: PathGrant): PathGrantState {
  if (grant.state === "revoked" || grant.state === "revoked-pending") return grant.state;
  try {
    const target = realpathSync(grant.target);
    const stat = statSync(target);
    return target === grant.target && stat.dev === grant.dev && stat.ino === grant.ino ? "active" : "stale";
  } catch { return "stale"; }
}

export function trustMemberPath(home: string, rosterRoot: string, team: string, member: string, memberDir: string): { grantId: string; realPath: string } {
  safeInput(memberDir);
  const root = canonicalRoot(rosterRoot);
  let realPath: string;
  try { realPath = realpathSync(resolve(root, memberDir)); }
  catch { throw new Error(`member target must exist before it can be trusted: ${memberDir}`); }
  const stat = statSync(realPath);
  if (!stat.isDirectory()) throw new Error(`member target is not a directory: ${memberDir}`);
  if (realPath === root || realPath.startsWith(root + requireSeparator())) throw new Error("path grants are only needed for directories outside the roster root");
  const document = readCafeFile(join(root, ".cafe"));
  const declaredTeam = document.team;
  const declaredMember = declaredTeam?.members.find((entry) => entry.name === member);
  if (!declaredTeam || (declaredTeam.name ?? document.name) !== team || !declaredMember) throw new Error(`member '${member}' is not declared in team '${team}' at ${root}`);
  let declaredTarget: string;
  try { declaredTarget = realpathSync(resolve(root, declaredMember.dir)); }
  catch { throw new Error(`declared member directory does not exist: ${declaredMember.dir}`); }
  if (declaredTarget !== realPath) throw new Error(`path grant target does not match member '${member}' current declared directory`);
  const grants = readRaw(home);
  const existing = grants.find((g) => g.rosterRoot === root && g.team === team && g.member === member && g.target === realPath && g.dev === stat.dev && g.ino === stat.ino && grantState(g) === "active");
  if (existing) return { grantId: existing.grantId, realPath };
  const grant: PathGrant = { grantId: randomUUID(), rosterRoot: root, team, member, target: realPath, dev: stat.dev, ino: stat.ino, state: "active", createdAt: new Date().toISOString() };
  save(home, [...grants, grant]);
  return { grantId: grant.grantId, realPath };
}

export function validateMemberPath(home: string, rosterRoot: string, member: string, memberDir: string): ResolvedMemberPath {
  safeInput(memberDir);
  const root = canonicalRoot(rosterRoot);
  let realPath: string;
  try { realPath = realpathSync(resolve(root, memberDir)); }
  catch { throw new Error(`member directory does not exist or cannot be resolved: ${memberDir}`); }
  const stat = statSync(realPath);
  if (!stat.isDirectory()) throw new Error(`member path is not a directory: ${memberDir}`);
  const insideRoot = realPath === root || realPath.startsWith(root + requireSeparator());
  if (!insideRoot) {
    const granted = readRaw(home).some((g) => g.state === "active" && g.rosterRoot === root && g.member === member && g.target === realPath && g.dev === stat.dev && g.ino === stat.ino && grantState(g) === "active");
    if (!granted) throw new Error(`external member path requires an exact local grant for ${member}: ${realPath}`);
  }
  return { rosterRoot: root, realPath, dev: stat.dev, ino: stat.ino, insideRoot };
}

export function readPathGrants(home: string): PathGrant[] {
  return readRaw(home).map((grant) => ({ ...grant, state: grantState(grant) }));
}

export function revokeMemberPath(home: string, grantId: string): RevokedPathGrant;
export function revokeMemberPath(home: string, grantId: string, state: "revoked" | "revoked-pending"): PathGrant;
export function revokeMemberPath(home: string, grantId: string, state: "revoked" | "revoked-pending" = "revoked"): PathGrant {
  const grants = readRaw(home);
  const grant = grants.find((g) => g.grantId === grantId);
  if (!grant) throw new Error(`unknown path grant '${grantId}'`);
  if (grant.state !== state) {
    grant.state = state;
    save(home, grants);
  }
  return { ...grant };
}

export function effectiveMemberAccess(member: { mode?: "headless" | "tui"; access?: "read-only" | "write" }, mode = member.mode ?? "headless"): "read-only" | "write" | "host-managed" {
  if (mode === "tui") {
    if (member.access !== undefined) throw new Error("TUI member access cannot be set; Cafe cannot restrict tools inside a user-owned terminal");
    return "host-managed";
  }
  return member.access ?? "read-only";
}
