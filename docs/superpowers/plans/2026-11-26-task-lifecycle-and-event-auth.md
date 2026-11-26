# Task Lifecycle and Event Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long-running and delegated tasks report truthful task status, recover after restart, and accept state-changing events only from authorized recipients.

**Architecture:** Preserve per-Order terminal status and derive a separate task status from exact parent-Order children and reports. Keep hard deadlines absolute but make the default unicast bound two hours; use ack/heartbeat leases for inactivity. Validate agent events against persisted delivery evidence, page all open records during recovery, and report one slot for serial execution. The TLS/shared-token Host identity migration remains a release gate outside this implementation batch.

**Tech Stack:** TypeScript, Zod, SQLite, JSONL, Cafe RPC/HTTP/SSE, React, Vitest.

**Spec:** [Task Lifecycle and Event Authorization](../specs/2026-11-26-task-lifecycle-and-event-auth-design.md)

## Global Constraints

- Preserve ordinary Order-level close semantics and the direct-reply count.
- Default unicast hard lifetime is 7,200,000 ms; `deadlineMs` is an absolute per-Order hard cap.
- Reject `deadlineMs` outside integer range 1–2,147,483,647 with `bad_request`.
- `--wait-timeout` is local-only; legacy `--timeout` and Ctrl-C continue to cancel.
- Parent task status is correlated to the immutable parent Order recorded for the child Thread.
- A human-owned link requires the original human Order-owner credential; agent delegation requires registered peer identity and exact delivery proof.
- A serial Cafe session advertises one slot. Do not create isolated worktrees in this batch.
- No production Root restart, npm publish, external-ledger edit, or physical second-Host claim.

## Review Focus

- A healthy heartbeat beyond ten minutes must not cause a default unicast failure; the hard cap must still close a worker that heartbeats forever. (Task 1)
- Orders beyond the first 1,000 open Threads must recover with their original Order IDs and due times. (Task 2)
- A prior Order's late reply must not clear a newer active Order or reopen a closed Order. (Task 5)
- A linked child from a previous parent turn or an unauthorized follow-up must not change current `taskStatus`. (Task 4/5)
- A partial cross-Host child view must not tell the person the task is done. (Task 4)

---

### Task 1: Separate hard deadline from local wait

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `tests/unicast-deadline.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- `CreateOrderParams.deadlineMs`: positive integer bounded by `2_147_483_647`.
- `Timing.unicastDeadlineMs`: default `7_200_000`.
- `cafe ask --wait-timeout <seconds>` stops the CLI stream only and returns accepted/working status; existing `--timeout` keeps cancel-on-timeout.

- [x] Add a regression assertion that the daemon's default unicast hard lifetime is exactly `7_200_000` ms, plus a target that heartbeats and finishes within that default without failure.
- [x] Add a test that a target that stops heartbeating still fails by the heartbeat lease before the hard cap.
- [x] Add parameterized API/RPC tests rejecting `deadlineMs` values `0`, `-1`, `1.5`, and `2_147_483_648` with `bad_request`; preserve the valid explicit short-deadline test.
- [x] Add a CLI test for `--wait-timeout` showing the output says the Order is still running and the cancel endpoint was not called; retain tests for legacy `--timeout` and Ctrl-C cancellation.
- [x] Implement schema validation, set the default unicast hard lifetime to two hours, and add the `--wait-timeout` branch without changing the existing `--timeout` branch.
- [x] Run `npx vitest run tests/unicast-deadline.test.ts tests/cli.test.ts` and confirm all pass.

### Task 2: Recover every open Order

**Files:**
- Modify: `packages/daemon/src/store.ts`
- Modify: `packages/daemon/src/daemon.ts`
- Test: `tests/followup-recovery.test.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Add `Store.openThreadsPage(limit: number, after?: { createdAt: number; threadId: string }): ThreadMeta[]` with ascending keyset order `(createdAt, threadId)`.
- Keep `Store.openThreads(limit?)` for existing callers; recovery uses the new page method.

