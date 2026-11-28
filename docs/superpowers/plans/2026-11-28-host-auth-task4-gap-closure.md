# Host Auth Task 4 Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Host Auth Task 4 so assignment, recipient acceptance, relayed events, recovery, and human clarification answers are durable and authorized by one exact assignment contract.

**Architecture:** The Order-owning Host writes canonical creation and assignment records before relay. The recipient durably queues an assignment and receipt before notifying its Agent. All direct, Root-ingress, and backfill events pass through a type-specific authorization gate; events missing canonical dependencies are durably staged, then validated and applied once. Human clarification proof is carried by an owner-authored event and re-derived during recovery.

**Tech Stack:** TypeScript, Node TLS/WebSocket, Zod, SQLite, per-Thread JSONL, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-host-and-caller-authorization-design.md` (independently reviewed in this session; see review findings in the session transcript and handoff update).

## Global Constraints

- Preserve immutable Host identity and require verified mutual TLS for daemon/peer links.
- The Order-owning Host is authoritative for shared Order lifecycle and assignments.
- Assignment identity is the exact tuple of assignmentId, orderId, threadId, recipient agentId, and recipient hostId.
- Recipient acceptance is at-least-once transport with idempotent durable receipt; never reinject an assignment already durably queued.
- Validate authority before projections, journal-derived state, or client notifications change.
- Missing dependencies are durably staged and replayed only after canonical proof arrives.
- Keep `caller-auth-v1` and `team-roster-ack-v1` unadvertised; preserve fail-closed Pi/OMP read-only launch behavior.
- Legacy events remain readable and visibly unverified; do not infer identity from slug or address.
- No production Root restart, external ledger edit, npm publish, or physical second-Host claim is part of local verification.

## Review Focus

- A valid TLS peer submits an event for an assignment addressed to another Host: reject before persistence or projection.
- Recipient restarts after queueing but before receipt delivery: replay the same receipt without injecting the task again.
- Event arrives before `order.created` or `order.assigned`: persist it pending and apply once after canonical backfill, including across restart.
- A late final reply races fallback or another final: exactly one target transition wins; later events remain audit-only.
- A caller supplies or replays `parentOwnerVerified` without a valid answer attestation: keep the clarification unverified and reject parent completion.

---

## Current implementation map

- `packages/protocol/src/index.ts` already defines assignment IDs, event actors, event Host identity, and attestation fields; Task 4 must validate their semantics, not just extend schemas.
- `packages/daemon/src/store.ts` already persists assignment/receipt primitives and pending events and indexes replacement events; confirm their transactional semantics before reusing them.
- `packages/daemon/src/daemon.ts` owns dispatch, relay, direct peer events, backfill, projections, and recovery. `recordEvent()` currently performs source-Host checks but is not a complete event-authority gate.
- `packages/protocol/src/peer.ts` and `packages/protocol/src/client.ts` own wire methods and reconnect identity; ensure all changed payloads are backward-safe and capability-gated.
- Focused existing tests include `tests/store-assignment-inbox.test.ts`, `tests/store-event-auth.test.ts`, `tests/team-security.test.ts`, `tests/followup-recovery.test.ts`, `tests/escalate.test.ts`, `tests/e2e.test.ts`, and TLS/peer tests.

## Task 1: Canonical assignment and relay contract

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/peer.ts`
- Modify: `packages/protocol/src/client.ts`
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/daemon/src/store.ts`
- Test: `tests/store-assignment-inbox.test.ts`
- Test: `tests/team-security.test.ts`
- Create: `tests/host-assignment-relay.test.ts`

**Interfaces:**
- Consumes: Store assignment and receipt methods already present on `Store`; verify signatures and transaction scope before implementation.
- Produces: A canonical assignment envelope carrying `assignmentId`, `orderId`, `threadId`, `ownerHostId`, `targetAgentId`, `targetHostId`, canonical creation/assignment event IDs, and a hash of the recipient-specific payload. The owner persists `order.assigned` before invoking any relay send.

- [ ] Write failing tests proving assignment is journaled before the relay callback runs and the payload identifies the exact owner, recipient, Order, Thread, and body/history hash.
- [ ] Write failing tests proving a malformed, duplicate, or conflicting assignment ID cannot replace an existing assignment record.
- [ ] Run `npx vitest run tests/host-assignment-relay.test.ts tests/store-assignment-inbox.test.ts` and confirm the new assertions fail for the missing behavior.
- [ ] Implement one assignment construction path in `daemon.ts`; commit the canonical assignment before network I/O and pass only that record to local and remote delivery.
- [ ] Ensure relay retry reuses the same assignmentId and payload hash; do not create a second assignment for a transport retry.
- [ ] Run the focused tests and confirm assignment persistence precedes send, duplicates are idempotent, and changed payloads conflict.

## Task 2: Durable recipient inbox and Agent receipt replay

**Files:**
- Modify: `packages/daemon/src/store.ts`
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/protocol/src/peer.ts`
- Modify: `packages/protocol/src/client.ts`
- Test: `tests/store-assignment-inbox.test.ts`
- Create: `tests/assignment-receipt-recovery.test.ts`
- Test: `tests/team-sessions.test.ts`

**Interfaces:**
- Consumes: Task 1 canonical assignment envelope.
- Produces: Recipient inbox API keyed by `assignmentId` with durable states `queued`, `accepted`, `superseded`, and `completed`; duplicate assignment receipt returns the stored receipt and never re-enqueues task injection.

