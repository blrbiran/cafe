import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { setDefaultCACertificates, getCACertificates } from "node:tls";
import { ensureCaAsync, tlsPaths } from "./store.ts";
import { enrollFingerprint, type TlsConfig } from "./trust.ts";
import { fingerprintOf, generateCa, type CertPair } from "./certs.ts";

/**
 * Trust bootstrap for a Daemon starting under `security.mode: tls` (v4-6 §3.3).
 *
 * The hard case is a child Host that joins an existing network: it must trust the Root's CA without
 * anyone copying files by hand, and it must *not* invent a CA of its own (that would silently make
 * the network unverifiable). The sequence:
 *
 * 1. A Root with no CA creates one.
 * 2. A Daemon with `root` and no local CA fetches the Root's public `ca.crt`. The fetch itself
 *    accepts any leaf — the CA is exactly what is being fetched — so **the configured fingerprint is
 *    what authenticates it**. A mismatch is refused and nothing is written. With no fingerprint the
 *    first contact is trust-on-first-use, and the fingerprint is then persisted so later contacts
 *    are pinned.
 * 3. Any other Daemon (standalone) creates a local CA so TLS still works on a single machine.
 *
 * Every failure here is fatal at startup: starting plaintext because the CA was unreachable would be
 * exactly the downgrade the design forbids.
 */

export interface CaBootstrapOptions {
  home: string;
  isRoot: boolean;
  root?: string;
  /** Token presented to the Root when fetching its CA. */
  token: string;
  security: TlsConfig;
  log: (msg: string) => void;
}

export interface CaBootstrapResult {
  ca: CertPair;
  /** True when this run fetched the CA from the Root (so the leaf must be requested too). */
  fetchedFromRoot: boolean;
  /** The fingerprint to persist when it was newly enrolled or newly created. */
  enroll?: string;
  /**
   * Set when a Root is configured but could not be reached at startup. The Daemon runs on a local
   * CA meanwhile (still TLS, still verified) and retries enrolment before its next dial to the Root.
   */
  pendingRoot?: { root: string; reason: string };
}

export async function bootstrapCa(opts: CaBootstrapOptions): Promise<CaBootstrapResult> {
  const p = tlsPaths(opts.home, "unused");
  const caPath = opts.security.ca ?? p.caPath;
  const caOpts = { create: false, ...(opts.security.ca ? { caPath: opts.security.ca } : {}) };

  // A CA already on disk was enrolled earlier; respect it and (re)apply the configured pin.
  const existing = await ensureCaAsync(opts.home, caOpts);
  if (existing) {
    const check = enrollFingerprint(existing.fingerprint256, opts.security.caFingerprint);
    if (!check.ok) throw new Error(check.reason);
    return { ca: existing, fetchedFromRoot: false };
  }

  if (opts.isRoot) {
    const ca = (await ensureCaAsync(opts.home, { ...caOpts, create: true }))!;
    // A pin was configured but no CA existed: a freshly created one cannot be the pinned CA.
    const check = enrollFingerprint(ca.fingerprint256, opts.security.caFingerprint);
    if (!check.ok) throw new Error(check.reason);
    return { ca, fetchedFromRoot: false, enroll: ca.fingerprint256 };
  }

  if (opts.root) {
    try {
      const ca = await fetchRootCa(opts.root, opts.security.caFingerprint, opts.token);
      mkdirSync(join(caPath, ".."), { recursive: true });
      writeFileSync(caPath, ca.cert, { mode: 0o644 });
      return { ca, fetchedFromRoot: true, enroll: ca.fingerprint256 };
    } catch (err) {
      const reason = (err as Error).message;
      // A configured pin that does not match is a refusal, not a transient outage: fail closed.
      if (/fingerprint mismatch/i.test(reason)) throw err;
      // The Root may simply be offline at boot (a child starts before its Root). Run TLS on an
      // in-memory local CA so this machine's own traffic is still encrypted and verified, and retry
      // enrolment before the next Root dial. Nothing is written, so a healed enrolment leaves no
      // stale trust anchor behind. Fail-closed still holds: nothing is served in plaintext.
      opts.log(`Root ${opts.root} not reachable for CA enrolment (${reason}); starting on a temporary local CA and retrying`);
      const local = await generateCa();
      return { ca: local, fetchedFromRoot: false, pendingRoot: { root: opts.root, reason } };
    }
  }

  // Standalone Daemon: its own trust anchor. One machine is a complete network.
  opts.log("no Root configured: creating a local CA for TLS");
  const ca = (await ensureCaAsync(opts.home, { ...caOpts, create: true }))!;
  return { ca, fetchedFromRoot: false, enroll: ca.fingerprint256 };
}

/** Default TLS port when a Daemon's `/api/tls` predates `tlsPort` (older release). */
export const DEFAULT_TLS_PORT = 4778;