- [x] Add a Store test proving stable keyset pagination across equal `createdAt` values with no duplicates or omissions.
- [x] Add a recovery test with more than 1,000 persisted open Threads and assert an Order beyond the first page is recovered and completes under the same Order ID.
- [x] Implement the indexed keyset query and loop through pages in `Daemon.recover()` until empty.
- [x] Preserve current clarification repair, latest-Order reconstruction, and absolute remaining deadline behavior for every page.
- [x] Run `npx vitest run tests/store.test.ts tests/followup-recovery.test.ts --attachmentsDir .superpowers/sdd/2026-11-26-task-lifecycle-and-event-auth/attachments` and confirm all pass.

### Task 3: Make serial capacity truthful

**Files:**
- Modify: `packages/daemon/src/supervisor.ts`
- Modify: `packages/cli/src/bridge/barista.ts`
- Modify: `packages/pi-extension/src/index.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `tests/supervisor.test.ts`
- Test: `tests/bridge.test.ts`
- Test: `tests/pi-extension.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Each serial Cafe session registers with `concurrency: 1`.
- `Supervisor.start()` starts one worker for one logical identity and logs a diagnostic when `.cafe` requests `concurrency > 1`; distinct team roster members retain current behavior.

- [x] Add tests showing a `.cafe` with `concurrency: 3` does not spawn duplicate same-directory/same-identity workers and reports the one-slot diagnostic.
- [x] Add registration tests showing bridge and Pi extension advertise one concurrent slot despite a larger `.cafe` value.
- [x] Implement the one-worker supervisor rule and registration override.
- [x] Add an assertion that a normal one-slot start has no unnecessary warning.
- [x] Run `npx vitest run tests/supervisor.test.ts tests/bridge.test.ts tests/pi-extension.test.ts tests/cli.test.ts --attachmentsDir .superpowers/sdd/2026-11-26-task-lifecycle-and-event-auth/attachments` and confirm all pass.

