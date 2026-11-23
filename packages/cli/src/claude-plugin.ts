import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `cafe claude install`: puts the cafe Claude Code plugin (claude-plugin/, a mod) into a local marketplace under
 * CAFE_HOME and registers it with Claude Code at user scope. The plugin then runs `cafe session-host` in every
 * interactive Claude Code session; sessions in a directory with a Barista `.cafe` answer questions.
 */
export const MARKETPLACE = "cafe-local";
export const PLUGIN = "cafe";

const here = dirname(fileURLToPath(import.meta.url));

/** The plugin source: next to dist/ in the published package, or claude-plugin/ at the repo root. */
export function pluginSource(): string {
  const found = [resolve(here, "../claude-plugin"), resolve(here, "../../../claude-plugin")].find((d) => existsSync(join(d, ".claude-plugin/plugin.json")));
  if (!found) throw new Error("cannot find the cafe Claude Code plugin (claude-plugin/)");
  return found;
}

export interface ClaudePluginPlan {
  /** The marketplace folder (CAFE_HOME/claude-marketplace). */
  marketplace: string;
  /** The plugin folder inside it. */
  plugin: string;
  /** How the plugin starts cafe: [node, cafe.js]. */
  argv: string[];
  commands: string[][];
}

export function claudePluginPlan(cafeHome: string, argv: string[], claude = "claude"): ClaudePluginPlan {
  const marketplace = join(cafeHome, "claude-marketplace");
  return {
    marketplace,
    plugin: join(marketplace, PLUGIN),
    argv,
    commands: [
      [claude, "plugin", "marketplace", "add", marketplace],
      [claude, "plugin", "install", `${PLUGIN}@${MARKETPLACE}`],
    ],
  };
}

/** Writes the marketplace folder (replacing our own earlier copy). The marketplace entry is a relative path, so
 * Claude Code reads the plugin from this folder: re-running install updates it (then `/reload-plugins`). */
export function writeClaudePlugin(plan: ClaudePluginPlan, source = pluginSource()): void {
  rmSync(plan.plugin, { recursive: true, force: true });
  mkdirSync(plan.plugin, { recursive: true });
  for (const part of [".claude-plugin/plugin.json", "hooks"]) cpSync(join(source, part), join(plan.plugin, part), { recursive: true });
  writeFileSync(join(plan.plugin, "cafe.json"), JSON.stringify({ argv: plan.argv }, null, 2) + "\n");
  mkdirSync(join(plan.marketplace, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(plan.marketplace, ".claude-plugin/marketplace.json"),
    JSON.stringify(
      {
        name: MARKETPLACE,
        owner: { name: "cafe" },
        description: "The cafe plugin from this machine's cafe install (written by `cafe claude install`)",
        plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, description: "This Claude Code session answers cafe questions for its directory's .cafe identity" }],
      },
      null,
      2,
    ) + "\n",
  );
}

export type ClaudePluginState = "installed" | "missing" | "unknown";

/**
 * Whether Claude Code actually has the plugin registered. Asking `claude plugin list` is the only trustworthy
 * signal: the local marketplace folder under CAFE_HOME only means `writeClaudePlugin` ran, not that the two
 * `claude plugin ...` commands after it succeeded (#55).
 */
export function claudePluginState(claude = "claude"): { state: ClaudePluginState; detail: string } {
  const r = spawnSync(claude, ["plugin", "list"], { encoding: "utf8", timeout: 20_000 });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { state: "unknown", detail: code === "ENOENT" ? `claude not found (${claude})` : `claude plugin list failed: ${r.error.message}` };
  }
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) {
    const line = text.trim().split("\n").at(-1) ?? "";
    return { state: "unknown", detail: `claude plugin list exited ${r.status}${line ? `: ${line.slice(0, 120)}` : ""}` };
  }
  if (text.includes(`${PLUGIN}@${MARKETPLACE}`)) return { state: "installed", detail: `plugin ${PLUGIN}@${MARKETPLACE}` };
  return { state: "missing", detail: `run \`cafe claude install\` for session pause/resume` };
}
