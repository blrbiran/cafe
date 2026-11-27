# Conversation Follow-up Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a prior answer in the conversation view when the latest follow-up never found a recipient.

**Architecture:** Store a bounded conversation projection alongside current-Order metadata. Project from journal append order and reuse the same display rules in Feed and search.

**Tech Stack:** TypeScript, SQLite, JSONL, React, Vitest.

**Spec:** [Conversation follow-up outcomes](../specs/2026-11-27-conversation-followup-outcomes-design.md)

## Global Constraints

- Preserve latest-Order status, replies, target states, routing semantics, and digest counts.
- Preview cap is 300 UTF-16 code units. Preserve source attribution and avoid a split surrogate pair.
- List and indexed search do not read journals for the projection.

## Review Focus

- Same-timestamp or replayed late finals are audit-only.
- An absent route and a routed timeout differ from an explicit empty route.
- Crash between append and metadata write leaves a replayable tail.
- Missing journal retries allow recovery of other conversations.
- An operator's answer retains its label when the target goes offline.

## Task 1. Journal projection and recovery

**Files:** `packages/protocol/src/index.ts`, `packages/daemon/src/daemon.ts`, `packages/daemon/src/store.ts`, new `packages/daemon/src/followup-outcome.ts`, new `tests/followup-outcome.test.ts`.

**Interface:** Optional `ThreadMeta.followupOutcome` contains `orderId` for the failed follow-up and `answer` with `orderId`, `turn`, `agentId`, `address?`, `source?`, `text` and `truncated`.

- [ ] Write failing tests for a pre-close final on turn 1 and an explicit empty route with failed close on turn 2. Assert historical answer ID equals the first Order ID, latest status is failed and latest replies are empty. Cover greatest eligible prior turn, highest append position in that turn, replayed late final at the same timestamp, absent route, timeout with targets and text truncation.
- [ ] Run `npm test -- tests/followup-outcome.test.ts` and confirm RED.
- [ ] Implement projection by ordered per-Order events. Attach public `followupOutcome` only for the exact failed follow-up. Retain the last successful answer internally for subsequent turns.
- [ ] Write failing tests for restart with only journal append persisted, missing journal and bounded recovery across restarts. Persist progress and projection together. Retry unavailable journals without blocking other conversations. Re-read latest metadata and merge only derived fields.
- [ ] Run focused tests for follow-up outcomes, search, recovery and `npm run typecheck`.

## Task 2. Feed and search display

**Files:** `packages/web/src/outcome.ts`, `packages/web/src/pages/Feed.tsx`, `packages/web/src/i18n.ts`, new `tests/web-followup-outcome.test.ts`.

- [ ] Test Answered filter and `Answered · Follow-up not delivered` / `已回答 · 追问未送达` for matching historical outcome. Cover operator labels, active task precedence, stale projections and preview on a question-only search match.
- [ ] Run `npm test -- tests/web-followup-outcome.test.ts` and confirm RED.
- [ ] Share badge and historical preview interpretation between Feed and search. Display a truncation ellipsis, suppress duration and avoid duplicate search previews for the same answer Order. Keep detail's per-turn outcomes.
- [ ] Run focused tests, Web check and build, then isolated full suite. Review diff and checkpoint when authorized. Pushing requires all session plans to be complete.
