/**
 * Cafe TLS certificates (v4-6 #61): a Root-generated CA signs one leaf per Daemon.
 *
 * `node-forge` is an **optional** dependency: only the Root generates the CA, and a Daemon only
 * needs forge when it first issues its own leaf. `CafeClient` and `server.ts` use Node's built-in
 * `node:tls` / `node:https` — forge never runs on the hot path.
 */
import { X509Certificate, createHash } from "node:crypto";
import { networkInterfaces } from "node:os";

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

/**
 * The certificate's public key as SPKI PEM, or "" for input that is not a certificate. This is what
 * a renewal carries so the leaf keeps its identity: the key is what a peer's pin names, and it
 * outlives any single certificate.
 */
export function publicKeyOf(certPem: string | undefined): string | undefined {
  if (!certPem) return undefined;
  try {
    return new X509Certificate(certPem).publicKey.export({ type: "spki", format: "pem" }).toString();
  } catch {
    return undefined;
  }
}

/**
 * The stable identity of a leaf: SHA-256 over its SPKI, in Node's `AA:BB:…` form. A renewal keeps
 * this value; the certificate fingerprint changes. Per-peer pins name this, so rotation is invisible
 * to a peer that already trusts the Host.
 */
export function keyFingerprintOf(certPem: string): string {
  return spkiFingerprint(new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" }));
}

/** `keyFingerprintOf` from a certificate's DER (`PeerCertificate.raw` in a TLS callback). */
export function keyFingerprintFromRaw(certDer: Buffer): string {
  return spkiFingerprint(new X509Certificate(certDer).publicKey.export({ type: "spki", format: "der" }));
}

function spkiFingerprint(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest("hex").toUpperCase().match(/.{1,2}/g)!.join(":");
}

type Forge = typeof import("node-forge");
/** A forge public key (`pki.rsa.setPublicKey(...)` / `pki.publicKeyFromPem(...)`). */
type ForgeKey = ReturnType<Forge["pki"]["publicKeyFromPem"]>;

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
 * Every non-internal IPv4 address of this machine, in interface order (#91). A machine on an office
 * LAN and a VPN (or a Docker bridge) is dialled on any of them; a leaf naming only the first one
 * failed the others with "IP address mismatch". IPv6 is left out: Daemons dial IPv4 addresses.
 */
export function localAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) if (ni.family === "IPv4" && !ni.internal && !out.includes(ni.address)) out.push(ni.address);
  }
  return out;
}

/**
 * The leaf SAN list. Includes the hostname, its `advertise` address, every local IP, any names a
 * person added (`security.tls.sans`), and loopback. IPs must be included: a DNS-only SAN fails a
 * connection to `127.0.0.1` with `ERR_TLS_CERT_ALTNAME_INVALID` (measured in the spec).
 */
export function sanList(input: { host: string; advertise?: string; lan?: string | string[]; extra?: string[] }): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => {
    // `advertise` may be `host:port`; a bracketed IPv6 address keeps its colons.
    const raw = v?.trim() ?? "";
    const name = (raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : /^[^:]+:\d+$/.test(raw) ? raw.split(":")[0] : raw).trim();
    if (name && !out.includes(name)) out.push(name);
  };
  add(input.host);
  add(input.advertise);
  for (const lan of Array.isArray(input.lan) ? input.lan : [input.lan]) add(lan);
  for (const extra of input.extra ?? []) add(extra);
  add("127.0.0.1");
  add("localhost");
  return out;
}

/** The names in `names` that `certPem` does not carry as a SAN entry (#91: doctor names them). */
export function missingSans(certPem: string, names: string[]): string[] {
  return names.filter((n) => !sanCovers(certPem, n));
}

/**
 * Does `certPem` carry a SAN entry for exactly `name`? A substring test is wrong: `IP Address:127.0.0.1`
 * is a prefix of `IP Address:127.0.0.10` and `DNS:desk` of `DNS:desk.example`, so an address change
 * would keep the stale leaf and every connection to the new name would fail closed with
 * `ERR_TLS_CERT_ALTNAME_INVALID`.
 */
export function sanCovers(certPem: string, name: string): boolean {
  const sanText = new X509Certificate(certPem).subjectAltName ?? "";
  const kind = /^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(":") ? "IP Address" : "DNS";
  // Node prints SANs as a comma-separated list; an entry ends at the separator, so require the exact
  // `Kind:name` token rather than a prefix of a longer one.
  return sanText.split(/,\s*/).some((entry) => entry === `${kind}:${name}`);
}

/**
 * Did `caPem` issue `leafPem`? A leaf from another CA fails every peer's verification (fail-closed),
 * and `ensureLeaf` used to keep it because only SANs and expiry were compared — a Host that booted on
 * a temporary local CA and later enrolled the real one never recovered, even across restarts.
 */
export function issuedBy(caPem: string, leafPem: string): boolean {
  try {
    const leaf = new X509Certificate(leafPem);
    const ca = new X509Certificate(caPem);
    return leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
  } catch {
    return false;
  }
}

/**
 * Issue one Daemon leaf: RSA-2048 (node-forge 1.x has no EC key generation — see the spec's honest
 * boundaries), 90-day validity by default, signed by the CA. SANs are DNS and IP entries as the
 * names require.
 *
 * `key` is the leaf's existing private key (PEM) or public key (SPKI PEM) when a **renewal** must
 * keep its identity: a fresh key would change what the per-peer pin names, and every peer that
 * already pinned this Host would refuse the renewed leaf — fail-closed, so there is no rescue
 * (v4-6 §5 A/B). With no `key`, this is a first issuance and a new key pair is generated.
 *
 * RSA costs ~23% more handshake CPU than ECDSA P-256 (spec §2), which is paid once per connection
 * and per reconnect; cafe keeps one long-lived WebSocket, so steady-state cost is unchanged.
 */
export async function issueLeaf(ca: CertPair, sans: string[], days = 90, key?: string): Promise<CertPair> {
  const { pki, md } = await forge();
  const caCert = pki.certificateFromPem(ca.cert);
  const caKey = pki.privateKeyFromPem(ca.key);
  // A private key is re-used as-is; a public key (SPKI) only signs the certificate, so the caller
  // keeps the private half. No key at all means first issuance.
  let publicKey: ForgeKey;
  let privateKeyPem: string;
  if (key?.includes("PRIVATE KEY")) {
    const priv = pki.privateKeyFromPem(key);
    publicKey = pki.rsa.setPublicKey(priv.n, priv.e);
    privateKeyPem = key;
  } else if (key) {
    publicKey = pki.publicKeyFromPem(key);
    privateKeyPem = "";
  } else {
    const keys = pki.rsa.generateKeyPair(2048);
    publicKey = keys.publicKey;
    privateKeyPem = pki.privateKeyToPem(keys.privateKey);
  }
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
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
  return { cert: certPem, key: privateKeyPem, fingerprint256: fingerprintOf(certPem) };
}