import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Daemon, type DaemonOptions } from "./daemon.ts";
import { cafeHome, loadConfig, saveConfig } from "./config.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { Supervisor } from "./supervisor.ts";
import { advertiseRoot, discoverRoots } from "./discovery.ts";
import { lanAddress, advertisedAddress } from "./daemon.ts";
import { daemonLog } from "./proc/daemonLog.ts";
import { ensureLeaf, leafNeedsRenewal, tlsPaths, writeLeaf } from "./tls/store.ts";
import { bootstrapCa, fetchLeafFromRoot, trustCaForClient } from "./tls/bootstrap.ts";
import { readTlsConfig } from "./tls/trust.ts";
import { issueLeaf, sanList } from "./tls/certs.ts";
import { daemonHttpUrl } from "@cafe/protocol/urls";

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
  // Transport security (v4-6 #61). The Root owns the CA; every Daemon presents a leaf signed by it.
  const security = readTlsConfig(config);
  let tls: { tlsPort: number; current(): { cert: string; key: string } } | undefined;
  const tlsOpts =
    security.mode === "tls"
      ? await (async () => {
          const isRoot = config.mode === "root";
          const boot = await bootstrapCa({ home, isRoot, root: config.root, token: config.token, security, log });
          const ca = boot.ca;
          // Trust the network CA for every outgoing global fetch/WebSocket (leaf fetch, Doctor probes).
          trustCaForClient(ca.cert);
          // Persist a newly enrolled/created CA fingerprint so a later mismatch is refused.
          if (boot.enroll && !security.caFingerprint) {
            config.security.tls.caFingerprint = boot.enroll;
            saveConfig(config, home);
          }
          const leaf = await ensureLeaf(
            home,
            config.host,
            ca,
            { host: config.host, advertise: config.advertise, lan: lanAddress() },
            {
              // A child Host holds the CA certificate but not its key; the Root issues the leaf.
              fetchLeaf: async () => {
                if (!config.root) throw new Error("no leaf for this Host and no Root configured to issue one");
                // Trust the enrolled CA for this one call. A dedicated `https` request with `ca` is
                // deterministic; the process-wide default store could be racing other Daemons in tests.
                return fetchLeafFromRoot(config.root, ca.cert, config.token, sanList({ host: config.host, advertise: config.advertise, lan: lanAddress() }));
              },
            },
          );
          // `current()` reads run through this closure: a later renewal swaps it in place.
          let active = { cert: leaf.cert, key: leaf.key };
          const renewListeners = new Set<() => void>();
          const leafSans = () => sanList({ host: config.host, advertise: config.advertise, lan: lanAddress() });
          /** Ask the Root (over TLS with our token) for a leaf, for a Host that holds no CA key. */
          const fetchFromRoot = () => fetchLeafFromRoot(config.root!, ca.cert, config.token, leafSans());
          // Write-through: a leaf issued here or by the Root replaces the on-disk one too, so a
          // restart after a renewal uses the fresh leaf instead of a stale file.
          const swap = (next: { cert: string; key: string }) => {
            writeLeaf(home, config.host, next);
            active = next;
            for (const fn of renewListeners) fn();
          };
          daemon.tlsContext = {
            ca: leaf.ca,
            caFingerprint: leaf.caFingerprint,
            /** Daemon-to-daemon links use TLS only once a *network* CA is enrolled (not a temp local one). */
            network: !boot.pendingRoot,
            current: () => active,
            replace: (next) => {
              active = next;
              for (const fn of renewListeners) fn();
            },
            onRenew: (fn) => {
              renewListeners.add(fn);
              return () => renewListeners.delete(fn);
            },
            ...(isRoot
              ? {
                  issue: async (sans: string[]) => {
                    const fresh = await issueLeaf(ca, sans);
                    return { cert: fresh.cert, key: fresh.key };
                  },
                }
              : {}),
            // A running Daemon renews its own leaf before expiry (v4-6 §5 B). The Root signs locally;
            // a child asks the Root, which needs the Root reachable — if it is not, the next timer
            // tick tries again, and the existing (not-yet-expired) leaf keeps working meanwhile.
            renew: async () => {
              const next = ca.key ? await issueLeaf(ca, leafSans()) : await fetchFromRoot();
              swap({ cert: next.cert, key: next.key });
            },
          };
          return { ca: leaf.ca, current: () => active, onRenew: (fn: () => void) => daemon.tlsContext!.onRenew(fn) };
        })()
      : undefined;
  let server: ServerHandle;
  try {
    server = await startServer(daemon, { port: config.port, webDist: opts.webDist, tlsPort: security.port, tls: tlsOpts });
  } catch (e) {
    release();
    daemon.stop();
    throw e;
  }
  tls = tlsOpts && server.tlsPort !== undefined ? { tlsPort: server.tlsPort, current: tlsOpts.current } : undefined;
  config.port = server.port;
  daemon.log(`listening on :${server.port} as ${config.mode} (${daemon.url()})`);
  if (tls) daemon.log(`tls on :${tls.tlsPort} (ca ${daemon.tlsContext?.caFingerprint})`);
  else daemon.log("tls disabled (security.mode: plaintext)");
  // A leaf nearing expiry is renewed while the Daemon keeps running, not only at the next start
  // (v4-6 §5 B): otherwise a fleet that never restarts expires together and fails closed.
  if (tls) daemon.startLeafRenewalCheck(() => leafNeedsRenewal(tls!.current().cert));
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
