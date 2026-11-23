/**
 * Cafe TLS certificates (v4-6 #61): a Root-generated CA signs one leaf per Daemon.
 *
 * `node-forge` is an **optional** dependency: only the Root generates the CA, and a Daemon only
 * needs forge when it first issues its own leaf. `CafeClient` and `server.ts` use Node's built-in
 * `node:tls` / `node:https` — forge never runs on the hot path.
 */
import { X509Certificate } from "node:crypto";

export interface CertPair {
  /** PEM certificate. */
  cert: string;
  /** PEM private key (never leaves the machine that owns it). */
  key: string;
  /** `X509Certificate.fingerprint256` of `cert`, e.g. `3A:1F:…`. */
  fingerprint256: string;
}

/** SHA-256 fingerprint of a PEM certificate, in the `AA:BB:…` form Node's TLS uses. */
export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

type Forge = typeof import("node-forge");

async function forge(): Promise<Forge> {
  try {
    const mod = (await import("node-forge" as string)) as Forge & { default?: Forge };
    // CJS interop: under plain Node the namespace's `default` is forge; under vitest it is already
    // flattened onto the namespace.
    return mod.default ?? mod;
  } catch {
    throw new Error("node-forge is required to generate TLS certificates; install it with `npm install node-forge`");
  }
}

/** A CN is not an identity in TLS, but it keeps `cafe root show` readable. */
const CA_CN = "cafe Root CA";
const LEAF_CN = "cafe daemon";

/**
 * A Root CA: RSA-2048, ~10-year validity, `basicConstraints.cA`. The private key stays on the
 * Root (`CAFE_HOME/tls/ca.key`, mode 0600) and is never distributed.
 */
export async function generateCa(): Promise<CertPair> {
  const { pki, md } = await forge();
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86_400_000);
  const attrs = [{ name: "commonName", value: CA_CN }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, md.sha256.create());
  const certPem = pki.certificateToPem(cert);
  return { cert: certPem, key: pki.privateKeyToPem(keys.privateKey), fingerprint256: fingerprintOf(certPem) };
}

function randomSerial(): string {
  // 64 random bits as a positive hex integer. forge reads the serial as an ASN.1 INTEGER, so it
  // must be hex digits with the top bit clear; arbitrary bytes produce "illegal padding".
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isIp(name: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(":");
}

/**
 * The leaf SAN list. Includes the hostname, its `advertise` address, the LAN IP, and loopback. IPs
 * must be included: a DNS-only SAN fails a connection to `127.0.0.1` with
 * `ERR_TLS_CERT_ALTNAME_INVALID` (measured in the spec).
 */
export function sanList(input: { host: string; advertise?: string; lan?: string }): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => {
    const name = v?.split(":")[0]?.trim();
    if (name && !out.includes(name)) out.push(name);
  };
  add(input.host);
  add(input.advertise);
  add(input.lan);
  add("127.0.0.1");
  add("localhost");
  return out;
}

/**
 * Issue one Daemon leaf: RSA-2048 (node-forge 1.x has no EC key generation — see the spec's honest
 * boundaries), 90-day validity by default, signed by the CA. SANs are DNS and IP entries as the
 * names require.
 *
 * RSA costs ~23% more handshake CPU than ECDSA P-256 (spec §2), which is paid once per connection
 * and per reconnect; cafe keeps one long-lived WebSocket, so steady-state cost is unchanged.
 */
export async function issueLeaf(ca: CertPair, sans: string[], days = 90): Promise<CertPair> {
  const { pki, md } = await forge();
  const caCert = pki.certificateFromPem(ca.cert);
  const caKey = pki.privateKeyFromPem(ca.key);
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000);
  cert.setSubject([{ name: "commonName", value: sans[0] ?? LEAF_CN }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: sans.map((value) => (isIp(value) ? { type: 7, ip: value } : { type: 2, value })) },
  ]);
  cert.sign(caKey, md.sha256.create());
  const certPem = pki.certificateToPem(cert);
  return { cert: certPem, key: pki.privateKeyToPem(keys.privateKey), fingerprint256: fingerprintOf(certPem) };
}