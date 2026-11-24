/**
 * TLS trust bootstrap (v4-6 §3.3).
 *
 * Two distinct pins, deliberately never compared to each other:
 *
 * - `caFingerprint` authenticates the **trust anchor**. It is set once at enrolment
 *   (`cafe connect --ca-fingerprint`). After that, only certificates issued by that CA are
 *   accepted.
 * - `pins[host]` names one **peer's leaf key** (SPKI). It catches an unexpected leaf issued under
 *   the trusted CA (a compromised CA key, or the wrong machine answering on an address), and it
 *   survives a renewal because the key outlives the certificate.
 *
 * Pure functions here; file I/O lives with the daemon. Keeping this module free of `node:fs` makes
 * the policy testable without a certificate on disk.
 */
import { X509Certificate } from "node:crypto";
import { checkServerIdentity as tlsCheckServerIdentity } from "node:tls";
import { keyFingerprintFromRaw } from "./certs.ts";

export type SecurityMode = "tls" | "plaintext";

export interface TlsConfig {
  mode: SecurityMode;
  /** Port the TLS listener binds (plaintext stays on the main port for the Web UI/loopback). */
  port: number;
  /** CA certificate path. */
  ca?: string;
  /** TOFU pin for the CA, set by `cafe connect --ca-fingerprint`. */
  caFingerprint?: string;
  /** Per-peer leaf pin, keyed by `host:port`. */
  pins: Record<string, string>;
}

/** The default TLS port; plaintext stays on 4777 (DEFAULT_PORT). */
export const DEFAULT_TLS_PORT = 4778;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Read the `security:` block from a parsed config. Never throws on malformed input. */
export function readTlsConfig(raw: unknown): TlsConfig {
  const security = asRecord(asRecord(raw).security);
  const tls = asRecord(security.tls);
  const mode: SecurityMode = security.mode === "plaintext" ? "plaintext" : "tls";
  const port = typeof tls.port === "number" && Number.isInteger(tls.port) && tls.port >= 0 ? tls.port : DEFAULT_TLS_PORT;
  const pins = asRecord(tls.pins);
  return {
    mode,
    port,
    ...(typeof tls.ca === "string" && tls.ca ? { ca: tls.ca } : {}),
    ...(typeof tls.caFingerprint === "string" && tls.caFingerprint ? { caFingerprint: tls.caFingerprint } : {}),
    pins: Object.fromEntries(Object.entries(pins).filter(([, v]) => typeof v === "string") as Array<[string, string]>),
  };
}

/**
 * Normalise a fingerprint to the `AA:BB:…` uppercase form Node prints. Accepts a bare hex string,
 * a colon form in any case, or a `sha256:` label in front. Returns "" for input that is not a
 * plausible fingerprint, so comparison can never accidentally succeed on garbage.
 */
