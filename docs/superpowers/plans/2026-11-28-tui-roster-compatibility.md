# TUI Roster Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the root-orchestrator TUI layout and preserve terminal identity when ignored TUI access declarations change.

**Architecture:** Let the supervisor apply the same narrow reservation exception during roster publication and bootstrap. Normalize the TUI access slot at the launch-hash boundary.

**Tech Stack:** TypeScript, Node.js, Vitest.

**Spec:** [TUI roster compatibility design](../specs/2026-11-28-tui-roster-compatibility-design.md)

## Global Constraints

- Use scratch daemons and preserve `.cafe` bytes.
- Keep the Pi/OMP production read-only gate and Root roster protocol unchanged.

## Review Focus

- Check member order, canonical aliases, stale terminal reservations, a writer in a nested worktree, and cross-roster overlaps in the supervisor tests.

### Task 1: Directory reservations

**Files:** `packages/daemon/src/supervisor.ts`, `tests/supervisor-team.test.ts`, `tests/team-roster.test.ts`.

- [ ] Add a supervisor test with `orch` at `.`, `dev` at `worktrees/dev`, and `rev` at `worktrees/rev`. Assert successful scope commit in both orders. Check same canonical directory, nested non-front-door members, managed writers, stale reservations, and a second roster still throw on overlap.
- [ ] Add a supervisor-enabled daemon test. Use `team sync`, register TUI clients and start a supported scratch headless worker. Seed saved roster state without the scope file and assert a subsequent boot initializes the supervisor.
- [ ] Run `npm test -- tests/supervisor-team.test.ts tests/team-roster.test.ts` and confirm the allowed layout fails at the old overlap rule.
- [ ] Adjust `prepareRosterWriteScopes(rosterDir: string, team: TeamSpec, current: RosterWriteScope[]): RosterWriteScope[]` so the exception applies only between two current candidates from this roster. Use canonical directory identity and strict containment. Preserve the existing checks against stale scopes and other workers.
- [ ] Run the same test command and confirm all cases pass.

### Task 2: TUI launch identity

**Files:** `packages/protocol/src/cafeFile.ts`, `tests/team-path-auth.test.ts`, `tests/team-roster.test.ts`.

- [ ] Assert that `memberLaunchHash()` produces the same TUI hash with omitted, `read-only`, or `write` access. Extend the daemon test to sync after adding or removing ignored `access`, confirm an existing client remains registered, and reconnect with the startup hash. Keep the existing directory change rejection.
- [ ] Run `npm test -- tests/team-path-auth.test.ts tests/team-roster.test.ts` and confirm the direct hash case catches the regression.
- [ ] In `memberLaunchHash(rosterDir: string, team: TeamSpec, member: TeamMember, memberDir?: string): string`, use `null` for the TUI access slot. Preserve the hash layout and other inputs.
- [ ] Run the tests above, the full isolated `npm test`, `npm run typecheck`, and `git diff --check`. Document test results and pending real-runtime acceptance in the handoff.
