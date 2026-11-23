import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Daemon, type DaemonOptions } from "./daemon.ts";
import { cafeHome, loadConfig } from "./config.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { Supervisor } from "./supervisor.ts";
import { advertiseRoot, discoverRoots } from "./discovery.ts";
import { lanAddress, advertisedAddress } from "./daemon.ts";
import { daemonLog } from "./proc/daemonLog.ts";

export { Daemon, assertDaemonAddress, hostWithPort, lanAddress, advertisedAddress, type DaemonOptions, type Timing } from "./daemon.ts";
export { CafeConfig, CONFIG_KEYS, cafeHome, configApplyMode, configPath, diffConfig, loadConfig, saveConfig, setConfigValue } from "./config.ts";
export { Registry } from "./registry.ts";
export { LlmRouter, RulesRouter, listRouterModels, type CompleteFn, type Router } from "./router.ts";
export { startServer, type ServerHandle } from "./server.ts";
export { Store } from "./store.ts";
export { routingStats, formatRoutingStats, type RoutingStats } from "./routing-stats.ts";
export { discoverRoots, type FoundRoot } from "./discovery.ts";
export { daemonLog, daemonLogPath, type DaemonLogOptions } from "./proc/daemonLog.ts";
export { Supervisor, defaultCliBin, defaultExtensionPath, type BaristaSpec, type SupervisorOptions, type WorkerInfo } from "./supervisor.ts";

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
  routerFactory?: DaemonOptions["routerFactory"];
  timing?: DaemonOptions["timing"];
  log?: (m: string) => void;
  /** Skip the single-instance lock (tests run several daemons with distinct homes anyway). */
  noLock?: boolean;
  /** Do not manage headless Baristas (tests). */
  noSupervisor?: boolean;
  /** cafe release reported to other Daemons. */
  version?: string;
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
  // The daemon owns daemon.log (timestamped, capped, #66) unless a caller supplies its own sink
  // (tests pass a no-op). Foreground `cafe daemon run` used to inherit stdout from launchd/systemd,
  // which cannot add timestamps or stop the file growing.
  const logFile = opts.log ? undefined : daemonLog(config.host, home, { version: opts.version ?? "dev", pid: process.pid, mode: config.mode });
  const log = opts.log ?? ((m: string) => logFile!(m));
  const daemon = new Daemon({ config, home, router: opts.router, routerFactory: opts.routerFactory, timing: opts.timing, log, version: opts.version });
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
    const { reaped, skipped } = await daemon.supervisor.restore();
    if (reaped) daemon.log(`reaped ${reaped} barista worker group(s) left by a previous daemon`);
    for (const why of skipped) daemon.log(`barista reap skipped: ${why}`);
  }
  daemon.recover();
  daemon.backfillSearchIndex();
  daemon.connectRoot();
  void daemon.announceRoot();
  const discovery = config.discovery && process.env.CAFE_DISCOVERY !== "0";
  let stopAdvert: (() => void) | undefined;
  let searching: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  if (discovery && config.mode === "root") {
    // Same formatter as every other address: `advertise` may already carry a port (#76).
    stopAdvert = advertiseRoot({ host: config.host, addr: () => advertisedAddress(config) });
  } else if (discovery && !config.root) {
    // No Root configured: look for exactly one on the LAN, retrying until found.
    const search = async () => {
      const roots = (await discoverRoots(2000)).filter((r) => r.host !== config.host);
      if (stopped || config.root || daemon.isRoot) return;
      if (roots.length === 1) {
        daemon.log(`discovered root ${roots[0]!.host} at ${roots[0]!.addr}`);
        daemon.setRoot(roots[0]!.addr);
        return;
      }
      if (roots.length > 1) daemon.log(`several roots on the LAN (${roots.map((r) => `${r.host} ${r.addr}`).join(", ")}); pick one with \`cafe root set\``);
      searching = setTimeout(() => void search(), 15_000);
      searching.unref?.();
    };
    void search();
  }
  return {
    daemon,
    server,
    async stop() {
      stopped = true;
      clearTimeout(searching);
      stopAdvert?.();
      await daemon.supervisor?.shutdown();
      daemon.stop();
      await server.close();
      logFile?.close();
      release();
    },
  };
}
