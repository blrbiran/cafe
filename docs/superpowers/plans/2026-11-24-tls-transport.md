# v4-6 TLS Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put cafe's daemon-to-daemon and agent transport on TLS (port 4778) with a Root-generated CA, SAN validation plus a per-peer pinned identity, TOFU-with-fingerprint enrolment, and hot leaf renewal — with no plaintext fallback.

**Architecture:** A new `packages/daemon/src/tls/` module owns certificate generation (Root-only CA, per-Daemon leaf), SAN computation, and the pin store. `server.ts` starts a second `https` listener on 4778 (same handlers, plus `SNICallback` for hot renewal) while 4777 stays plaintext for the Web UI and loopback. A `daemonUrl()` helper replaces every hard-coded `ws://`, and `CafeClient` accepts a `tls` option so agents trust the CA. The pin is a separate value from the CA fingerprint: the CA fingerprint authenticates the trust anchor at enrolment, the pin names one peer's leaf public key.

**Tech Stack:** Node 22.19+ (`node:https`, `node:tls`, `tls.setDefaultCACertificates`), `node-forge` (optional dependency, cert generation only), existing `ws` server.

**Spec:** `docs/specs/v4-6-tls.md`

## Global Constraints

- Node floor moves `>= 22.18` → `>= 22.19` (root `engines`, `packages/cli/bin/node-check.mjs`, both READMEs).
- No purchased certificates; `node-forge` is the only new package (optional dependency).
- A TLS failure is **fail-closed**: never fall back to plaintext.
- The Web UI stays on http this round; 4777 stays plaintext for loopback and the UI.
- `?token=` is removed; only `Authorization: Bearer` remains.
- Leaf validity: 90 days, but only enabled together with a working renewal path (SNICallback + `cafe daemon renew-cert` land first).
- CA private key never leaves the Root; mode 0600.
- SAN must include hostname, `advertise`, `lanAddress()`, `127.0.0.1`, `localhost` — IPs included, or `127.0.0.1` connects fail with `ERR_TLS_CERT_ALTNAME_INVALID`.

## Review Focus

- A plaintext client dialing the TLS port must fail, not be silently served.
- An old or mismatched pin must refuse the peer, never warn-and-continue.
- A leaf for a different hostname under the same CA must fail SAN validation.
- Renewal must not restart the daemon nor drop live connections.
- A missing/unreadable CA file at startup must fail startup with an actionable message, not start plaintext.

---

### Task 1: Certificate module

**Files:**
- Create: `packages/daemon/src/tls/certs.ts`
- Test: `tests/tls-certs.test.ts`

**Interfaces:**
- Produces: `generateCa(): Promise<{ cert: string; key: string; fingerprint256: string }>`, `issueLeaf(ca: { cert: string; key: string }, sans: string[], days = 90): Promise<{ cert: string; key: string; fingerprint256: string }>`, `sanList(input: { host: string; advertise?: string; lan?: string }): string[]`, `fingerprintOf(certPem: string): string`.

- [ ] Step 1: failing test asserting a generated CA verifies a leaf, the leaf's SANs contain every requested name, and `fingerprintOf(leaf.cert)` equals the leaf's `X509Certificate.fingerprint256`.
- [ ] Step 2: run `npx vitest run tests/tls-certs.test.ts`; expect "generateCa is not a function".
- [ ] Step 3: implement with `node-forge` (ECDSA P-256 leaf, RSA-2048 CA, `extensions: [{ name: "subjectAltName", altNames: [...] }]` with IP type 7 for IPs); `fingerprintOf` uses `new X509Certificate(pem).fingerprint256`.
- [ ] Step 4: run the test; expect PASS.
- [ ] Step 5: commit.

### Task 2: Pin store and trust bootstrap

**Files:**
- Create: `packages/daemon/src/tls/trust.ts`
- Test: `tests/tls-trust.test.ts`

**Interfaces:**
- Produces: `readTlsConfig(raw): { mode: "tls" | "plaintext"; port: number; ca?: string; caFingerprint?: string; pins: Record<string,string> }`, `enrollFingerprint(seen: string, expected?: string): { ok: boolean; reason?: string }`, `checkPeerPin(host: string, leafFingerprint: string, pins: Record<string,string>): { ok: boolean; firstSeen?: boolean; reason?: string }`.

- [ ] Step 1: failing test: no expected fingerprint → enrol with firstSeen; wrong expected → refuse; stored pin equal → ok; stored pin different → refuse with a reason naming both fingerprints.
- [ ] Step 2: run; expect failure.
- [ ] Step 3: implement pure functions plus config parsing (no I/O).
- [ ] Step 4: run; expect PASS.
- [ ] Step 5: commit.

### Task 3: Config surface

**Files:**
- Modify: `packages/daemon/src/config.ts`
- Test: `tests/config-contract.test.ts` (new cases)

