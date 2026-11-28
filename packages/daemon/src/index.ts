import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { ulid } from "ulid";
import { join } from "node:path";
import { Daemon, type DaemonOptions } from "./daemon.ts";
import { cafeHome, loadConfig, saveConfig } from "./config.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { Supervisor } from "./supervisor.ts";
import { advertiseRoot, discoverRoots } from "./discovery.ts";
import { advertisedAddress } from "./daemon.ts";
import { daemonLog } from "./proc/daemonLog.ts";
import { ensureLeaf, leafNeedsRenewal, readLeaf, tlsPaths, writeLeaf } from "./tls/store.ts";
import { bootstrapCa, fetchLeafFromRoot, fetchRootCa, renewHostFromRoot, tlsAddressOf, trustCaForClient } from "./tls/bootstrap.ts";
import { readTlsConfig } from "./tls/trust.ts";
import { generateCa, hostIdFromCertificate, issuedBy, issueHostLeaf, issueLeaf, keyFingerprintOf, keyFingerprintOfPublicKey, localAddresses, missingSans } from "./tls/certs.ts";
import { createHash, createPublicKey } from "node:crypto";
import { daemonHttpUrl } from "@cafe/protocol/urls";

export { Daemon, assertDaemonAddress, hostWithPort, joinAddresses, lanAddress, advertisedAddress, type DaemonOptions, type Timing } from "./daemon.ts";
export { CafeConfig, CONFIG_KEYS, cafeHome, configKeyPath, isConfigKey, configApplyMode, configInitialized, configPath, diffConfig, homeId, loadConfig, saveConfig, setConfigValue } from "./config.ts";
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
  /** Enable reserved strict relay capabilities only in isolated acceptance fixtures. */
  assignmentRelayFixture?: boolean;
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
  const config = loadConfig(home, { persist: true });
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
  const daemon = new Daemon({ config, home, router: opts.router, routerFactory: opts.routerFactory, assignmentRelayFixture: opts.assignmentRelayFixture, timing: opts.timing, log, version: opts.version });
  // Load the router in the background: loading pi's model runtime has taken tens of seconds, and the
  // Web, the Agents and the CLI must not wait for it. An Order that arrives meanwhile waits for it.
  daemon.startRouter();
  // Transport security (v4-6 #61). The Root owns the CA; every Daemon presents a leaf signed by it.
  const security = readTlsConfig(config);
  let tls: { tlsPort: number; current(): { cert: string; key: string } } | undefined;
  const tlsOpts =
    security.mode === "tls"
      ? await (async () => {
          const isRoot = config.mode === "root";
          const boot = await bootstrapCa({ home, isRoot, root: config.root, token: config.token, security, log });
          let ca = boot.ca;
          let pendingRoot = boot.pendingRoot;
          const remote = !isRoot && !!config.root;
          if (remote) ca = { ...ca, key: "" };
          trustCaForClient(ca.cert);
          if (boot.enroll && !security.caFingerprint) {
            config.security.tls.caFingerprint = boot.enroll;
            saveConfig(config, home);
          }
          const leafSans = () => daemon.desiredSans();
          const storedHostIdentity = daemon.store.getHostIdentityByHost(config.host);
          const existingHostLeaf = readLeaf(home, config.host);
          const enrolledHostId = existingHostLeaf ? hostIdFromCertificate(existingHostLeaf.cert) : undefined;
          const hostId = (remote ? enrolledHostId : storedHostIdentity?.hostId ?? enrolledHostId) ?? ulid();
          let active: { cert: string; key: string };
          const rootHostId = config.security.tls.rootHostId ?? daemon.rootHostId;
          daemon.tlsNeedsEnrollment = remote && (!enrolledHostId || !rootHostId);
          const enrollmentRequired = "this Host needs enrollment with a one-use Root invitation";
          const renewFromRoot = async (sans: string[], key: string, rootCa = ca.cert) => {
            if (!config.root || !rootHostId || !enrolledHostId) throw new Error("run `cafe connect <root> --invite <code>` to enroll this Host");
            const publicKey = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
            return renewHostFromRoot(await tlsAddressOf(config.root, { ca: rootCa }), rootCa, config.token, {
              rootHostId, hostId, privateKey: key, publicKey, sans,
            });
          };
          const issueNetworkLeaf = () => ensureLeaf(home, config.host, ca,
            { host: config.host, advertise: config.advertise, lan: localAddresses(), extra: config.security.tls.sans },
            {
              hostId, standalone: !remote && !isRoot,
              fetchLeaf: async (sans) => {
                if (!existingHostLeaf) return undefined;
                const renewed = await renewFromRoot(sans, existingHostLeaf.key);
                return { cert: renewed.cert, key: existingHostLeaf.key };
              },
            });
          if (!pendingRoot) {
            try {
              if (daemon.tlsNeedsEnrollment) throw new Error(enrollmentRequired);
              const leaf = await issueNetworkLeaf();
              active = { cert: leaf.cert, key: leaf.key };
            } catch (err) {
              if (!remote) throw err;
              pendingRoot = { root: config.root!, reason: (err as Error).message };
            }
          }
          if (pendingRoot) {
            ca = await generateCa();
            active = await issueHostLeaf(ca, leafSans(), hostId);
            trustCaForClient(ca.cert);
          }
          if (remote && rootHostId) {
            daemon.rootHostId = rootHostId;
            daemon.store.setKv("rootHostId", rootHostId);
          }
          const recordLocal = (cert: string) => daemon.setLocalHostIdentity({
            hostId, host: config.host, keyFingerprint: keyFingerprintOf(cert), state: "enrolled",
            revision: storedHostIdentity?.revision ?? 1,
          });
          if (!pendingRoot) recordLocal(active!.cert);
          const renewListeners = new Set<() => void>();
          // Write-through: a leaf issued here or by the Root replaces the on-disk one too, so a
          // restart after a renewal uses the fresh leaf instead of a stale file.
          const swap = (next: { cert: string; key: string }) => {
            writeLeaf(home, config.host, next);
            active = next;
            for (const fn of renewListeners) fn();
          };
          daemon.tlsContext = {
            ca: ca.cert,
            caFingerprint: ca.fingerprint256,
            network: !pendingRoot,
            current: () => active!,
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
                  issue: async (sans: string[], publicKey?: string) => {
                    // Legacy reissue path remains for compatibility during the migration window.
                    const fresh = await issueLeaf(ca, sans, 90, publicKey);
                    return { cert: fresh.cert, key: fresh.key };
                  },
                  issueHost: async (sans: string[], hostId: string, publicKey: string) => {
                    const fresh = await issueHostLeaf(ca, sans, hostId, publicKey);
                    return { cert: fresh.cert, key: fresh.key };
                  },
                }
              : {}),
            // A running Daemon renews its own leaf before expiry (v4-6 §5 B). The Root signs locally;
            // a child asks the Root, which needs the Root reachable — if it is not, the next timer
            // tick tries again, and the existing (not-yet-expired) leaf keeps working meanwhile.
            renew: async (sans?: string[]) => {
              const names = sans?.length ? sans : leafSans();
              if (pendingRoot && !daemon.tlsContext?.network) throw new Error("this Host is waiting for network enrollment or certificate renewal");
              const prev = active;
              if (ca.key) {
                const next = isRoot || !config.root
                  ? await issueHostLeaf(ca, names, hostId, prev.key)
                  : await issueLeaf(ca, names, 90, prev.key);
                swap({ cert: next.cert, key: prev.key });
                return;
              }
              const renewed = await renewFromRoot(names, prev.key);
              swap({ cert: renewed.cert, key: prev.key });
            },
            /**
             * A child that booted while its Root was unreachable runs on a temporary local CA; this
             * enrols the real CA and obtains a leaf from it, in place (v4-6 §3.3 "retry enrolment
             * before the next dial"). Without it the child never left the temporary CA, so its
             * `wss://` links never came on and no peer accepted its leaf.
             */
            ...(pendingRoot && config.root
              ? {
                  enrol: async () => {
                    const enrolled = await fetchRootCa(config.root!, config.security.tls.caFingerprint, config.token);
                    if (!enrolledHostId || !rootHostId || !existingHostLeaf) {
                      throw new Error("this Host has no Host identity yet: on the Root run `cafe host invite`, then run `cafe connect <root> --invite <code>` here");
                    }
                    const renewed = await renewFromRoot(leafSans(), existingHostLeaf.key, enrolled.cert);
                    if (!issuedBy(enrolled.cert, renewed.cert)) throw new Error("renewal was not signed by the pinned Root CA");
                    const caFile = config.security.tls.ca ?? tlsPaths(home, "unused").caPath;
                    mkdirSync(join(caFile, ".."), { recursive: true });
                    writeFileSync(caFile, enrolled.cert, { mode: 0o644 });
                    config.security.tls.caFingerprint = enrolled.fingerprint256;
                    ca = enrolled;
                    daemon.tlsContext!.ca = enrolled.cert;
                    daemon.tlsContext!.caFingerprint = enrolled.fingerprint256;
                    swap({ cert: renewed.cert, key: existingHostLeaf.key });
                    recordLocal(renewed.cert);
                    trustCaForClient(enrolled.cert);
                    daemon.tlsContext!.network = true;
                    daemon.setRoot(config.root!);
                  },
                }
              : {}),
          };
          if (pendingRoot) daemon.tlsWaiting = pendingRoot.reason;
          const enrol = daemon.tlsContext.enrol;
          return { ca: ca.cert, currentCa: () => daemon.tlsContext!.ca, current: () => active, onRenew: (fn: () => void) => daemon.tlsContext!.onRenew(fn), ...(enrol ? { enrol } : {}) };
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
  // Our TLS endpoint, for `url()` and `/api/tls` (v4-6 §10.3).
  if (tls) daemon.tlsPort = tls.tlsPort;
  config.port = server.port;
  daemon.log(`listening on :${server.port} as ${config.mode} (${daemon.url()})`);
  if (tls) daemon.log(`tls on :${tls.tlsPort} (ca ${daemon.tlsContext?.caFingerprint})`);
  else daemon.log("tls disabled (security.mode: plaintext)");
  // A leaf nearing expiry is renewed while the Daemon keeps running, not only at the next start
  // (v4-6 §5 B): otherwise a fleet that never restarts expires together and fails closed.
  // The same tick reissues when an address appeared that the leaf does not name (#91): a VPN that
  // comes up after boot must not wait for a restart.
  if (tls) daemon.startLeafRenewalCheck(() => leafNeedsRenewal(tls!.current().cert) || missingSans(tls!.current().cert, daemon.desiredSans()).length > 0);
  // A child that booted while its Root was offline runs on a temporary local CA; retry enrolment so
  // it moves onto the real CA and its `wss://` links come on, without a restart (v4-6 §3.3).
  if (daemon.tlsContext?.enrol && !daemon.tlsContext.network) daemon.startEnrolmentRetry();
  if (!opts.noSupervisor) {
    try {
      const supervisor = new Supervisor({ home, daemonAddr: `127.0.0.1:${server.port}`, token: config.token, log: (m) => daemon.log(m) });
      daemon.restoreLocalRosterWriteScopes(supervisor);
      const { reaped, skipped } = await supervisor.restore();
      daemon.supervisor = supervisor;
      if (reaped) daemon.log(`reaped ${reaped} barista worker group(s) left by a previous daemon`);
      for (const why of skipped) daemon.log(`barista reap skipped: ${why}`);
    } catch (err) {
      daemon.log(`barista supervisor unavailable: ${(err as Error).message}`);
    }
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
