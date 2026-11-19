import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