### Task 4: Project parent task status

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/daemon/src/server.ts`
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/web/src/pages/Conversation.tsx`
- Modify: `packages/web/src/pages/Feed.tsx`
- Modify: `packages/web/src/outcome.ts`
- Modify: `packages/web/src/i18n.ts`
- Modify: `packages/web/src/ui/bits.tsx`
- Create: `packages/web/src/ui/tone.ts`
- Test: `tests/web-task-status.test.ts`
- Test: `tests/team-sessions.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Extend `ThreadMeta` with optional `reportedOrderId` and `taskStatus: "working" | "awaiting_report" | "done" | "failed" | "cancelled" | "unknown"`.
- Add shared `projectTaskStatus(parent: ThreadMeta, children: ThreadMeta[], partial?: boolean): TaskStatus | undefined`; it uses only children matching exact parent Thread and Order IDs.
- Add `Daemon.projectTaskMeta(meta, includeRemote = true)` for detail and `Daemon.projectTaskMetas(metas)` for lists. Root projects from local child storage; a non-root uses one `thread/task-statuses` batch RPC when supported and otherwise marks only locally evidenced linked work partial.
- Persist `reportedOrderId` from `order.reported`; do not persist the derived `taskStatus` or increment direct reply counts.

- [x] Add daemon/API tests for exact parent Order correlation, clarification exclusion, each status precedence, owner-created child closure, agent-parent fallback, and partial-view `unknown`.
- [x] Add CLI coverage for `cafe wait` after parent close with `awaiting_report`, existing `cafe ask` pending-child behavior, and `cafe thread <id> --children` results.
- [x] Add Web outcome and locale assertions for working, awaiting report, and incomplete list views; verify Feed and Conversation compile with the shared status type.
- [x] Implement the persisted report marker and shared status helper, then annotate parent detail/list/snapshot payloads with bounded projections.
- [x] Render the projection in CLI and Web while keeping current direct Order status available.
- [x] Run `npx vitest run tests/team-sessions.test.ts tests/cli.test.ts tests/web-task-status.test.ts --attachmentsDir .superpowers/sdd/2026-11-26-task-lifecycle-and-event-auth/attachments`, `npm run typecheck`, `npm run check --workspace @cafe/web`, and `npm run build:web`.

### Task 5: Authenticate Order events and linked-parent changes

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/daemon/src/server.ts`
- Modify: `packages/web/src/pages/Conversation.tsx`
- Modify: `packages/web/src/pages/Live.tsx`
- Modify: `packages/web/src/outcome.ts`
- Modify: `packages/web/src/i18n.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/mcp.ts`
- Test: `tests/team-security.test.ts`
- Test: `tests/team-sessions.test.ts`
- Test: `tests/reply-entry.test.ts`
- Test: `tests/mcp.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Add optional `AgentRecord.activeOrderId` paired with `activeThreadId`.
- Add a delivery-proof validator using the exact `orderId`, `threadId`, `agentId`, and source Host from a persisted `order.delivered` event.
- Extend human-owned order creation so CLI can attach its existing owner key to a child Order; MCP keeps current `origin: "agent"` and receives no HTTP owner bypass.
- Mark HTTP `replyAs` output as an operator override in the event/UI instead of attributing it as an authenticated Barista event.

- [x] Add protocol tests that a delivered target can act, while a registered non-target, mismatched Thread, or mismatched parent target is rejected without changing metadata or active markers.
- [x] Add late-event tests: a valid final reply may recover a failed target while its Order is still open; after close, only final reply is retained as audit data and no event reopens the Order or clears a newer `activeOrderId`; late ack/heartbeat/decline are ignored.
- [x] Add parent-link tests for missing parent, mismatched parent Thread, lone valid provenance ID, actual delivered agent linkage, owner-key human linkage, changed follow-up link, and unauthorized follow-up.
- [x] Add MCP coverage that a request cannot create an agent-linked child over HTTP without a registered Barista identity; preserve normal `origin: "agent"` attribution for existing MCP asks.
- [x] Add tests that HTTP replyAs is visibly an operator override and cannot be mistaken for agent-authored evidence.
- [x] Implement validation before `recordEvent()` and before active-marker mutation. Keep human clarification ACK retry behavior unchanged.
- [x] Enforce one immutable parent link per child Thread. Follow-ups inherit it only for the authenticated creator, a previous delivered target, or the parent human owner.
- [x] Preserve the local-operator limitation in API and UI wording; do not claim cryptographic Host identity from delivery evidence.
- [x] Run `npx vitest run tests/team-security.test.ts tests/team-sessions.test.ts tests/reply-entry.test.ts tests/mcp.test.ts tests/cli.test.ts --attachmentsDir .superpowers/sdd/2026-11-26-task-lifecycle-and-event-auth/attachments` and confirm all pass.

### Task 6: Review, verify, hand off, and push

**Files:**
- Update: `docs/handoff/handoff.md`
- Update: this plan's checkboxes
- Review: all source changes in Tasks 1–5

- [ ] Run `npm run typecheck`.
- [ ] Run the complete `npm test` suite and routing evaluation.
- [ ] Run Web typecheck/build and packaged release smoke tests.
- [ ] Run the required independent TypeScript and React reviews; fix verified findings and rerun affected checks.
- [ ] Update handoff §5 with completed work, test results, the remaining Host-auth/release blockers, and operational actions still reserved for the operator.
- [ ] Inspect the full diff, stage only this batch's files, and create a commit whose message ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- [ ] Fetch/recheck `origin/main` ancestry and perform a non-force fast-forward push of the branch head to `origin main` only if remote main remains an ancestor.
- [ ] Confirm the final local/remote status and provide the <=10-line executive handoff summary directly in the final response.
