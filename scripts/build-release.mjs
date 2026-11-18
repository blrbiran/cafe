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
cpSync(join(root, "packages/web/dist"), join(out, "web"), { recursive: true });
cpSync(join(root, "skills/cafe"), join(out, "skills/cafe"), { recursive: true });
cpSync(join(root, "README.md"), join(out, "README.md"));
if (existsSync(join(root, "LICENSE"))) cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

mkdirSync(join(out, "bin"));
writeFileSync(
  join(out, "bin/cafe.js"),
  `#!/usr/bin/env node
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
  files: ["bin", "dist", "web", "skills", "README.md", ...(existsSync(join(root, "LICENSE")) ? ["LICENSE"] : [])],
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
