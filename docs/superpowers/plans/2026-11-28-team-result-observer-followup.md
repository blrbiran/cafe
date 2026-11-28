# Team Result and Observer Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the registered front door submit a final team result and let Pi/OMP observers automatically review failures within a fixed turn budget.

**Architecture:** Use the extension's exact active Order to finalize its reply and call the existing result RPC. Extend digests with the optional closed Order ID and let the extension schedule a bounded observation queue.

**Tech Stack:** TypeScript, the Cafe protocol, Vitest.

**Spec:** [Reviewed team result and observer follow-up](../specs/2026-11-28-team-result-observer-followup-design.md).

## Global Constraints

- Only the original recipient can report a human Order's result.
- A failed result confirmation must distinguish it from an already submitted reply.
- A session starts at most one automatic observation turn in a rolling 60-second window.
- Ordinary activity and older digests without Order IDs stay readable.

## Review Focus

- A final reply can land before the report is accepted. The report path must remain retryable.
- Two calls during one active Order must not submit a second final reply.
- A busy observer accumulates failures and runs the observation after explicit work.
- Repeat digests can mention the same Order. They do not consume a new model turn.
- A standalone CLI parent ID without a Thread is provenance only.

### Task 1: Exact active result

**Files:** `packages/pi-extension/src/index.ts`, `packages/protocol/src/index.ts`, `packages/cli/src/main.ts`, `tests/pi-extension.test.ts`, `tests/cli.test.ts`.

- [ ] Add a Pi/OMP tool test that accepts `finalResult: true` for a received human Order, then asserts one final reply and one exact-Order result after run end. Reject duplicate finalization and mismatched arguments.
- [ ] Extend `cafe_reply` with `finalResult?: boolean` and store explicit reply progress in `Working`. Use the existing RPC with the active Order IDs and return the retry information on partial completion.
- [ ] Update role guidance to distinguish the Pi/OMP registered tools from CLI/MCP. Amend CLI help to describe `--parent-thread` for linking. Preserve current API authorization and provenance-only behavior.
- [ ] Run the Pi/OMP extension, CLI, MCP, and team tests.

### Task 2: Observer budget

**Files:** `packages/protocol/src/index.ts`, `packages/daemon/src/daemon.ts`, `packages/pi-extension/src/index.ts`, `tests/pi-extension.test.ts`, `docs/specs/v4-11-agent-teams.md`.

- [ ] Add a fixture with two closed failures while busy. Expect a single wake-up for both at the idle transition and retain the normal-activity display-only test.
- [ ] Populate `ChannelDigest.threads[].orderId?: string` for the latest Order. Enqueue exact failed Orders in the extension, deduplicate, respect idle/explicit work, and schedule a deferred flush after the cooldown. Clear queued work and timers on shutdown.
- [ ] Update the digest contract and run the extension and digest tests.