- [ ] Write a failing restart test that persists an assignment and Agent queue receipt, restarts the recipient daemon, replays the receipt, and observes exactly one Agent task injection.
- [ ] Write a failing test that a recipient with no durable queue receipt queries owner assignment status and retries the same ID only while it remains active.
- [ ] Write a failing test that a superseded or closed assignment is never injected after restart.
- [ ] Run `npx vitest run tests/assignment-receipt-recovery.test.ts tests/store-assignment-inbox.test.ts` and confirm failures are limited to the missing durability/replay behavior.
- [ ] Implement durable inbox transitions and idempotent queue acknowledgement. Persist recipient delivery proof only after Agent queue durability is confirmed.
- [ ] Keep the assignment active across transient transport loss; fail closed when status cannot be verified and retain retry state.
- [ ] Run focused restart/retry tests and confirm one injection, one durable receipt, and no stale replay.

## Task 3: Type-specific event authorization and pending replay

**Files:**
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/daemon/src/store.ts`
- Modify: `packages/protocol/src/peer.ts`
- Test: `tests/store-event-auth.test.ts`
- Test: `tests/team-security.test.ts`
- Create: `tests/host-event-auth.test.ts`

**Interfaces:**
- Consumes: Canonical assignment and recipient delivery proof from Tasks 1–2.
- Produces: A single `validateOrStageEvent(envelope, authenticatedPeer)` ingress boundary used by Root ingress, direct peer ingress, and backfill. It returns `applied`, `staged`, or a typed authorization rejection and does not mutate state on rejection.

- [ ] Write failing tests for forged eventHostId, wrong authenticated sender, owner-only lifecycle events from a recipient, self-assignment, non-target replies, and mismatched assignmentId.
- [ ] Write failing tests for out-of-order delivery/reply before creation/assignment, durable pending recovery after daemon restart, and exactly-once application after canonical backfill.
- [ ] Write failing tests for an offline direct link submitting another Host's event in a backfill batch; reject that envelope without applying neighboring unauthorized events.
- [ ] Run the focused tests and confirm each failure demonstrates an authorization or staging gap.
- [ ] Route every `thread/event`, `thread/backfill`, Root relay, and direct-peer event path through the same validator before append/projection/notification.
- [ ] Stage envelopes durably when canonical creation/assignment proof is missing; request proof from the owner and replay only after complete validation.
- [ ] Make event-type authority explicit for owner lifecycle, target-host delivery, and target-Agent ack/heartbeat/reply/decline/report. Serialize target terminal transitions so only one final wins.
- [ ] Run focused tests and confirm unauthorized events have no state side effects, pending events survive restart, and replay applies once.

## Task 4: Owner-attested human clarification

**Files:**
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/daemon/src/store.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `tests/escalate.test.ts`
- Test: `tests/followup-recovery.test.ts`
- Create: `tests/clarification-attestation-recovery.test.ts`

**Interfaces:**
- Consumes: The single authorized event ingress and durable event journal from Task 3.
- Produces: An owner-authored answer event with one-use `parentOwnerAttestation` bound to parent Order/Thread, clarification Order, assigned recipient Agent/Host, answer request ID, and answer-body hash. `parentOwnerVerified` is derived local metadata only.

- [ ] Write failing tests for an answer from a different Host, wrong clarification recipient, altered answer body, changed retry, duplicate retry, and forged `parentOwnerVerified`.
- [ ] Write a failing restart/recovery test proving attestation validity is re-derived from the owner-authored event and cannot be restored from a caller-supplied boolean.
- [ ] Run the focused tests and confirm they fail for missing proof validation or recovery derivation.
- [ ] Implement attestation creation at the Order-owning Host after validating the human owner capability and original Agent delivery proof.
- [ ] Remove trust in `parentOwnerVerified` from every create, ingress, recovery, and linked-parent projection path. Equal retries return the same child Order; changed answers conflict.
- [ ] Run clarification, event-auth, and recovery tests; confirm only validated attestations affect parent status.

## Task 5: Task 4 integration review and documentation

**Files:**
- Modify: `docs/superpowers/plans/2026-11-27-host-and-caller-authorization.md`
- Modify: `docs/handoff/handoff.md`
- Test: focused Task 4 test files from Tasks 1–4

- [ ] Review every event ingress, backfill, dispatch, retry, recovery, and notification call site against the accepted event-authority table in the spec.
- [ ] Run `npm run typecheck` and focused authorization/recovery tests.
- [ ] Run `npm test` and require the complete suite to pass before marking Task 4 complete.
- [ ] Update the original authorization plan checkboxes only for behavior present and tested; record physical second-Host, mixed-version, and external release checks as pending.
- [ ] Record the exact Task 4 completion boundary in `docs/handoff/handoff.md`, without pinning the document's commit hash.

## Next plans

Task 5's remaining remote pinned TLS endpoint selection and Task 6's atomic replacement/operator override transitions remain separate continuation plans. Do not advertise `caller-auth-v1` until its end-to-end contract is implemented and verified. Worker durable reservations, TUI launch binding, safe grant revocation, roster sync/relocation, and Root acknowledgements remain governed by `docs/superpowers/specs/2026-11-27-team-worker-permissions-design.md` and require their own focused execution plan.