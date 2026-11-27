# Host and Caller Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep each task's test cycle isolated and complete its review before moving to the next task.

**Goal:** Bind Cafe Hosts and task-changing callers to credentials that prevent shared-token impersonation, unauthorized cancellation/reply, false provenance, and cross-caller idempotency leaks.

**Architecture:** Root-issued client/server certificates carry a stable Host ID; the shared TLS listener requests client certificates but enforces them only for daemon/peer handshakes. The Order-owning Host validates exact caller and delivery authority, durably journals assignment/replacement transitions, and acts as the trusted origin for cross-Host events. HTTP human, connector, and operator capabilities are distinct; caller-supplied display provenance never grants authority.

**Tech Stack:** TypeScript, Node TLS/HTTPS/WebSocket, Zod protocol schemas, SQLite + per-Thread JSONL, Vitest, Commander CLI, React Web UI.

**Spec:** `docs/superpowers/specs/2026-11-27-host-and-caller-authorization-design.md`

## Global Constraints

- A Root-issued Host identity is an immutable random `hostId`, separate from host slug, display name, aliases, and addresses.
- Remote daemon/peer links require verified mutual TLS and `host-auth-v1`; no downgrade to shared-token identity.
- The shared Root token cannot enroll/replace a Host or authorize operator overrides by itself.
- Legacy events remain readable but are labeled unverified; do not infer cryptographic identity from old Host slugs or addresses.
- Owner keys and connector/operator credentials never enter event bodies, logs, or another Host's persistent store.
- Loopback UI/Agent TLS access stays certificate-free; HTTP caller capabilities are sent only over loopback or Root-CA-verified TLS.
- Root is the sole attestor for cross-Host relays; direct offline links accept events only from the authenticated event Host.
- `order.replaced` is one durable journal transition and replay cannot cancel a newer Order.
- No npm publish, production Root restart, external issue-ledger edit, or physical second-Host claim is part of local verification.

## Review Focus

- A Host with a Root-approved but revoked SPKI must not reconnect through a cached address pin; assert the authoritative hostId/SPKI binding on every direct or Root link.
- Backfill/replay may arrive before `order.created` or `order.assigned`; stage durably and apply only after exact assignment/delivery proof.
- A human clarification answer may arrive on a different Host from the original Agent-created clarification Thread; validate the owner attestation without moving the raw owner key.
- A replacement may race a final reply/cancel or crash between journal and metadata writes; compare-and-append one event and recover from it.
- Duplicate raw idempotency keys across human, MCP, connector, and Agent callers must never return another caller's IDs/results; assert caller scope and payload hash.

---

## File map

- `packages/protocol/src/index.ts` — Host identity/feature handshake, event actor/source, assignment IDs, owner attestation, replacement event, and connector/caller schemas.
- `packages/protocol/src/peer.ts` — authenticated peer identity metadata and handshake sequencing.
- `packages/daemon/src/tls/certs.ts` — Host identity SAN and dual server/client certificate usages.
- `packages/daemon/src/tls/bootstrap.ts`, `trust.ts`, `store.ts` — invite/renew request, Root ID pin, key possession challenge, and local certificate persistence.
- `packages/daemon/src/config.ts`, `store.ts` — durable Root/Host identity maps, invitation/rekey state, actor digests, connector credentials, pending-event journal, and replacement indexing.
- `packages/daemon/src/server.ts` — optional client-certificate request on the shared listener, invitation/renew endpoints, TLS enforcement for caller capabilities, and operator-key checks.
- `packages/daemon/src/daemon.ts` — identity-bound peer admission, assignment journal/relay, event authority, pending replay, owner validation, idempotency scopes, replacement and operator transitions.
- `packages/cli/src/main.ts`, `mcp.ts`, `connector.ts`, `bridge/barista.ts`, plus a focused HTTP endpoint helper — host invite/connect, TLS endpoint selection, exact Order cancel/replace, owner/operator credentials, MCP opt-in, and connector provisioning.
- `packages/web/src/api.ts`, `pages/Conversation.tsx`, `pages/Feed.tsx`, `outcome.ts` — owner capability use, exact Order Stop, and unverified provenance/operator display.
- `tests/tls-*.test.ts`, `tests/team-security.test.ts`, `tests/provenance.test.ts`, `tests/cli.test.ts`, `tests/mcp.test.ts`, `tests/connector*.test.ts`, and new focused test files — behavioral coverage for each contract below.

## Task 1: Protocol and persistence primitives

**Files:** `packages/protocol/src/index.ts`, `packages/protocol/src/version.ts`, `packages/daemon/src/store.ts`, create `tests/protocol-auth.test.ts`, create `tests/store-event-auth.test.ts`

