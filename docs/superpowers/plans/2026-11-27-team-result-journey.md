# Team Result Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the person who asked a team see clarification, progress and the final report in the original conversation.

**Architecture:** Keep exact parent-Order linking and current authorization. Project linked accepted continuations into the parent and describe each runtime's real entry points.

**Tech Stack:** TypeScript, React, Vitest, Cafe protocol.

**Spec:** [Team result journey](../specs/2026-11-27-team-result-journey-design.md)

## Global Constraints

- Exact Order/Thread identifiers convey no caller authority.
- Existing human-owner links, report authorization and absolute deadlines remain in force.
- Cross-process receipt continuity requires Host and Caller Authorization Task 4.

## Review Focus

- A shell subprocess has no implicit Agent identity.
- A turn-one clarification is not a completed continuation.
- Partial views, current parent cancellation and previous-turn reports cannot produce a false done.
- Receipt is not proof of work started.
- Restart before first report differs from retry after a committed report.

## Task 1. Runtime-specific instructions and CLI receipt

- [ ] Test that the `cafe serve` prompt does not suggest using shell CLI/MCP tools as its registered Barista. Point the runtime to its existing response mechanism. Test the receipt output says `received` for `order.acked`.
- [ ] Run the focused tests and observe RED. Update `packages/cli/src/serve.ts` and `packages/cli/src/main.ts` copy. Preserve the existing human-owner link, unlinked provenance and operator paths.
- [ ] Exercise the human-owner linking and Pi/OMP `delegate: true` regressions.

## Task 2. Clarification continuation in the parent

- [ ] Add exact-parent projection tests in `tests/web-task-status.test.ts` and a scratch integration in `tests/escalate.test.ts`. Turn one preserves the pending question. An authorized, active continuation is working, a completed continuation with a successful unreported parent is awaiting report, and a valid report finishes that parent. Include partial, older parent, and terminal failed/cancelled cases.
- [ ] Observe RED. Extend `projectTaskStatus` in `packages/protocol/src/index.ts`, then wire the existing daemon projection and ensure the parent view links to the child continuation in `packages/web/src/pages/Conversation.tsx`.
- [ ] Verify same-process reconnect and identical report retry. Verify a different Agent with the same name cannot report. Run the scratch full suite, type and Web checks.

## Task 3. Verify durable report continuity

- [ ] After Host and Caller Authorization Task 4, test restart before first report, retry after committed report, and rejection by a distinct Agent for both.
- [ ] Run supported Pi or OMP smoke and enrolled cross-Host acceptance using separate scratch Hosts first. Verify the final result via the original conversation.
