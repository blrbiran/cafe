#!/usr/bin/env node
// Smoke-test the publishable package the way a user gets it: build release/, `npm pack`,
// install the tarball into a temporary global prefix, and drive the installed `cafe`
// against a scratch CAFE_HOME. No model calls, nothing outside temp dirs is touched.
//
//   npm run test:release                  # skip the optional pi-coding-agent dependency (offline, fast)
//   npm run test:release -- --with-optional   # also install it and check the LLM router loads
//   npm run test:release -- --skip-build      # reuse an existing release/
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const withOptional = args.has("--with-optional");
const work = mkdtempSync(join(tmpdir(), "cafe-release-test-"));
const results = [];
let failed = false;

function check(name, fn) {
  try {
    const note = fn();
    results.push(`ok    ${name}${note ? ` (${note})` : ""}`);
  } catch (err) {
    failed = true;
    results.push(`FAIL  ${name}: ${err.message.split("\n")[0]}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (!args.has("--skip-build")) execFileSync("node", [join(root, "scripts/build-release.mjs")], { cwd: root, stdio: "inherit" });
  const pkg = JSON.parse(readFileSync(join(root, "release/package.json"), "utf8"));

  const packDir = join(work, "pack");
  mkdirSync(packDir);
  execFileSync("npm", ["pack", join(root, "release"), "--pack-destination", packDir], { stdio: "pipe" });
  const tgz = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz")));
  const files = execFileSync("tar", ["tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean);
  check("tarball contents", () => {
    for (const f of ["bin/cafe.js", "dist/cli.js", "dist/pi-extension.js", "dist/proc/guard.mjs", "web/index.html", "skills/cafe/SKILL.md", "README.md", "LICENSE"])
      assert(files.includes(`package/${f}`), `missing ${f}`);
    const stray = files.filter((f) => /\.ts$|node_modules|\.map$/.test(f));
    assert(stray.length === 0, `unexpected files: ${stray.join(", ")}`);
    return `${files.length} files`;
  });

  const prefix = join(work, "prefix");
  execFileSync("npm", ["i", "-g", "--prefix", prefix, ...(withOptional ? [] : ["--omit=optional"]), tgz], { stdio: "pipe" });
  const cafeBin = join(prefix, "bin", "cafe");
  const home = join(work, "home");
  const fakeHome = join(work, "fakehome");
  mkdirSync(home);
  mkdirSync(fakeHome);
  const port = await freePort();
  writeFileSync(join(home, "config.yml"), `port: ${port}\nhost: release-test\nmode: root\ndiscovery: false\n${withOptional ? "router:\n  model: none/none\n" : ""}`);
  const env = { ...process.env, CAFE_HOME: home, CAFE_DISCOVERY: "0" };
  const cafe = (...a) => execFileSync(cafeBin, a, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  check("cafe --version", () => {
    const v = cafe("--version");
    assert(v === pkg.version, `got ${v}, package is ${pkg.version}`);
    return v;
  });
  check("pi-extension-path points into the package", () => {
    const p = cafe("pi-extension-path");
    assert(p.endsWith(join("dist", "pi-extension.js")) && existsSync(p), p);
  });
  check("daemon start", () => cafe("daemon", "start").replace(/\s+/g, " "));
  check("web UI served", () => {
    const html = execFileSync("curl", ["-s", `http://127.0.0.1:${port}/`], { encoding: "utf8" });
    assert(html.includes("<title>cafe</title>"), "no cafe page");
  });
  check("health reports the package version", () => {
    const h = JSON.parse(execFileSync("curl", ["-s", `http://127.0.0.1:${port}/api/health`], { encoding: "utf8" }));
    assert(h.version === pkg.version, `health version ${h.version}`);
  });

  const baristaDir = join(work, "echo");
  mkdirSync(baristaDir);
  writeFileSync(join(baristaDir, ".cafe"), "name: echo\ndescription: echoes the question for the release test\nrole: barista\n");
  const serve = spawn(cafeBin, ["serve", "--exec", "printf 'echo-ok'", "--dir", baristaDir], { env, stdio: "ignore" });
  for (let i = 0; i < 50 && !cafe("agents").includes("echo#"); i++) await sleep(100);
  check("cafe serve answers an Order", () => {
    const outText = cafe("ask", "--to", "echo", "release smoke");
    assert(outText.includes("echo-ok"), outText.slice(-200));
  });
  serve.kill();

  check("skill install links the packaged skill", () => {
    const outText = execFileSync(cafeBin, ["skill", "install"], { env: { ...env, HOME: fakeHome }, encoding: "utf8" });
    assert(outText.includes(join("@blrbiran", "cafe", "skills", "cafe")) || outText.includes(join(pkg.name, "skills", "cafe")), outText);
  });

  let piAvailable = false;
  try {
    execFileSync("pi", ["--version"], { stdio: "pipe" });
    piAvailable = true;
  } catch {}
  if (piAvailable) {
    const piDir = join(work, "pidir");
    mkdirSync(piDir);
    writeFileSync(join(piDir, ".cafe"), "name: pib\ndescription: headless pi for the release test\nrole: barista\n");
    cafe("barista", "start", "--dir", piDir);
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      await sleep(200);
      ok = cafe("agents").includes("pib#");
    }
    check("headless pi loads the bundled extension and registers", () => assert(ok, "pib did not register"));
  } else {
    results.push("skip  headless pi (pi not installed)");
  }

  if (withOptional) {
    check("LLM router loads from the optional dependency", () => {
      const log = readFileSync(join(home, "daemon.log"), "utf8");
      assert(/router: (llm|rules)/.test(log) && !/Cannot find package '@earendil-works\/pi-coding-agent'/.test(log), "router could not load pi-coding-agent");
    });
  }
  check("daemon stop", () => cafe("daemon", "stop"));
  // Let the daemon and its headless workers finish exiting before the temp dir goes away.
  for (let i = 0; i < 50; i++) {
    try {
      execFileSync("curl", ["-sf", `http://127.0.0.1:${port}/api/health`], { stdio: "ignore" });
      await sleep(100);
    } catch {
      break;
    }
  }
  await sleep(1500);
} catch (err) {
  failed = true;
  results.push(`FAIL  setup: ${err.message.split("\n")[0]}`);
} finally {
  try {
    execFileSync(join(work, "prefix", "bin", "cafe"), ["daemon", "stop"], { env: { ...process.env, CAFE_HOME: join(work, "home") }, stdio: "ignore" });
  } catch {}
  console.log(`\nrelease smoke test (${work})\n${results.join("\n")}`);
  if (!failed) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      console.log(`(could not remove ${work}; a process was still writing to it)`);
    }
  }
  process.exit(failed ? 1 : 0);
}
