import { Agent, request } from "node:https";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateHostKeyPair, hostIdFromCertificate, localAddresses, sanList } from "../packages/daemon/src/tls/certs.ts";

/**
 * A tiny HTTPS GET that trusts exactly one CA. Used by the TLS tests instead of the global `fetch`
 * so each request can carry a different CA without touching process-wide state. Node's default
 * `checkServerIdentity` (SAN verification) is left in place: passing `ca` only changes which roots
 * are trusted, not whether the hostname is checked.
 */
export function httpsRequest(opts: { host: string; port: number; path: string; ca: string; servername?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        method: "GET",
        ca: opts.ca,
        // No SNI for a bare IP; use the DNS name when one is given.
        servername: opts.servername ?? (/\d+\.\d+\.\d+\.\d+/.test(opts.host) ? undefined : opts.host),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A `node:https` Agent that trusts one CA, for client-side tests. */
export function caAgent(ca: string): Agent {
  return new Agent({ ca });
}

/**
 * Enroll a test child with a one-use invite and install its TLS materials under `childHome`:
 * `tls/ca.crt`, `tls/<host>.crt`, `tls/<host>.key`. Returns the pinned Root ID and CA fingerprint
 * for the child's config. The invite comes from the Root's local operator key, so this only works
 * for a Root running on this machine.
 */
export async function enrollTestChild(
  root: { home: string; addr: string; server: { tlsPort?: number } },
  rootHostId: string,
  childHome: string,
  childHost: string,
  opts: { advertise?: string; sans?: string[] } = {},
): Promise<{ rootHostId: string; hostId: string; caFingerprint: string }> {
  const operatorKey = readFileSync(join(root.home, "operator.key"), "utf8");
  const requestInvite = (body: Record<string, string>) => fetch(`http://${root.addr}/api/host/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cafe-operator-key": operatorKey },
    body: JSON.stringify(body),
  });
  let inviteResponse = await requestInvite({ name: childHost });
  if (inviteResponse.status === 409) {
    // A refused/legacy Host with that slug still exists: re-enroll it explicitly (owner action).
    inviteResponse = await requestInvite({ replaceHost: childHost });
  }
  if (inviteResponse.status !== 200) throw new Error(`invite failed: ${await inviteResponse.text()}`);
  const invite = (await inviteResponse.json()) as { inviteCode: string; hostId: string };
  const ca = readFileSync(join(root.home, "tls", "ca.crt"), "utf8");
  const keys = await generateHostKeyPair();
  const sans = sanList({ host: childHost, advertise: opts.advertise ?? "127.0.0.1", lan: localAddresses(), extra: opts.sans });
  const payload = JSON.stringify({ inviteCode: invite.inviteCode, requestId: `test-${childHost}`, publicKey: keys.publicKey, sans });
  const enrolled = await new Promise<{ cert: string; hostId: string; caFingerprint: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: root.server.tlsPort!,
        path: "/api/tls/leaf",
        method: "POST",
        ca,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: "Bearer t0k" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) !== 200) return reject(new Error(`enroll failed: ${text}`));
          resolve(JSON.parse(text));
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
  if (hostIdFromCertificate(enrolled.cert) !== invite.hostId) throw new Error("issued certificate host ID mismatch");
  mkdirSync(join(childHome, "tls"), { recursive: true });
  writeFileSync(join(childHome, "tls", "ca.crt"), ca, { mode: 0o644 });
  writeFileSync(join(childHome, "tls", `${childHost}.crt`), enrolled.cert, { mode: 0o644 });
  writeFileSync(join(childHome, "tls", `${childHost}.key`), keys.privateKey, { mode: 0o600 });
  return { rootHostId, hostId: invite.hostId, caFingerprint: enrolled.caFingerprint };
}

/**
 * Start an invited child against `root`. `opts.config` is merged over the enrollment config, so a
 * test can still set `advertise`, `knownDaemons`, extra `pins`, etc.
 */
export async function startEnrolledChild(
  root: { home: string; addr: string; server: { tlsPort?: number }; daemon: { hostId: string } },
  host: string,
  opts: { home?: string; config?: Record<string, any>; timing?: Record<string, number>; log?: (line: string) => void; assignmentRelayFixture?: boolean } = {},
): Promise<Awaited<ReturnType<typeof import("./helpers.ts")["startDaemon"]>>> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { startDaemon } = await import("./helpers.ts");
  const home = opts.home ?? mkdtempSync(join(tmpdir(), `cafe-enrolled-${host}-`));
  const advertise = typeof opts.config?.advertise === "string" ? opts.config.advertise : undefined;
  const sans = Array.isArray(opts.config?.security?.tls?.sans) ? opts.config.security.tls.sans : undefined;
  const enrolled = await enrollTestChild(root, root.daemon.hostId, home, host, { ...(advertise ? { advertise } : {}), ...(sans ? { sans } : {}) });
  const security = {
    ...(opts.config?.security ?? {}),
    mode: "tls",
    tls: { ...(opts.config?.security?.tls ?? {}), port: 0, caFingerprint: enrolled.caFingerprint, rootHostId: enrolled.rootHostId },
  };
  return startDaemon(host, {
    ...(opts.timing ? { timing: opts.timing } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.assignmentRelayFixture ? { assignmentRelayFixture: true } : {}),
    home,
    config: { ...(opts.config ?? {}), root: root.addr, security },
  });
}