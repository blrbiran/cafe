# v4-6 — Transport security: TLS between cafe daemons and agents (#61)

Status: **implemented 2026-11-24 (phase 1).** Drafted 2026-11-23 from
dogfooding ledger #61. The owner approved Q1–Q5 as recommended and confirmed
that the design requires both SAN validation and fingerprint pinning.

Implementation notes (2026-11-24):

- **Leaf keys are RSA-2048, not ECDSA P-256.** `node-forge` 1.x has no EC key
  generation (`pki.ec` does not exist), and the spec's own constraint was "no
  new dependency beyond `node-forge`". RSA costs ~23% more CPU per handshake
  (§2), paid once per connection and per reconnect; cafe keeps one long-lived
  WebSocket, so steady-state cost is unchanged. Moving to ECDSA later means
  generating the leaf with Node's own `crypto.generateKeyPairSync("ec", …)` and
  signing the TBSCertificate by hand, or adding a second library — not done here.
- **Trust bootstrap**: a Root with no CA creates one; a child with a configured
  `root` and no CA fetches the Root's public `ca.crt` (`GET /api/tls`), refusing a
  configured-pin mismatch and persisting a TOFU fingerprint; a standalone Daemon
  creates a local CA. If the Root is unreachable at boot, the child starts on an
  in-memory local CA (never plaintext) and its daemon-to-daemon links stay on
  `ws://` until enrolment succeeds.
- **No daemon-to-daemon leaf signing over the network yet** beyond the Root
  issuing to the child's SANs on `POST /api/tls/leaf`; phase 2 (mutual TLS) is
  still out of scope.

## 0. Why

Today cafe's transport is plaintext end to end:

- `packages/daemon/src/server.ts` builds the server from `node:http`; there is no
  `https` branch and `/ws` upgrades are never encrypted.
- The shared token travels inside the `initialize` frame after a plain `ws://`
  handshake (`packages/daemon/src/daemon.ts`, `connectRoot()` opens
  `ws://<root>/ws`), so anyone on the same LAN who can capture packets has full
  access: ask Orders as any Customer, read every Thread, trigger updates.
- `advertise` / `lanAddress()` make the daemon listen on `0.0.0.0`, so "it is only
  my machine" does not hold once a second Host joins.
- `tokenOf()` also accepts `?token=`, which lands in logs, shell history and any
  proxy in between.

The user's four constraints (confirmed): no purchased certificates; as few npm
packages as possible; no meaningful latency cost; do not raise the Node floor more
than necessary (22.18 → 22.19 was agreed). The Web UI stays on http this round.

## 1. Goals / non-goals

Goals (phase 1 — server authentication):

1. A Root-generated CA signs a leaf certificate per Daemon; nothing is bought.
2. Peers verify the server they dial. Verification failure is **fail-closed** —
   no silent downgrade to plaintext.
3. Agents keep using the token, now inside TLS. Agent identity/cert lifecycle is
   out of scope; a short-lived agent does not get its own certificate.
4. Certificate renewal is hot (no daemon restart, no fleet-wide reconnect storm).

Non-goals this round: mutual TLS between daemons (phase 2), any change to the Web
UI's scheme, per-person certificates, an external CA / `step-ca`.

Anti-goals (would make the round a failure even if it "works"): a fallback to
plaintext on handshake error (that is a downgrade attack); a 90-day leaf with no
proven renewal path (that is an outage on day 90); leaving `?token=` in place.

## 2. Constraints measured (2026-11-23, Node v22.23.1, loopback)

These numbers only establish order of magnitude; they are not absolute for a real
network.

| Scenario | plaintext | TLS | delta |
|---|---|---|---|
| HTTP new connection p50 | 0.54 ms | 2.19 ms | +1.65 ms |
| WS handshake p50 / p95 | 0.95 / 4.55 ms | 2.00 / 9.80 ms | +1.05 / +5.25 ms |
| ECDSA P-256 leaf handshake p50 | — | 1.60 ms | faster than RSA by ~23% |
| WS message round trip | 0.12 ms | 0.098 ms | no measurable difference |
| HTTP keep-alive per request | 0.177 ms | 0.149 ms | no measurable difference |
| 8 MB download | 321 MB/s | 292 MB/s | −9% |

cafe's agents hold **one long-lived WebSocket** (`packages/protocol/src/client.ts`
connects once and reconnects), so the handshake delta is paid at startup and on
reconnect only. Steady-state cost is zero to within noise, which satisfies the
latency constraint.

