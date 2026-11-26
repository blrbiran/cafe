# Cafe Team Parent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People see progress and conclusions for delegated work and can answer the front door’s clarification in the originating conversation.

**Architecture:** Child Thread logs hold assignment and clarification facts. Parent detail and live updates project them by parent Order. The original human Order’s host owns clarification acceptance and binds answers to that Order and the requesting agent.

**Tech Stack:** TypeScript, SQLite, JSONL, Cafe RPC, HTTP/SSE, React, Vitest.

**Spec:** [Cafe Team Delivery](../specs/2026-11-26-team-delivery-design.md)

## Global Constraints

- Keep at most one active Order per Thread. A waiting human clarification is independent of the Order that published it.
- Keep ordinary routing, the one team front door, and ordinary Order-level stream termination.
- Verify with isolated daemon fixtures. Physical Host and operator publishing are separate.

## Review Focus

- Child progress and outcome must reach a parent hosted on a third daemon and be queryable after a link drops.
- A child from turn one must never change the status of turn two.
- A final report must identify the original responder and remain readable after the original Order closes.
- Clarification authorization must survive restart without relying on display addresses or global credentials.
- Duplicate answers, lost connections, and a namesake requester must not create another delivery.

### Task 1: Deliver linked child activity to the parent conversation

**Files:** `packages/daemon/src/daemon.ts`, `packages/daemon/src/server.ts`, `packages/cli/src/main.ts`, `packages/web/src/pages/Conversation.tsx`, `packages/web/src/store.ts`, `tests/team-sessions.test.ts`.

- [ ] Add integration assertions that a human on a third Host sees the exact child Order change from active to closed, receives its bounded result in the child summary, and can fetch it from the original Host. Assert the parent Order status separately.
- [ ] Run `npx vitest run tests/team-sessions.test.ts` and check that the original Host misses the child activity.
- [ ] Extend Root fan-out with the verified parent Order’s origin Host for linked children. Use the indexed projection for parent detail and a Root lookup for catch-up. Keep child activity separate from direct replies and correlate by `parentOrderId`.
- [ ] Show active child Orders and outcomes by parent turn in the Web UI and CLI. Preserve the Order stream contract. `cafe ask`/`wait` reports pending children if the selected Order closes early.
- [ ] Run team, conversation, CLI, and stream regressions, including later turns and catch-up upon reconnect.

### Task 2: Report results to the original human after early closure

**Files:** `packages/protocol/src/index.ts`, `packages/daemon/src/daemon.ts`, `packages/cli/src/main.ts`, `packages/web/src/pages/Conversation.tsx`, `tests/team-sessions.test.ts`.

- [ ] Assert an interim progress reply leaves the human Order open. Assert a report by an actual recipient after close is persisted on that Order and visible to its subscribers. Assert ordinary follow-up still reports a genuine offline responder.
- [ ] Run `npx vitest run tests/team-sessions.test.ts` and observe the unsupported reporting path.
- [ ] Add an explicit agent-side report action for the exact human Order. Validate persisted target delivery and append a report event without re-routing or reopening the Order. Expose it through the agent tool and print it in both clients.
- [ ] Re-run the integration suite and verify the former and current turns stay independent.

### Task 3: Human clarification

**Files:** `packages/protocol/src/index.ts`, `packages/protocol/src/client.ts`, `packages/daemon/src/daemon.ts`, `packages/daemon/src/server.ts`, `packages/daemon/src/store.ts`, `packages/cli/src/main.ts`, `packages/web/src/api.ts`, `packages/web/src/pages/Conversation.tsx`, `tests/escalate.test.ts`.

- [ ] Add coverage for human clarification creation by the exact recipient, unauthorized or mismatched answer, correct recipient after restart, same-answer retry, different-answer rejection, offline recipient, and legacy offline agent escalation.
- [ ] Run `npx vitest run tests/escalate.test.ts` and verify the human clarification path is missing.
- [ ] Persist a client-held ownership credential digest on the original issuing daemon. For capable, owner-enabled human Orders, register clarification as a linked child and return `decision.needsHuman`. Carry clarification status from the child log. Gate delivery and recognition with a distinct capability.
- [ ] Add an HTTP answer action scoped to the original Thread and clarification ID. Verify the credential, check the exact Order relationship, and append a single follow-up Order on the clarification Thread with an exact target ID and Host. Keep an offline clarification open for human retry. Verify delivery through acknowledgement.
- [ ] Wire ownership and the answer form into Web and CLI, and verify the deterministic human-to-front-door round trip on isolated daemons.

### Task 4: Review, verify, and hand off

- [ ] Get independent TypeScript and code review. Resolve verified regressions.
- [ ] Run typecheck, full test suite, routing evaluation, Web check/build, isolated release smoke, and Claude plugin tests. Verify UI in the running local app where available.
- [x] Record the local implementation and outstanding work in `docs/handoff/handoff.md`.
- [ ] Verify the complete batch and fast-forward `origin main` when the Host identity issue below is resolved.

## Local checkpoint

- The child view, explicit result reports, and owner-bound answers are implemented on the feature branch. The child log holds the result, and the parent view combines the current child summaries with the original Order. `order.reported` records the final summary on the original human Order without using ordinary follow-up routing. This is the proposed acceptance path for #121. The genuine-offline follow-up regression remains.
- Deterministic fixtures cover the human/front-door/worker exchange, the three-daemon child result and pending count, report read-back after both Hosts reconnect, missed clarification publication, and accepted answer recovery without another Order or agent turn. The interrupted-ACK test exercises the same handler across its disconnect, and an interrupted SQLite write verifies recovery from JSONL. A scratch browser session covered posting, answering from the original conversation, and receiving the result report.
- `npm test` passed 724 tests across 128 files, and the focused paging/team pass ran 27 tests. TypeScript, Web check/build, routing evaluation 67/67, packaged smoke 17/17, and Claude plugin tests 6/6 also passed. The first run using a deep project-local `TMPDIR` failed because of socket path length and `.cafe` discovery. Returning to the standard temporary directory and restoring compatibility for old Thread metadata produced the passing full run. Plugin validation retains its pre-existing warnings.
- Two independent design reviews and independent backend and client code reviews ran. The release gate is per-Host authentication. The current implementation verifies a human ownership credential at the issuing Host. A transport peer still presents a shared network token and a declared Host. Independent peer identity and validation of the protected relay events require a separate transport change and deployment decision. Physical multi-Host and mixed-version dogfood also remain open.
