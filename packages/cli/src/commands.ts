import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExtensionPath } from "@cafe/daemon";
import { ompExtensionState, piExtensionState } from "./extension.ts";

/** Written into the command file so an uninstall never deletes a person's own command. */
export const COMMAND_MARKER = "<!-- Managed by cafe: /cafe -->";
/** Older installs wrote /cafe-ask; `install` removes that file when it is ours. */
const LEGACY_MARKER = "<!-- Managed by cafe: /cafe-ask -->";

export const COMMAND_BODY = `---
description: Ask the cafe network (agents, ask, status, thread)
---
The user invoked /cafe with: $ARGUMENTS

Forward it to the cafe CLI with the Bash tool:

- no arguments or \`agents\`: run \`cafe agents\`
- \`status\`: run \`cafe daemon status\`
- \`thread <id>\`: run \`cafe thread <id>\`
- \`ask <question>\`: run \`cafe ask "<question>"\`
- anything else: treat it as a question and run \`cafe ask "$ARGUMENTS"\`

Report the command's output as-is. If the daemon is unreachable, show the error and the next command instead of guessing.
`;

export function claudeCommandPath(home = homedir()): string {
  return join(home, ".claude/commands/cafe.md");
}

function legacyClaudeCommandPath(home: string): string {
  return join(home, ".claude/commands/cafe-ask.md");
}

/** Remove the old /cafe-ask file, but only when cafe wrote it. */
function removeLegacyClaudeCommand(home: string): void {
  const path = legacyClaudeCommandPath(home);
  try {
    if (readFileSync(path, "utf8").includes(LEGACY_MARKER)) rmSync(path, { force: true });
  } catch {
    // missing or unreadable: nothing to clean up
  }
}

export type ClaudeCommandState = "missing" | "ours" | "foreign";

export function claudeCommandState(home = homedir()): { path: string; state: ClaudeCommandState } {
  const path = claudeCommandPath(home);
  if (!existsSync(path)) return { path, state: "missing" };
  return { path, state: readFileSync(path, "utf8").includes(COMMAND_MARKER) ? "ours" : "foreign" };
}

export function installClaudeCommand(home = homedir(), opts: { dryRun?: boolean; force?: boolean } = {}): { path: string; state: ClaudeCommandState; written: boolean; replaced?: string; dryRun?: boolean } {
  const { path, state } = claudeCommandState(home);
  if (state === "foreign" && !opts.force) {
    throw new Error(`${path} exists and is not managed by cafe; rerun with --force to replace it`);
  }
  if (opts.dryRun) return { path, state, written: false, dryRun: true };
  mkdirSync(dirname(path), { recursive: true });
  const replaced = state === "foreign" ? readFileSync(path, "utf8") : undefined;
  writeFileSync(path, `${COMMAND_MARKER}\n${COMMAND_BODY}`);
  removeLegacyClaudeCommand(home);
  return { path, state, written: true, ...(replaced !== undefined ? { replaced } : {}) };
}

export function uninstallClaudeCommand(home = homedir()): { path: string; removed: boolean } {
  const { path, state } = claudeCommandState(home);
  const legacy = legacyClaudeCommandPath(home);
  let legacyOurs = false;
  try {
    legacyOurs = readFileSync(legacy, "utf8").includes(LEGACY_MARKER);
  } catch {
    // no legacy file
  }
  if (state === "foreign") throw new Error(`${path} is not managed by cafe; remove it yourself if you want it gone`);
  if (state === "ours") rmSync(path, { force: true });
  if (legacyOurs) rmSync(legacy, { force: true });
  return { path, removed: state === "ours" || legacyOurs };
}

export interface CommandStatus {
  agent: "pi" | "omp" | "claude" | "codex";
  entry: string;
  status: "installed" | "missing" | "conflict" | "unavailable";
  detail: string;
}

/**
 * One row per entry point; mirrors what `cafe doctor` and the Web Settings page show.
 * `claudePlugin` is passed in so this stays pure: the caller reads `claude plugin list` once
 * (see `claudePluginState()`), because the marketplace folder alone does not prove registration.
 */
export function commandsStatus(opts: { userHome?: string; cafeHome?: string; claudePlugin?: { state: string; detail: string } } = {}): CommandStatus[] {
  const userHome = opts.userHome ?? homedir();
  const source = defaultExtensionPath();
  const pi = piExtensionState(userHome, source);
  const omp = ompExtensionState(source);
  const claude = claudeCommandState(userHome);
  const plugin = opts.claudePlugin;
  const skill = join(userHome, ".agents/skills/cafe");

  const pluginRow: CommandStatus = !plugin
    ? { agent: "claude", entry: "/cafe-barista", status: "missing", detail: "run `cafe claude install` for session pause/resume" }
    : plugin.state === "installed"
      ? { agent: "claude", entry: "/cafe-barista", status: "installed", detail: `plugin (pause/resume); ${plugin.detail}` }
      : plugin.state === "unknown"
        ? { agent: "claude", entry: "/cafe-barista", status: "unavailable", detail: plugin.detail }
        : { agent: "claude", entry: "/cafe-barista", status: "missing", detail: plugin.detail };

  return [
    { agent: "pi", entry: "/cafe", status: pi.installed ? "installed" : "missing", detail: `${pi.settingsPath} (extension)` },
    { agent: "omp", entry: "/cafe", status: !omp.available ? "unavailable" : omp.installed ? "installed" : "missing", detail: omp.detail },
    { agent: "claude", entry: "/cafe", status: claude.state === "ours" ? "installed" : claude.state === "foreign" ? "conflict" : "missing", detail: claude.path },
    pluginRow,
    { agent: "codex", entry: "$cafe", status: existsSync(skill) ? "installed" : "missing", detail: existsSync(skill) ? skill : "run `cafe skill install`" },
  ];
}