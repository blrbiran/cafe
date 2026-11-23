/**
 * TLS trust bootstrap (v4-6 §3.3).
 *
 * Two distinct pins, deliberately never compared to each other:
 *
 * - `caFingerprint` authenticates the **trust anchor**. It is set once at enrolment
 *   (`cafe connect --ca-fingerprint`). After that, only certificates issued by that CA are
 *   accepted.
 * - `pins[host]` names one **peer's leaf**. It catches an unexpected leaf issued under the trusted
 *   CA (a compromised CA key, or the wrong machine answering on an address).
 *
 * Pure functions here; file I/O lives with the daemon. Keeping this module free of `node:fs` makes
 * the policy testable without a certificate on disk.
 */

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
 */
export function checkPeerPin(peer: string, leafFingerprint: string, pins: Record<string, string>): EnrollResult {
  const expected = pins[peer];
  if (!expected) return { ok: true, firstSeen: true };
  if (same(leafFingerprint, expected)) return { ok: true, firstSeen: false };
  return {
    ok: false,
    reason: `${peer} presented a different certificate than the pinned one (pinned ${normalizeFingerprint(expected)}, got ${normalizeFingerprint(leafFingerprint)}); run \`cafe connect ${peer} --reset-pin\` if this change is expected`,
  };
}