Dependency choices verified: phase 1 needs **no new dependency** — `node:https`
for the server and Node 22.19's `tls.setDefaultCACertificates()` to make the global
`fetch` / `WebSocket` trust the Root CA. `undici` is the fallback if the Node floor
cannot move (`Agent({ connect: { ca } })` + a per-connection dispatcher). Phase 2
needs `undici` (or the `ws` package's client options) because the global
`WebSocket` cannot carry a client certificate. Certificate generation needs
`node-forge` (one package, 0 transitive dependencies, 1.8 MB); `selfsigned` was
rejected for pulling in 23 transitive packages.

## 3. The shape

### 3.1 Ports

- **4778** carries TLS. Agents, the CLI, connectors and cross-host daemons use it.
- **4777** stays plaintext and serves the Web UI plus loopback-only local calls.
  The Web UI keeps working unchanged because `wsUrl()` already follows
  `location.protocol`.

Same-port sniffing (read the first byte `0x16` and switch) was rejected: it works,
but it multiplies the failure paths (handshake failure, proxies, health checks) for
no benefit.

### 3.2 Certificates

- The Root generates a CA once (`CAFE_HOME/tls/ca.crt` + `ca.key`, mode 0600,
  ~10-year validity). The CA private key never leaves the Root.
- Each Daemon gets a leaf certificate, ECDSA P-256, 90-day validity, with a SAN
  that lists the hostname, `advertise`, `lanAddress()`, `127.0.0.1` and
  `localhost`. SAN must include the IPs: connecting to `127.0.0.1` against a
  DNS-only SAN fails with `ERR_TLS_CERT_ALTNAME_INVALID` (measured).
- Only `ca.crt` and the node's own `cert`/`key` are distributed; the CA key is not.

### 3.3 Trust bootstrap (the critical step)

If the CA itself is delivered over the existing plaintext channel, a
man-in-the-middle simply replaces the CA and TLS buys nothing. The plan is
trust-on-first-use with a pinned fingerprint:

- `cafe root show` prints the CA's SHA-256 fingerprint
  (`X509Certificate.fingerprint256`).
- `cafe connect <host:port> --token <t> --ca-fingerprint <sha256>` verifies the
  fingerprint on first contact and stores it as `security.tls.caFingerprint`.
  After that, only certificates issued by that CA are accepted.
- Without a fingerprint, first contact is allowed (TOFU) with a loud warning; once
  a fingerprint is stored, a mismatch is refused unconditionally.
- Each peer checks the certificate chain against the enrolled CA, validates the
  dialed DNS name or IP against the SAN, and checks the separate peer identity pin
  from §5. `checkServerIdentity` receives the leaf, so it must not compare the leaf
  fingerprint with `security.tls.caFingerprint`.

Both SAN-completeness and fingerprint pinning are done together; they cover
different failures (see §5 detail A).

### 3.4 Config surface

```yaml
security:
  mode: tls          # tls (default) | plaintext
  tls:
    port: 4778
    ca: ~/.cafe/tls/ca.crt
    caFingerprint: "sha256:…"   # TOFU pin
```

- In `mode: tls`, any TLS failure is an error; there is no plaintext fallback.
- Plaintext must be asked for explicitly (`mode: plaintext`). Loopback is
  permitted to stay plaintext by default so local CLI/Web keep working.
- Certificate paths and the TLS port are restart-required; the pin can change hot.

### 3.5 Renewal

`https.createServer({ SNICallback })` returning a fresh `SecureContext` makes new
connections use the new certificate with no restart (measured: 200 → 200). The CLI
exposes `cafe daemon renew-cert`; the Root can also push a reissued leaf. Short
validity is only enabled **together with** a working renewal path — see detail B.

### 3.6 Plaintext residue to fix in the same round

- Drop the `?token=` query parameter; keep `Authorization: Bearer` only.
- Replace every hard-coded `ws://` with a `daemonUrl()` helper so `wss://` is
  expressible (`packages/daemon/src/daemon.ts` has several sites, including
  `connectRoot()` and the direct-link `WebSocket`).
- `cafe doctor`, `cafe root test` and `serve`'s attachment download use hard-coded
  `http://`; make them follow `security.mode`.

## 4. Approaches considered

**A. Two ports, TLS on 4778, plaintext loopback on 4777 (chosen).** Simple, keeps
the Web UI untouched this round, and gives a clear "this is local only" boundary.

**B. One port with protocol sniffing.** Rejected (§3.1).

**C. TLS everywhere including the Web UI now.** Rejected this round by the owner;
it forces browser trust-store issues and self-signed warnings on the UI, which is
a separate product problem.

## 5. Approved certificate checks and lifetime

**A. SAN and fingerprint pin.** Use both. The CA fingerprint authenticates the
trust anchor at enrollment. Rejecting an unexpected leaf under that CA also
requires a separate per-peer identity pin in addition to SAN verification.
The implementation plan must specify pin provisioning and authenticated key
rotation.

**B. Leaf validity: 90 days with automatic renewal.** 90 days shrinks
the exposure window from a leaked key but requires that renewal actually works,
because fail-closed means there is no plaintext rescue when the fleet expires at
once. Recommendation: land the SNICallback hot-renewal and the renew command
**first**, then enable 90-day leaves; do not ship the short validity before the
renewal path is proven.

## 6. Owner decisions

| # | Question | Approved decision |
|---|---|---|
| Q1 | Is `node-forge` acceptable for CA/leaf generation? | **Yes** — one package, 0 transitive deps. If zero-dependency is a hard rule, require a preinstalled OpenSSL and generate via CLI (worse on Windows). |
| Q2 | Where does the CA private key live? | `CAFE_HOME/tls/ca.key`, 0600, Root only. External CA later, not this round. |
| Q3 | Leaf validity 90 days + auto-renew, or 825 days? | **90 days, but only after the renewal path ships** (detail B). |
| Q4 | Keep `mode: plaintext`? | **Keep**, default `tls`, document it as a local/isolation escape hatch. |
| Q5 | When does the Web UI move to https? | Not this round. Ports and `wsUrl()` are already prepared for it. |

## 7. Acceptance criteria

1. With `security.mode: tls`, a plaintext client dialing 4778 fails, and a TLS
   failure never falls back to plaintext (verify with an old-TLS-only probe).
2. `cafe connect --ca-fingerprint <wrong>` fails with an actionable message; with
   the correct pin, a forged leaf from the same CA is rejected.
3. Under `mode: tls`, loopback `cafe status` / `cafe ask` still work (either via the
   plaintext loopback port or via TLS — pick one and document it).
4. After renewal, no restart is needed and new connections use the new certificate.
5. Performance regression baseline (suggested `npm run perf:tls`): steady WS
   round-trip p95 within 10% of plaintext; new-connection p95 delta under 10 ms.
6. `rg 'ws://' packages/` shows only the allowed loopback/plaintext branch;
   `rg 'http://' packages/cli/src` Root probes follow the scheme.
7. `rg 'searchParams.get\("token"\)' packages/` returns nothing.

## 8. Impact list (for the implementation round)

| File | Change |
|---|---|
| `packages/daemon/src/server.ts` | `https` (or dual-port); `upgrade` branch; drop query token |
| `packages/daemon/src/config.ts` | `security.*` in schema, `CONFIG_KEYS`, `DIFF_KEYS`, `configApplyMode` |
| `packages/daemon/src/daemon.ts` | `daemonUrl()` scheme helper; `connectRoot()` / `link()` support `wss://` |
| `packages/protocol/src/client.ts` | accept `https://` / `wss://` or a `tls` option; set CA before connecting |
| `packages/cli/src/main.ts` | `base()` follows scheme; `root test`; `connect --ca-fingerprint`; `renew-cert` |
| `packages/cli/src/doctor.ts` | Root probe over TLS; new checks for validity and fingerprint match |
| `packages/cli/src/serve.ts` | attachment base URL follows the scheme |
| `packages/web/src/api.ts` | no change; just ensure the http UI never dials 4778 |
| `package.json` | `engines.node >= 22.19`; `node-forge` as optionalDependency (Root cert generation only) |
| README / README_zh / SKILL | TLS section: `cafe root show`, `cafe connect --ca-fingerprint`, `security.mode`, ports |

## 9. Honest boundaries

- Verified: every code location above, `tls.setDefaultCACertificates` being
  `@since v22.19.0`, the dependency counts, and all the handshake / throughput /
  pinning / hot-renewal numbers on this machine.
- Not verified: absolute latency over a real network; `SNICallback` behaviour on
  Windows/macOS differences; `node-forge` long-term compatibility past 22.23.1.

## 10. As built (2026-11-24)

Phase 1 is implemented. Three §5 requirements were missing from the first cut and
were closed on 2026-11-24 night, each with a test that failed first:

- **Leaf renewal (§5 B).** A leaf is valid 90 days. Renewal used to be manual
  (`cafe daemon renew-cert`) and `ensureLeaf` only reissued when the SAN set
  changed, so a restart kept an expiring leaf and a fleet that never restarts
  would expire together under fail-closed. Now a leaf inside 21 days is reissued
  at start, and a running Daemon checks every 6 hours and renews in place
  (`setSecureContext`, written through to disk). A child with no CA key asks the
  Root and retries next tick if the Root is unreachable. `tls/store.ts`:
  `leafNeedsRenewal`; `daemon.ts`: `startLeafRenewalCheck`,
  `tlsContext.renew`; `index.ts` wires both.
- **Per-peer leaf pin (§5 A).** `security.tls.pins` and `checkPeerPin` existed
  with no production caller, so an unexpected leaf issued under the trusted CA was
  accepted. Daemon-to-daemon `wss://` now passes `checkServerIdentity`: first
  contact records the leaf under `host:port` (persisted), a different leaf is
  refused. `daemon.ts`: `linkOptions(peerAddr)`, `recordPeerPin`.
- **Exact SAN coverage.** `ensureLeaf` decided "already covered" with a substring
  test, so `127.0.0.1` covered `127.0.0.10` and `desk` covered `desk.example`; the
  stale leaf was kept and the new name failed with
  `ERR_TLS_CERT_ALTNAME_INVALID`. `certs.ts`: `sanCovers()` compares whole
  `subjectAltName` entries.

Still phase 2: mutual TLS (client certs per peer) and ECDSA leaves
(`node-forge` 1.x has no EC keygen).

### 10.1 Follow-up (2026-11-24, same day): rotation × pin, and the SAN gap

The three fixes above interacted in ways that would only show up in a real
rolling network. Four defects were found by reading the code and confirmed with
thrown-away experiments before any test was written:

1. **The custom `checkServerIdentity` disabled SAN verification.** Node
   *replaces* the default identity check when this option is supplied; it does
   not run both. The pin checker therefore made every Daemon-to-Daemon `wss://`
   link skip SAN verification — a leaf for `somewhere.invalid` was accepted when
   dialling `127.0.0.1`, undoing the exact-SAN fix above. `pinnedIdentityCheck`
   now calls Node's `tls.checkServerIdentity` first and the pin second.
   `tests/tls-pinned-san.test.ts` (which also pins the old behaviour down as the
   regression).
2. **Renewal changed the leaf key, so pins would reject the fleet on rotation.**
   `issueLeaf` always generated a new RSA key pair; the pin named the whole
   certificate, so the first renewal (start window, 6 h tick, or `renew-cert`)
   made every pinned peer refuse. `issueLeaf(ca, sans, days, key?)` now re-signs
   the existing key (or an SPKI sent by a child), and `ensureLeaf` / `renew` /
   `POST /api/tls/leaf` all pass it through. `tests/tls-key-continuity.test.ts`,
   `tests/tls-renewal-keeps-key.test.ts`.
3. **Pins now name the key (SPKI), not the certificate.** Certificate
   fingerprints change on every renewal; the key does not. Old certificate pins
   are still accepted while that leaf is unchanged and are **upgraded in place**
   to the key pin on that connection (`checkPeerPin` returns `upgrade`), so an
   upgrade never locks a network out. `certs.ts`: `keyFingerprintOf`; `trust.ts`:
   `checkPeerPin`, `pinnedIdentityCheck`.
4. **`POST /api/tls/renew` did not write the leaf to disk.** It swapped memory
   only, so the next restart served the stale (possibly expiring) leaf again. It
   now goes through `tlsContext.renew`, which writes through. The printed
   fingerprint is still the certificate's.

A pin that genuinely changed (a reinstalled Host) is cleared with
**`cafe host pin <host:port> --clear`** — the refusal message used to name
`cafe connect … --reset-pin`, which never existed. `tests/tls-cli.test.ts`.

### 10.2 Follow-up (same day): the recovery paths

Three more ways the fleet could get permanently stuck, found the same way:

5. **`ensureLeaf` never checked the issuer.** It kept a leaf whose SANs matched and whose expiry was
   fine even when a different CA had signed it. A Host that booted on the temporary local CA and
   then enrolled the real one therefore kept a leaf no peer accepts — across restarts, with no
   rescue. `certs.ts`: `issuedBy()`; `ensureLeaf` reissues (keeping the key) when the leaf is not
   issued by the CA in force. `tests/tls-lifecycle.test.ts`.
6. **The documented enrolment retry did not exist.** `bootstrap.ts` said a child runs on a temporary
   CA and "retries enrolment before the next dial to the Root", but nothing retried: a child started
   before its Root never left the temporary CA (`network` stayed false) and never connected.
   `daemon.ts`: `startEnrolmentRetry()` (immediate attempt, then on the leaf-check tick) calls
   `tlsContext.enrol`, which fetches the CA, reissues the leaf for the existing key, flips
   `network`, and re-points the uplink. `tests/tls-bootstrap.test.ts`.
7. **`cafe daemon renew-cert` on a stopped daemon rotated the key.** It called `issueLeaf` with no
   key, so it changed the identity exactly like the online renewal used to. It now re-signs the key
   on disk. `tests/tls-cli.test.ts`.