export function normalizeFingerprint(raw: string): string {
  const stripped = raw.trim().replace(/^sha256:/i, "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (!stripped) return "";
  return stripped.match(/.{1,2}/g)!.join(":");
}

const same = (a: string, b: string) => normalizeFingerprint(a) === normalizeFingerprint(b) && normalizeFingerprint(a) !== "";

export interface EnrollResult {
  ok: boolean;
  firstSeen?: boolean;
  reason?: string;
  /**
   * Set when the stored pin was a certificate fingerprint from before the key-pin switch and the leaf
   * it named is still the one presented: the caller should rewrite the pin to this key fingerprint
   * now, while that is still verifiable, so the next renewal does not lock the peer out.
   */
  upgrade?: string;
}

/**
 * Check the CA's fingerprint against the expected pin. No pin means trust-on-first-use: the caller
 * stores the returned fingerprint. Once a pin exists a mismatch is refused, never warned about.
 */
export function enrollFingerprint(seen: string, expected?: string): EnrollResult {
  if (!expected) return { ok: true, firstSeen: true };
  if (same(seen, expected)) return { ok: true, firstSeen: false };
  return { ok: false, reason: `CA fingerprint mismatch: expected ${normalizeFingerprint(expected)}, got ${normalizeFingerprint(seen)}` };
}

/**
 * Check one peer's leaf against its stored pin. No pin records the leaf; a matching pin passes; a
 * different leaf for the same peer is refused, naming both values so the person can verify the
 * change out of band.
 *
 * The pin is the leaf's **key** fingerprint (SPKI), not its certificate fingerprint: a renewal keeps
 * the key and changes the certificate, so a certificate pin would reject a host that merely rotated
 * (v4-6 §5 A/B). `legacy` pins — certificate fingerprints stored before the switch — are accepted
 * while they still match, so an upgrade never locks out an existing network.
 */
export function checkPeerPin(
  peer: string,
  leaf: { keyFingerprint: string; certFingerprint?: string },
  pins: Record<string, string>,
): EnrollResult {
  const expected = pins[peer];
  const seen = leaf.keyFingerprint;
  if (!expected) return { ok: true, firstSeen: true };
  if (same(seen, expected)) return { ok: true, firstSeen: false };
  // An older pin named the certificate. It still proves the same leaf while that leaf is unchanged;
  // report the key so the caller upgrades the pin now, before the next renewal changes the certificate.
  if (leaf.certFingerprint && same(leaf.certFingerprint, expected)) return { ok: true, firstSeen: false, upgrade: seen };
  return {
    ok: false,
    reason: `${peer} presented a different certificate key than the pinned one (pinned ${normalizeFingerprint(expected)}, got ${normalizeFingerprint(seen)}); if this Host was deliberately reinstalled, clear the pin with \`cafe host pin --clear ${peer.split(":")[0]}\``,
  };
}

/**
 * The `checkServerIdentity` a Daemon-to-Daemon link installs (v4-6 §5 A).
 *
 * Node **replaces** the default identity check when an option of this name is supplied; it does not
 * run both. So this first asks the standard checker to verify the leaf names the dialled host (SAN
 * verification, the same one commit `6524c5e` tightened), and only then applies the per-peer pin. A
 * pin-only function here silently disabled SAN verification on every `wss://` link.
 *
 * `record` persists a newly seen key so later contacts are checked against it (TOFU).
 */
export function pinnedIdentityCheck(
  peer: string,
  getPins: () => Record<string, string>,
  record: (peer: string, keyFingerprint: string) => void,
  verifySan: (host: string | undefined, cert: import("node:tls").PeerCertificate) => Error | undefined = defaultSanCheck,
): (host: string | undefined, cert: import("node:tls").PeerCertificate) => Error | undefined {
  return (host, cert) => {
    const sanError = verifySan(host, cert);
    if (sanError) return sanError;
    if (!cert?.raw) return new Error("the peer did not present a certificate");
    const keyFingerprint = keyFingerprintFromRaw(cert.raw);
    const certFingerprint = new X509Certificate(cert.raw).fingerprint256;
    const verdict = checkPeerPin(peer, { keyFingerprint, certFingerprint }, getPins());
    if (!verdict.ok) return new Error(verdict.reason);
    // First contact, or an old certificate pin that still matches: write the key pin.
    if (verdict.firstSeen) record(peer, keyFingerprint);
    else if (verdict.upgrade) record(peer, verdict.upgrade);
    return undefined;
  };
}

/**
 * Node's own identity check, so a custom one never weakens it by omission. An IP dial sends no SNI,
 * and Node passes `host` through as the IP (`options.servername = ''` only affects SNI), so the SAN
 * entries are still checked against it.
 */
function defaultSanCheck(host: string | undefined, cert: import("node:tls").PeerCertificate): Error | undefined {
  if (!host) return undefined;
  // `checkServerIdentity` returns an Error or undefined; it does not throw for a mismatch.
  return tlsCheckServerIdentity(host, cert) ?? undefined;
}