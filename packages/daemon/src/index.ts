import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Daemon, type DaemonOptions } from "./daemon.ts";
import { cafeHome, loadConfig } from "./config.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

export { Daemon, lanAddress, type DaemonOptions, type Timing } from "./daemon.ts";
export { CafeConfig, cafeHome, configPath, loadConfig, saveConfig, setConfigValue } from "./config.ts";
export { Registry } from "./registry.ts";
export { LlmRouter, RulesRouter, type CompleteFn, type Router } from "./router.ts";
export { startServer, type ServerHandle } from "./server.ts";
export { Store } from "./store.ts";
export { Supervisor, defaultExtensionPath, type BaristaSpec, type WorkerInfo } from "./supervisor.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Single-instance lock: `daemon.lock` created with O_EXCL holding our pid.
 * A lock left by a dead process is taken over.
 */
export function acquireLock(home: string): (() => void) | undefined {
  const path = join(home, "daemon.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) rmSync(path);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(existsSync(path) ? readFileSync(path, "utf8") : "0");
      if (pid && alive(pid)) return undefined;
      rmSync(path, { force: true });
    }
  }
  return undefined;
}

export interface RunOptions {
  home?: string;
  mode?: "daemon" | "root";
  port?: number;
  root?: string;
  webDist?: string;
  router?: DaemonOptions["router"];
  timing?: DaemonOptions["timing"];
  log?: (m: string) => void;
  /** Skip the single-instance lock (tests run several daemons with distinct homes anyway). */
  noLock?: boolean;
  /** Do not manage headless Baristas (tests). */
  noSupervisor?: boolean;
}

export interface Running {
  daemon: Daemon;
  server: ServerHandle;
  stop(): Promise<void>;
}

export async function runDaemon(opts: RunOptions = {}): Promise<Running> {
  const home = opts.home ?? cafeHome();
  const config = loadConfig(home);
  if (opts.mode) config.mode = opts.mode;
  if (opts.port !== undefined) config.port = opts.port;
  if (opts.root) config.root = opts.root;
  const release = opts.noLock ? () => {} : acquireLock(home);
  if (!release) throw new Error(`another cafe daemon is already running for ${home}`);
  const daemon = new Daemon({ config, home, router: opts.router, timing: opts.timing, log: opts.log });
  await daemon.initRouter();
  let server: ServerHandle;
  try {
    server = await startServer(daemon, { port: config.port, webDist: opts.webDist });
  } catch (e) {
    release();
    daemon.stop();
    throw e;
  }
  config.port = server.port;
  daemon.log(`listening on :${server.port} as ${config.mode} (${daemon.url()})`);
  if (!opts.noSupervisor) {
    daemon.supervisor = new Supervisor({ home, daemonAddr: `127.0.0.1:${server.port}`, token: config.token });
    daemon.supervisor.restore();
  }
  daemon.recover();
  daemon.connectRoot();
  void daemon.announceRoot();
  return {
    daemon,
    server,
    async stop() {
      daemon.supervisor?.shutdown();
      daemon.stop();
      await server.close();
      release();
    },
  };
}