**Interfaces:**
- Add `HostIdentity { hostId, host, keyFingerprint, state }` and optional `InitializeParams.hostId`/`hostAuthVersion`; `DaemonRecord.hostId` becomes the stable ID, while `host` remains the routing slug.
- Add `ThreadEnvelope.eventHostId` and `actor { kind: human|connector|agent|operator, principalId }`.
- Add `assignmentId` to assignment, acknowledgement, delivery, reply, decline, and dispatch-failure records.
- Add `parentOwnerAttestationId`/`parentOwnerAttestation` to linked human follow-up Orders; keep `parentOwnerVerified` only as derived local metadata.
- Add `order.replaced`, `order.overridden`, and durable `order.assigned` event variants.
- Add `caller-auth-v1`, `host-auth-v1`, and `team-roster-ack-v1` feature names.
- Store methods: `putHostIdentity`, `getHostIdentity`, `putInviteRedemption`, `getInviteRedemption`, `putCallerPrincipal`, `getCallerPrincipal`, `stagePendingEvent(env, missingAuthority)`, `listPendingEvents(threadId?)`, `commitPendingEvents(file, eventIds)`, and `readOrderEvents` support for indexing `order.replaced` under both old/new IDs.

- [x] Write failing protocol parsing tests for host/actor fields, assignment IDs, replacement/override events, attestation, and capability names.
- [x] Run `npx vitest run tests/protocol-auth.test.ts` and confirm each new contract fails before implementation.
- [x] Add Zod schemas and types in `packages/protocol/src/index.ts`; add the feature names without changing `PROTOCOL_VERSION` in this task.
- [x] Write failing Store tests in `tests/store-event-auth.test.ts` that append/recover an `order.replaced` envelope indexed by both old and new IDs, and stage/replay an event with a missing creation/assignment dependency.
- [x] Run `npx vitest run tests/store-event-auth.test.ts` and confirm it fails because the replacement index and pending-event persistence are absent.
- [x] Implement atomic pending-event and replacement indexes in `packages/daemon/src/store.ts`; preserve JSONL as the event source of truth.
- [x] Run `npx vitest run tests/protocol-auth.test.ts tests/store-event-auth.test.ts` and confirm pass.
- [x] Review `git diff --check`, stage only Task 1 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 2: Host identity certificate lifecycle

**Files:** `packages/daemon/src/tls/certs.ts`, `tls/store.ts`, `tls/bootstrap.ts`, `tls/trust.ts`, `config.ts`, `store.ts`, `tests/tls-certs.test.ts`, `tests/tls-bootstrap.test.ts`

**Interfaces:**
- `issueHostLeaf(ca, sans, hostId, existingKey?) -> CertPair` issues serverAuth+clientAuth and signed Host-ID SAN.
- `createInvite(replaceHost?, expectedHostRevision?) -> { invite, expiresAt }` returns plaintext invite once and stores only its hash.
- `redeemInvite({ invite, requestId, publicKey, sans }) -> { hostId, cert, host, retry }` binds the one-use invite to key/SAN/request ID; same redemption retries are idempotent.
- `renewHostLeaf({ hostId, requestId, nonce, signature, publicKey, sans }) -> CertPair` requires possession of the enrolled private key, including after leaf expiry.

- [ ] Add failing cert tests for dual EKU, hostId SAN, wrong key/host binding, and leaf renewal preserving hostId.
- [ ] Add failing invite tests for one-use atomic redemption, lost-response retry, changed key/SAN rejection, replacement compare-and-swap, and `credential_superseded` tombstones.
- [ ] Run the focused TLS tests and confirm expected RED failures.
- [ ] Implement CA-issued Host identity certificates and persist Root's `hostId -> routing slug/SPKI/revision` map.
- [ ] Make Root invitation consumption and replacement one durable Store transaction; store a non-secret tombstone after rekey.
- [ ] Implement key possession renewal challenge over pinned Root TLS; start a child with expired/unavailable Root leaf in local-only mode and retry without plaintext downgrade.
- [ ] Verify `cafe connect` fetches public CA without credentials, verifies the Root Host ID over TLS, and only then sends token/invite/SANs.
- [ ] Run focused TLS/bootstrap tests and `npm run typecheck`; confirm all pass.
- [ ] Review `git diff --check`, stage only Task 2 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 3: Mutual TLS admission and Host identity pinning

**Files:** `packages/daemon/src/server.ts`, `packages/daemon/src/daemon.ts`, `packages/protocol/src/peer.ts`, `packages/daemon/src/tls/trust.ts`, `tests/tls-server.test.ts`, `tests/tls-peer-pin.test.ts`, `tests/versions.test.ts`

