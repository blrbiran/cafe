#!/usr/bin/env node
// Build the publishable npm package into ./release (docs/specs/v2-7-publishing.md).
//
//   npm run release:build            # builds web + bundles, writes release/
//   npm pack ./release               # inspect the tarball
//   npm publish ./release            # done by the user
//
// Node does not strip types under node_modules, so the package ships JS bundles:
//   bin/cafe.js            warning filter, then imports dist/cli.js
//   dist/cli.js            cli + daemon + protocol (npm deps inlined)
//   dist/pi-extension.js   pi / oh-my-pi extension (host packages stay external)
//   dist/proc/guard.mjs    worker guard, copied as is
//   web/                   built web UI
//   skills/cafe/           the cafe skill
//   claude-plugin/         the cafe Claude Code plugin (a mod), installed by `cafe claude install`
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const NAME = process.env.CAFE_PACKAGE_NAME ?? "@blrbiran/cafe";

if (!process.argv.includes("--skip-web")) execFileSync("npm", ["run", "build:web"], { cwd: root, stdio: "inherit" });
if (!existsSync(join(root, "packages/web/dist/index.html"))) throw new Error("packages/web/dist is missing; run npm run build:web");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist", "proc"), { recursive: true });

// Optional native add-ons of `ws`; it works without them.
const optionalNative = ["bufferutil", "utf-8-validate"];
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  // Bundled CommonJS deps (ws, multicast-dns) call require(); give ESM output one.
  banner: { js: 'import { createRequire as __cafeCreateRequire } from "node:module"; const require = __cafeCreateRequire(import.meta.url);' },
};

await build({
  ...common,
  entryPoints: [join(root, "packages/cli/src/main.ts")],
  outfile: join(out, "dist/cli.js"),
  // Only needed when router.model is set; loaded lazily from the optional dependency.
  external: [...optionalNative, "@earendil-works/pi-coding-agent"],
});

await build({
  ...common,
  entryPoints: [join(root, "packages/pi-extension/src/index.ts")],
  outfile: join(out, "dist/pi-extension.js"),
  // Provided by pi / oh-my-pi when they load the extension.
  external: [...optionalNative, "@earendil-works/*", "typebox"],
});

cpSync(join(root, "packages/daemon/src/proc/guard.mjs"), join(out, "dist/proc/guard.mjs"));
// The connector SDK ships with the CLI so `cafe connector install` can resolve `@cafe/connector`
// for a connector installed from a published cafe (#28). It lives at connector/ (npm refuses to pack
// node_modules); `linkSdkPackages` finds it next to dist/. Type-only @cafe/protocol imports are
// stripped by Node, so protocol (and zod/yaml) is not needed at runtime. Node does not strip types
// under node_modules, hence JS bundles.
const connectorDir = join(out, "connector");
mkdirSync(connectorDir, { recursive: true });
for (const [from, to] of [["index.ts", "index.js"], ["mock.ts", "mock.js"], ["discord-core.ts", "discord.js"], ["discordjs.ts", "discordjs.js"]]) {
  await build({
    ...common,
    entryPoints: [join(root, "packages/connector/src", from)],
    outfile: join(connectorDir, to),
    external: ["node:*", "discord.js"],
  });
}
mkdirSync(join(connectorDir, "discord"), { recursive: true });
// The shipped connector runs the bundled JS, not the source .ts.
const discordManifest = JSON.parse(readFileSync(join(root, "packages/connector/discord/cafe-connector.json"), "utf8"));
discordManifest.entry = "./index.js";
writeFileSync(join(connectorDir, "discord/cafe-connector.json"), JSON.stringify(discordManifest, null, 2) + "\n");
writeFileSync(
  join(connectorDir, "discord/index.js"),
  'import { createDiscordConnector } from "@cafe/connector/discord";\nimport { isEntryPoint } from "@cafe/connector/mock";\nconst main = createDiscordConnector();\nexport default main;\nif (isEntryPoint(import.meta.url)) main.run().catch((err) => { process.stderr.write(`discord connector: ${err?.message ?? err}\\n`); process.exitCode = 1; });\n',
);
writeFileSync(
  join(connectorDir, "package.json"),
  JSON.stringify(
    {
      name: "@cafe/connector",
      version: rootPkg.version,
      type: "module",
      exports: {
        ".": "./index.js",
        "./sdk": "./index.js",
        "./client": "./index.js",
        "./state": "./index.js",
        "./mock": "./mock.js",
        "./discord": "./discord.js",
      },
    },
    null,
    2,
  ) + "\n",
);
cpSync(join(root, "packages/web/dist"), join(out, "web"), { recursive: true });
cpSync(join(root, "skills/cafe"), join(out, "skills/cafe"), { recursive: true });
for (const part of [".claude-plugin/plugin.json", "hooks"]) cpSync(join(root, "claude-plugin", part), join(out, "claude-plugin", part), { recursive: true });
cpSync(join(root, "README.md"), join(out, "README.md"));
if (existsSync(join(root, "README_zh.md"))) cpSync(join(root, "README_zh.md"), join(out, "README_zh.md"));
if (existsSync(join(root, "LICENSE"))) cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

mkdirSync(join(out, "bin"));
cpSync(join(root, "packages/cli/bin/node-check.mjs"), join(out, "bin/node-check.mjs"));
writeFileSync(
  join(out, "bin/cafe.js"),
  `#!/usr/bin/env node
import { checkNode } from "./node-check.mjs";
checkNode();
// Silence node:sqlite's ExperimentalWarning; keep other warnings.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});
await import("../dist/cli.js");
`,
  { mode: 0o755 },
);

const piVersion = JSON.parse(readFileSync(join(root, "packages/pi-extension/package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
const pkg = {
  name: NAME,
  version: rootPkg.version,
  description: "cafe: a DNS-like network of coding agents — ask a question, the right agent answers",
  type: "module",
  bin: { cafe: "bin/cafe.js" },
  files: ["bin", "dist", "connector", "web", "skills", "claude-plugin", "README.md", ...(existsSync(join(root, "README_zh.md")) ? ["README_zh.md"] : []), ...(existsSync(join(root, "LICENSE")) ? ["LICENSE"] : [])],
  engines: rootPkg.engines,
  // Model-based routing (router.model) only; rules routing works without it.
  optionalDependencies: { "@earendil-works/pi-coding-agent": `^${piVersion}` },
  pi: { extensions: ["./dist/pi-extension.js"] },
  repository: { type: "git", url: "git+https://github.com/blrbiran/cafe.git" },
  ...(rootPkg.license ? { license: rootPkg.license } : {}),
  keywords: ["agents", "pi", "claude-code", "codex", "multi-agent", "routing"],
  publishConfig: { access: "public" },
};
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`release/ ready: ${pkg.name}@${pkg.version}`);
