import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { fingerprintOf, generateCa, hostIdFromCertificate, issuedBy, issueHostLeaf, issueLeaf, publicKeyOf, sanCovers, sanList, type CertPair } from "./certs.ts";

/**
 * A child Host's leaf: read `CAFE_HOME/tls/<host>.crt` + `.key`, or write a leaf the Root issued.
 */
export function readLeaf(home: string, host: string): { cert: string; key: string } | undefined {
  const p = tlsPaths(home, host);
  if (!existsSync(p.leafCertPath) || !existsSync(p.leafKeyPath)) return undefined;
  return { cert: readFileSync(p.leafCertPath, "utf8"), key: readFileSync(p.leafKeyPath, "utf8") };
}

/** The child key saved before enrollment, paired with its not-yet-issued certificate. */
export function readPendingHostKey(home: string, host: string): { cert: ""; key: string } | undefined {
  const p = tlsPaths(home, host);
  if (!existsSync(p.leafKeyPath)) return undefined;
  return { cert: "", key: readFileSync(p.leafKeyPath, "utf8") };
}

export function writeLeaf(home: string, host: string, leaf: { cert: string; key: string }): void {
  const p = tlsPaths(home, host);
  mkdirSync(join(p.leafCertPath, ".."), { recursive: true });
  writeFileSync(p.leafCertPath, leaf.cert, { mode: 0o644 });
  writeFileSync(p.leafKeyPath, leaf.key, { mode: 0o600 });
}

/**
 * Where the TLS materials live and how a Daemon obtains them (v4-6 §3.2).
 *
 * - `CAFE_HOME/tls/ca.crt` + `ca.key` (0600): Root only. `ca.crt` is public and distributed; the
 *   key never leaves the Root.
 * - `CAFE_HOME/tls/<host>.crt` + `.key`: this Daemon's leaf, issued by the Root's CA.
 *
 * A Daemon that has a CA but no leaf asks the Root for one; until TLS transport is fully rolled
 * out, a Daemon can also be handed a leaf directly (`cafe daemon renew-cert` or the config).
 */

export interface TlsFiles {
  caPath: string;
  caKeyPath: string;
  leafCertPath: string;
  leafKeyPath: string;
}

export function tlsPaths(home: string, host: string): TlsFiles {
  const dir = join(home, "tls");
  return {
    caPath: join(dir, "ca.crt"),
    caKeyPath: join(dir, "ca.key"),
    leafCertPath: join(dir, `${host}.crt`),
    leafKeyPath: join(dir, `${host}.key`),
  };
}

export interface TlsContext {
  /** Leaf certificate PEM the listener presents. */
  cert: string;
  /** Leaf private key PEM. */
  key: string;
  /** CA certificate PEM used to verify peers (and returned to callers in `cafe root show`). */
  ca: string;
  /** CA fingerprint, for enrolment. */
  caFingerprint: string;
  /** Root-assigned Host identity carried by the signed leaf, when enrolled. */
  hostId?: string;
  /** SANs the current leaf carries. */
  sans: string[];
}

function readPair(certPath: string, keyPath: string): CertPair | undefined {
  if (!existsSync(certPath) || !existsSync(keyPath)) return undefined;
  const cert = readFileSync(certPath, "utf8");
  const key = readFileSync(keyPath, "utf8");
  return { cert, key, fingerprint256: fingerprintOf(cert) };
}

export interface CaOptions {
  /** Create the CA when it does not exist (Root only). */
  create: boolean;
  /** Certificate path override (`security.tls.ca`); the key sits beside it as `<name>.key`. */
  caPath?: string;
}

/**
 * Load the CA, or create it when this is the Root and none exists. The key path is derived from the
 * certificate path, so a configured `security.tls.ca` works too.
 */