**Interfaces:**
- TLS server requests client certificates with `rejectUnauthorized: false`; `accept()` requires `socket.authorized`, CA validation, and a registered hostId only after `initialize.kind` is daemon/peer.
- `Peer.hostIdentity` records immutable hostId/SPKI; do not bind RPC methods until protocol, capability, and identity checks finish.
- Outbound Root/peer clients present the local certificate and validate the remote certificate hostId against `rootHostId` or the current Root-authenticated peer map before installing handlers.

- [ ] Add failing tests that unauthenticated Web/Agent TLS still works, while daemon/peer TLS with absent, invalid, wrong-Host, or revoked certificates is refused before registry/RPC binding.
- [ ] Add failing outbound tests for wrong Root ID on first bootstrap, Root address changes with same ID, direct peer identity mismatch, and rekey socket closure.
- [ ] Add a capability test: new client + old daemon/peer fails with `host_auth_required`; new peer succeeds only after enrollment.
- [ ] Run `npx vitest run tests/tls-server.test.ts tests/tls-peer-pin.test.ts tests/versions.test.ts` and confirm RED failures.
- [ ] Implement optional client-cert request on the shared TLS listener, Host handshake checks, full identity-map refresh, pin migration, and handler binding only after validation.
- [ ] Add enrollment doctor/status output and actionable mixed-version errors.
- [ ] Run focused tests and `npm run typecheck`; confirm pass.
- [ ] Review `git diff --check`, stage only Task 3 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 4: Assignment, event authority, backfill, and reporting

**Files:** `packages/daemon/src/daemon.ts`, `packages/daemon/src/store.ts`, `packages/protocol/src/index.ts`, `tests/team-security.test.ts`, `tests/followup-recovery.test.ts`, `tests/e2e.test.ts`, new `tests/host-event-auth.test.ts`

**Interfaces:**
- Persist `order.assigned { assignmentId, orderId, threadId, targetAgentId, targetHostId, bodyHash }` on the Order-owning Host before `order/relay`.
- Recipient inbox is keyed by assignmentId. Agent acceptance ack carries assignmentId after durable local queueing; duplicates return the prior receipt and never reinject.
- `order.dispatch-failed` reports a recipient-side send/ack failure; only the owner Host marks the target failed and triggers fallback.
- Pending events are journaled durably on Root/direct receivers until `order.created`/`order.assigned`/`order.replaced` dependencies and exact target proof validate.

- [ ] Add RED tests for forging `eventHostId`, self-assignment, non-target/mismatched assignment replies, duplicate assignment delivery, lost acceptance receipt after restart, fallback after delivery failure, out-of-order assignment/backfill, and two attempts racing to final.
- [ ] Add RED tests for offline direct-link events, Root pending-event recovery after restart, late final recovery before close, audit-only replay after close, and human-parent attestation/answer retries across Hosts.
- [ ] Run the focused tests and confirm fail for the expected unauthorized/missing behavior.
- [ ] Implement durable `order.assigned` journal records and exact assignmentId checks at recipient and owner.
- [ ] Implement recipient inbox/Agent receipt replay; assignment status query prevents replaying superseded work, while late final replies from prior attempts remain auditable and may recover an open target.
- [ ] Implement type-specific event authority for order creation/assignment/delivery/dispatch failure/Agent events/cancel/close/override; quarantine pending events until proofs arrive.
- [ ] Implement Root and direct receiver pending journals, durable ack semantics, and source-only backfill.
- [ ] Implement human clarification attestation in the owner-authored follow-up `order.created`; derive `parentOwnerVerified` locally and remove all trust in caller booleans.
- [ ] Run focused event/team tests and `npm run typecheck`; confirm pass.
- [ ] Review `git diff --check`, stage only Task 4 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 5: Caller credentials, HTTP provenance, and idempotency

**Files:** `packages/daemon/src/daemon.ts`, `packages/daemon/src/store.ts`, `packages/daemon/src/server.ts`, `packages/cli/src/main.ts`, `packages/cli/src/mcp.ts`, `packages/connector/src/client.ts`, connector install/supervisor files, `tests/provenance.test.ts`, `tests/mcp.test.ts`, `tests/connector.test.ts`, create `tests/caller-identity.test.ts`

