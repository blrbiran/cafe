# Private Assignment Payload Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Keep the new relay capabilities reserved until the complete Host Auth Task 4 release boundary is verified.

**Goal:** Remove recipient-specific payloads from the shared journal while preserving exact owner retries.

**Architecture:** Store the immutable recipient Order in owner-local SQLite. The public event publishes an assignment reference and its digest. Relay still carries an Order to its exact recipient and needs its own authority and receipt work before release.

**Tech Stack:** TypeScript, Zod, SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-28-assignment-privacy-and-authority-design.md`, independently reviewed before this plan.

## Global Constraints

- Shared journal entries omit recipient body, history, and route variants.
- Retried owner assignments reuse the original immutable payload.
- An uncommitted private row cannot authorize delivery.
- Keep legacy events readable and reject them as secure assignment proof.

## Review Focus

- If receipt is lost after append, reuse the public event ID and private payload.
- If a private record is missing or conflicts, report delivery failure without inventing a payload.
- Shared backfill, SSE, and linked detail must see the same public events.
- Legacy replacement events lack the new assignment-reference shape.
- Restart and mixed versions still need end-to-end validation before release.

## Task 1: Public references and private payloads

**Files:** `packages/protocol/src/index.ts`, `packages/daemon/src/store.ts`, `packages/daemon/src/daemon.ts`, `tests/host-assignment-relay.test.ts` and existing per-target tests.

- [ ] Add a failing assertion that the journal assignment has no body/history while the exact recipient receives the issued body and history.
- [ ] Define `OrderAssignmentReference` with exact IDs and a SHA-256 digest. Keep the existing inbox payload separate from the public event type.
- [ ] Persist an owner-local payload before append. Store only a public reference in the event. On owner retry and recovery, read the immutable payload back by assignment ID, verify the digest and fail closed when evidence is incomplete.
- [ ] Save private routing variants separately and publish a route without `variants`. Update linked detail and journal readers to consume public envelopes, including older records.
- [ ] Run focused projection, history, assignment, and recovery tests then the complete suite.

## Task 2: Release the secure relay as one contract

Implement the durable receipt, common live/backfill/recovery authority check, capability gates, immutable owner routing on reconnect, and owner-attested clarification steps from `2026-11-28-host-auth-task4-gap-closure.md`. Cover Root and direct delivery, supported legacy behavior and mixed-version failures before enabling either capability. Compatibility and closure for replacement assignments travel with Host Auth Task 6.