export async function ensureCaAsync(home: string, opts: CaOptions): Promise<CertPair | undefined> {
  const p = tlsPaths(home, "unused");
  const certPath = opts.caPath ?? p.caPath;
  const keyPath = certPath.endsWith(".crt") ? `${certPath.slice(0, -4)}.key` : `${certPath}.key`;
  const existing = readPair(certPath, keyPath);
  if (existing) return existing;
  // A child Host has the CA certificate but not its key: it verifies peers with `ca.crt` and never
  // signs anything. Only the Root keeps `ca.key` (and only the Root can create the CA).
  if (existsSync(certPath)) {
    const cert = readFileSync(certPath, "utf8");
    const key = existsSync(keyPath) ? readFileSync(keyPath, "utf8") : "";
    return { cert, key, fingerprint256: fingerprintOf(cert) };
  }
  if (!opts.create) return undefined;
  const ca = await generateCa();
  mkdirSync(join(certPath, ".."), { recursive: true });
  writeFileSync(certPath, ca.cert, { mode: 0o644 });
  writeFileSync(keyPath, ca.key, { mode: 0o600 });
  return ca;
}

/** A leaf counts as needing renewal once it has less than this much validity left (v4-6 §5 B). */
export const LEAF_RENEW_BEFORE_MS = 21 * 86_400_000;

/** True when `cert` expires within `withinMs` (or is already expired / unreadable). */
export function leafNeedsRenewal(certPem: string, now = Date.now(), withinMs = LEAF_RENEW_BEFORE_MS): boolean {
  try {
    const notAfter = Date.parse(new X509Certificate(certPem).validTo);
    return !Number.isFinite(notAfter) || notAfter - now <= withinMs;
  } catch {
    return true;
  }
}

/**
 * Load this Daemon's leaf, or issue one from the CA when it is missing. `sans` is recomputed on
 * every start so an `advertise`/LAN change is reflected in a reissued leaf, and a leaf close to
 * expiry is renewed too: a 90-day leaf with no renewal would fail closed for the whole fleet
 * (v4-6 §5 B).
 */
export async function ensureLeaf(
  home: string,
  host: string,
  ca: CertPair,
  sansInput: { host: string; advertise?: string; lan?: string | string[]; extra?: string[] },
  opts: { hostId?: string; standalone?: boolean; fetchLeaf?: (sans: string[], publicKey?: string, hostId?: string) => Promise<{ cert: string; key: string } | undefined> } = {},
): Promise<TlsContext> {
  const sans = sanList(sansInput);
  const existing = readLeaf(home, host);
  if (existing) {
    const covered = sans.every((s) => sanCovers(existing.cert, s));
    const identityMatches = !opts.hostId || hostIdFromCertificate(existing.cert) === opts.hostId;
    if (covered && identityMatches && issuedBy(ca.cert, existing.cert) && !leafNeedsRenewal(existing.cert)) {
      return { cert: existing.cert, key: existing.key, ca: ca.cert, caFingerprint: ca.fingerprint256, ...(opts.hostId ? { hostId: opts.hostId } : {}), sans };
    }
  }
  let leaf: { cert: string; key: string };
  if (ca.key) {
    leaf = opts.hostId
      ? await issueHostLeaf(ca, sans, opts.hostId, existing?.key)
      : await issueLeaf(ca, sans, 90, existing?.key);
  } else if (opts.standalone) {
    const local = await generateCa();
    leaf = opts.hostId
      ? await issueHostLeaf(local, sans, opts.hostId)
      : await issueLeaf(local, sans);
    ca.cert = local.cert;
    ca.key = local.key;
    ca.fingerprint256 = local.fingerprint256;
  } else if (opts.fetchLeaf) {
    const fetched = await opts.fetchLeaf(sans, publicKeyOf(existing?.cert), opts.hostId);
    if (!fetched) throw new Error(`no Root is configured to issue this Host's certificate; run \`cafe connect <root> --invite <code>\``);
    leaf = { cert: fetched.cert, key: fetched.key || existing?.key || "" };
    if (!leaf.key) throw new Error(`the Root returned a leaf for ${host} without a private key and no local key exists`);
    if (opts.hostId && hostIdFromCertificate(leaf.cert) !== opts.hostId) throw new Error(`the Root returned a leaf for the wrong Host ID (${opts.hostId})`);
  } else {
    throw new Error(`no leaf for ${host} and this Host cannot issue one (no CA key); run \`cafe daemon renew-cert\``);
  }
  writeLeaf(home, host, leaf);
  return { cert: leaf.cert, key: leaf.key, ca: ca.cert, caFingerprint: ca.fingerprint256, ...(opts.hostId ? { hostId: opts.hostId } : {}), sans };
}