function splitAddr(addr: string): { host: string; port: number | undefined } {
  const clean = addr.replace(/^wss?:\/\//, "").replace(/\/.*$/, "");
  const m = /^(.*?)(?::(\d+))?$/.exec(clean)!;
  return { host: m[1]!.replace(/^\[|\]$/g, ""), port: m[2] ? Number(m[2]) : undefined };
}

/** `host:port` with IPv6 brackets restored. */
export function joinAddr(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function getJson(mod: typeof httpRequest | typeof request, addr: string, path: string, opts: { token?: string; ca?: string; insecure?: boolean; timeoutMs?: number }): Promise<{ status: number; body: any }> {
  const { host, port } = splitAddr(addr);
  return new Promise((resolve, reject) => {
    const req = mod(
      {
        host,
        port,
        path,
        method: "GET",
        headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
        ...(mod === request ? (opts.insecure ? { rejectUnauthorized: false } : opts.ca ? { ca: opts.ca } : {}) : {}),
      } as any,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            reject(new Error(`unreadable response from ${addr}${path}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(opts.timeoutMs ?? 5_000, () => req.destroy(new Error(`timed out reaching ${addr}`)));
    req.end();
  });
}

/** A loopback address names one specific instance, not "the Root on that machine": never probe a default port there. */
function loopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * What a Daemon at `addr` says about its TLS endpoint (v4-6 §10.3): its public CA and the port its TLS
 * listener is on. `addr` is normally the address people type — the main (plaintext) port — so this asks
 * over plaintext first; the answer carries nothing secret, the CA is checked against the pinned
 * fingerprint by the caller, and the TLS port is only ever dialled with that CA. An `addr` that already
 * names the TLS port (configs written before §10.3) answers over HTTPS instead.
 *
 * A container may publish only the TLS port (#98): when the plaintext port refuses, the same host is
 * also asked over HTTPS on each of `fallbackPorts` (the default TLS port) before giving up. Explicit
 * `fallbackPorts` are always tried; the implicit default is skipped for loopback, where a port names
 * one instance and 4778 would be an unrelated Daemon.
 */
export async function discoverTls(addr: string, opts: { ca?: string; timeoutMs?: number; fallbackPorts?: number[] } = {}): Promise<{ ca?: string; fingerprint256?: string; hostId?: string; rootHostId?: string; tlsPort: number }> {
  const { host, port } = splitAddr(addr);
  let first: Error | undefined;
  try {
    const r = await getJson(httpRequest, addr, "/api/tls", { timeoutMs: opts.timeoutMs });
    if (r.status === 200) return { ca: r.body.ca ?? undefined, fingerprint256: r.body.fingerprint256 ?? undefined, hostId: r.body.hostId ?? undefined, rootHostId: r.body.rootHostId ?? undefined, tlsPort: r.body.tlsPort ?? DEFAULT_TLS_PORT };
    first = new Error(`HTTP ${r.status}`);
  } catch (err) {
    first = err as Error;
    // Nothing can answer on this address at all: another port cannot fix a name that does not resolve
    // or a route that does not exist.
    if (/ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|timed out/.test(`${(err as any).code ?? ""} ${first.message}`)) throw first;
  }
  // Over TLS on the address itself: a config written before §10.3 names the TLS port directly.
  // Verify with the network CA when we have it; enrolment (no CA yet) relies on the fingerprint check.
  const viaTls = async (target: string, hint?: number) => {
    const r = await getJson(request, target, "/api/tls", { ...(opts.ca ? { ca: opts.ca } : { insecure: true }), timeoutMs: opts.timeoutMs });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} over TLS at ${target}`);
    return { ca: r.body.ca ?? undefined, fingerprint256: r.body.fingerprint256 ?? undefined, hostId: r.body.hostId ?? undefined, rootHostId: r.body.rootHostId ?? undefined, tlsPort: r.body.tlsPort ?? hint ?? DEFAULT_TLS_PORT };
  };
  try {
    return await viaTls(addr, port);
  } catch {
    // Fall through to the default TLS port.
  }
  const candidates = opts.fallbackPorts ?? (loopbackHost(host) ? [] : [DEFAULT_TLS_PORT]);
  const fallbacks = candidates.filter((p) => p !== port);
  for (const p of fallbacks) {
    try {
      return await viaTls(joinAddr(host, p), p);
    } catch {
      // Try the next candidate.
    }
  }
  if (fallbacks.length) throw new Error(`${first.message}; also tried ${fallbacks.map((p) => joinAddr(host, p)).join(", ")} over TLS: nothing answered`, { cause: first });
  throw first;
}

/** `host:tlsPort` for the Daemon at `addr` (its main or its TLS address). */
export async function tlsAddressOf(addr: string, opts: { ca?: string } = {}): Promise<string> {
  const { tlsPort } = await discoverTls(addr, opts);
  return joinAddr(splitAddr(addr).host, tlsPort);
}

/**
 * Fetch the Root's `ca.crt` from the address in `root:` (its main address; a TLS address still works).
 * The CA is authenticated by the fingerprint, not by the transport: with a configured pin a wrong CA is
 * refused; without one this is the documented TOFU first contact.
 */
export async function fetchRootCa(root: string, expected: string | undefined, _token?: string): Promise<CertPair & { tlsPort: number; rootId?: string }> {
  let body: { ca?: string; tlsPort: number; rootHostId?: string };
  try {
    body = await discoverTls(root, { timeoutMs: 10_000 });
  } catch (err) {
    throw new Error(`could not reach the Root at ${root} to fetch its CA: ${(err as Error).message}`);
  }
  if (!body.ca) {
    throw new Error(`the Root at ${root} has TLS disabled; set security.mode: plaintext on this Host, or enable TLS on the Root`);
  }
  const check = enrollFingerprint(fingerprintOf(body.ca), expected);
  if (!check.ok) throw new Error(check.reason);
  return { cert: body.ca, key: "", fingerprint256: fingerprintOf(body.ca), tlsPort: body.tlsPort, ...(body.rootHostId ? { rootId: body.rootHostId } : {}) };
}

/**
 * Request this Host's leaf from the Root (a child with the network token but no CA key). A dedicated
 * `https` request with `ca` is deliberate: it verifies against the enrolled CA without depending on
 * the process-wide default trust store, which several Daemons in one process would otherwise share.
 *
 * `publicKey` (SPKI PEM) is the key the child already uses. Sending it makes a reissue keep the
 * child's identity, so peers that pinned this Host's leaf keep accepting it (v4-6 §5 A/B). With no
 * `publicKey` this is a first issuance and the Root generates a key pair.
 */
export function fetchLeafFromRoot(rootTls: string, caPem: string, token: string, sans: string[], publicKey?: string): Promise<{ cert: string; key: string }> {
  const root = rootTls;
  const payload = JSON.stringify({ sans, ...(publicKey ? { publicKey } : {}) });
  return postTlsJson(root, caPem, "/api/tls/leaf", payload, { authorization: `Bearer ${token}` });
}

/**
 * Redeem a one-use Root invitation for this Host's durable public key. The Root verifies its Root
 * Host ID before this call; every retry keeps the same requestId so a lost response replays the
 * committed certificate rather than issuing another Host identity.
 */
export function enrollHostFromRoot(
  rootTls: string,
  caPem: string,
  token: string,
  input: { inviteCode: string; requestId: string; publicKey: string; sans: string[] },
): Promise<{ cert: string; hostId: string; host: string; caFingerprint: string; retry: boolean }> {
  return postTlsJson(rootTls, caPem, "/api/tls/leaf", JSON.stringify(input), { authorization: `Bearer ${token}` });
}

/**
 * Renew an already-enrolled Host's leaf without a new invitation: ask the pinned Root for a short
 * nonce, sign it with the key the Host already owns, and let the Root verify the signature against
 * the enrolled SPKI before issuing a replacement certificate for the same Host ID.
 */
export async function renewHostFromRoot(
  rootTls: string,
  caPem: string,
  token: string,
  input: { hostId: string; privateKey: string; publicKey: string; sans: string[] },
): Promise<{ cert: string; hostId: string; caFingerprint: string }> {
  const challenge = await postTlsJson(rootTls, caPem, "/api/tls/challenge", JSON.stringify({ hostId: input.hostId }), { authorization: `Bearer ${token}` });
  const { signHostRenewal } = await import("./certs.ts");
  const signature = signHostRenewal(input.privateKey, input.hostId, challenge.nonce);
  return postTlsJson(rootTls, caPem, "/api/tls/leaf", JSON.stringify({
    hostId: input.hostId,
    nonce: challenge.nonce,
    signature,
    publicKey: input.publicKey,
    sans: input.sans,
  }), { authorization: `Bearer ${token}` });
}

function postTlsJson(addr: string, caPem: string, path: string, payload: string, headers: Record<string, string>): Promise<any> {
  const root = addr;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: root.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""),
        port: Number(/:(\d+)$/.exec(root)?.[1] ?? 4778),
        path,
        method: "POST",
        ca: caPem,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            let detail = "";
            try {
              const body = JSON.parse(text) as { error?: string; message?: string };
              detail = body.message ? `: ${body.message}` : body.error ? `: ${body.error}` : "";
            } catch {
              // Keep the status-only explanation when the Root did not send JSON.
            }
            return reject(new Error(`the Root refused Host certificate enrollment: HTTP ${status}${detail}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("the Root returned an unreadable enrollment response"));
          }
        });
      },
    );
    req.on("error", (err) => reject(new Error(`could not reach the Root at ${root} to enroll this Host: ${err.message}`)));
    req.setTimeout(10_000, () => req.destroy(new Error("timed out enrolling this Host with the Root")));
    req.end(payload);
  });
}

/** Apply the network CA to Node's default trust store for outgoing calls (additive). */
export function trustCaForClient(caPem: string): void {
  try {
    setDefaultCACertificates([...getCACertificates("default"), caPem]);
  } catch {
    // Older runtimes: the global fetch keeps system roots; the daemon link passes `ca` explicitly.
  }
}