**Interfaces:**
- Produces: `CafeConfig.security = { mode: "tls"|"plaintext", tls: { port: number, ca?: string, caFingerprint?: string, pins: Record<string,string> } }`; `configApplyMode` returns `hot` for `security.tls.caFingerprint` and `security.tls.pins.*`, `restart-required` for port/ca/mode.

- [ ] Step 1: failing test: default `security.mode` is `tls`; `security.tls.port` defaults to 4778; `configApplyMode("security.tls.pins.x")` is `hot`; `configDiff` reports a changed `security.mode`.
- [ ] Step 2: run; expect failure.
- [ ] Step 3: add the schema (with `.default({})`), extend `DIFF_KEYS`, extend `configApplyMode`.
- [ ] Step 4: run; expect PASS.
- [ ] Step 5: commit.

### Task 4: Dual-port server with SNICallback

**Files:**
- Modify: `packages/daemon/src/server.ts`
- Modify: `packages/daemon/src/index.ts`
- Test: `tests/tls-server.test.ts`

**Interfaces:**
- Consumes: certs/trust modules; `startServer(daemon, { port, tlsPort?, tls?: { key, cert, ca, onRenew } , webDist? })` returns `ServerHandle & { tlsPort?: number }`.
- Produces: TLS listener serves `/api/health` and `/ws`; plaintext listener unchanged.

- [ ] Step 1: failing test: start a daemon with TLS enabled in a scratch home, `fetch("https://127.0.0.1:<tlsPort>/api/health", { dispatcher })` or `https.request` with `ca` succeeds; `http://` against the TLS port fails; plaintext port still answers.
- [ ] Step 2: run; expect failure.
- [ ] Step 3: factor the request handler so both servers share it; add `https.createServer({ key, cert, SNICallback })`; share `wss`/upgrade handling.
- [ ] Step 4: run; expect PASS.
- [ ] Step 5: commit.

### Task 5: URL helper and client TLS

**Files:**
- Modify: `packages/daemon/src/daemon.ts` (replace hard-coded `ws://`), `packages/protocol/src/client.ts`, `packages/cli/src/main.ts` (`base()`), `packages/cli/src/doctor.ts`
- Test: `tests/tls-urls.test.ts`

**Interfaces:**
- Produces: `daemonUrl(addr: string, opts: { tls: boolean }): string` (`wss://` or `ws://`), `httpUrl(addr, { tls })`; `new CafeClient({ daemon, tls?: { ca?: string; caFingerprint?: string; pins?: Record<string,string> } })`.

- [ ] Step 1: failing test: `daemonUrl("h:1", { tls: true }) === "wss://h:1"`; a client with `tls` connects to a TLS daemon and asks a question end to end.
- [ ] Step 2: run; expect failure.
- [ ] Step 3: implement `daemonUrl`; use `tls.setDefaultCACertificates([...tls.getCACertificates("system"), caPem])` before connecting; keep `rejectUnauthorized` on.
- [ ] Step 4: run; expect PASS.
- [ ] Step 5: commit.

### Task 6: Drop `?token=` and CLI enrolment

**Files:**
- Modify: `packages/daemon/src/server.ts` (`tokenOf`), `packages/cli/src/main.ts` (`root show`, `connect --ca-fingerprint`, `daemon renew-cert`)
- Test: `tests/tls-enrol.test.ts`, `tests/security.test.ts` (new case: `?token=` is rejected)

- [ ] Step 1: failing tests: a remote request with `?token=` gets 401; `cafe root show` prints `sha256:<fingerprint>`; `cafe connect --ca-fingerprint <wrong>` exits non-zero with an actionable message.
- [ ] Step 2: run; expect failure.
- [ ] Step 3: remove the query-token branch; add the three CLI commands (enrolment verifies before writing config, like `assertDaemonAddress`).
- [ ] Step 4: run; expect PASS.
- [ ] Step 5: commit.

### Task 7: Renewal and docs

**Files:**
- Modify: `packages/daemon/src/tls/certs.ts` (`renewLeaf`), `packages/daemon/src/index.ts` (load/refresh context), `README.md`, `README_zh.md`, `skills/cafe/SKILL.md`, `package.json` engines, `packages/cli/bin/node-check.mjs`
- Test: `tests/tls-renew.test.ts`

- [ ] Step 1: failing test: after `onRenew` swaps the context, a new connection presents the new leaf fingerprint while the existing connection keeps working.
- [ ] Step 2: run; expect failure.
- [ ] Step 3: implement `SNICallback` returning a fresh `SecureContext`; wire `cafe daemon renew-cert`; update docs and the Node floor.
- [ ] Step 4: run `npm test`, `npm run typecheck`, `npm run routing:eval`; expect all green.
- [ ] Step 5: commit.