**Interfaces:**
- `CallerPrincipal { kind, principalId, scopeKey }` is resolved from a registered Agent, first-use human owner capability, or provisioned connector capability. `scopeKey` is an internal digest and never serialized.
- HTTP create/cancel/replace on remote networks require Root-CA-verified TLS plus owner/connector capability. Loopback remains supported.
- `idempotencyKey` is scoped to caller principal and canonical request hash; mismatched payload returns `idempotency_conflict`.
- `CAFE_HOME/operator.key` is generated with exclusive creation, mode 0600; only its digest is stored in daemon state. `replyAs` and operator cancellation require loopback plus this key and a locally owned Order.

- [ ] Add failing tests for two callers reusing the same key, same-scope changed payload, no-identity key rejection, owner first-use, connector unprovisioned/installed/force/restart/remove, and remote plaintext rejection.
- [ ] Add failing tests that `as`/`origin`/`via` create only unverified display claims and never Agent authority, parent-link authority, or idempotency scope.
- [ ] Add failing tests for operator credentials absent/wrong/present, local vs remote host, local Order vs remote Order, and MCP tool disabled by default/enabled only with `--operator`.
- [ ] Implement first-use owner principal digest, provisioned connector identity, operator key bootstrap, truthful actor/provenance fields, and secure transport selection: CLI uses loopback HTTP locally and the configured/pinned Root TLS endpoint remotely; Web uses its HTTPS origin and explains `tls_required` when opened remotely over HTTP.
- [ ] Implement caller-scoped idempotency and keep the bounded process-local retry contract; failed creates remove their cache entry.
- [ ] Run focused CLI/MCP/connector/provenance tests and `npm run typecheck`; confirm pass.
- [ ] Review `git diff --check`, stage only Task 5 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 6: Exact cancel/replace and operator override transitions

**Files:** `packages/protocol/src/index.ts`, `packages/daemon/src/daemon.ts`, `packages/daemon/src/server.ts`, `packages/cli/src/main.ts`, `packages/web/src/api.ts`, `packages/web/src/pages/Conversation.tsx`, `tests/team-security.test.ts`, `tests/cli.test.ts`, create `tests/operator-override.test.ts`, create `tests/web-provenance.test.ts`

**Interfaces:**
- Cancel payload is `{ threadId, orderId, ownerKey? }`; actor is authenticated Agent creator, HTTP owner principal, or explicitly authorized local operator.
- Replace payload is `{ replaceOrderId, ...newOrder }`; require matching owner/connector/Agent identity for that exact old Order.
- `order.replaced` is a single journal event containing exact old ID, full new Order, validated route decision, and stable assignment IDs; it is indexed by both Order IDs. Recovery reconstructs both sides from this one event.
- `order.overridden` is a separate operator event with `targetAgentId` and operator actor. A serialized target transition makes the first terminal Agent reply/override win; late final events are audit-only.

- [ ] Add RED tests for non-owner protocol/HTTP cancellation, stale threadId vs exact orderId, unauthorized replace leaving old Order open, and final reply/cancel racing with replace.
- [ ] Add RED tests for no-target/routing failure leaving old Order open, durable replacement recovery after append/before metadata, owner digest recovery, and idempotency replay vs stale-order after restart.
- [ ] Add RED tests for operator overriding pending/acked/failed/skipped assigned targets, disallowing unassigned/final targets, collect:any/collect:all semantics, interim note, and both arrival orders of final Agent reply vs override.
- [ ] Implement per-Thread serialization/CAS and exact Order authorization before any state transition.
- [ ] Route all accepted replace changes through one durable `order.replaced` append; persist owner digest before append and clean orphan digests on recovery.
- [ ] Update CLI/MCP/Web to include exact orderId and owner/operator headers; preflight `caller-auth-v1` before sending new protocol payloads to older daemons.
- [ ] Update Web/CLI/MCP rendering so operator actor and unverified claims cannot look like Agent-authored responses.
- [ ] Run focused cancellation/replacement/UI tests and `npm run typecheck`; confirm pass.
- [ ] Review `git diff --check`, stage only Task 6 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 7: Package-level verification and operator documentation

**Files:** `docs/specs/v4-6-tls.md`, `docs/specs/2026-11-27-host-and-caller-authorization-design.md`, TLS/networking docs, tests listed above.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test` and require the full suite to pass.
- [ ] Run `npm run routing:eval`, Web check/build, `npm run test:release`, and `npm run test:claude-plugin` where the installed Claude CLI permits it.
- [ ] Review behavior changes and compatibility errors in CLI/MCP/Web; preserve `.vitest/` and never include it in Git.
- [ ] Do not claim physical second-Host or mixed-version readiness until those external checks run.
- [ ] Review `git diff --check`, stage only Task 7 docs/tests, and commit with the required attribution trailer; never stage `.vitest/`.
