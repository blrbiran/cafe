# Cafe Team Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cafe team work predictable from startup through dispatch and user-visible results.

**Architecture:** Validate local roster input before publishing or spawning. Keep one team front door and scope explicit deliveries using the authoritative roster. Keep independent tasks in child Threads.

**Tech Stack:** TypeScript, Zod, SQLite, Vitest, Cafe RPC, pi/omp extension.

**Spec:** [Cafe team delivery](../specs/2026-11-26-team-delivery-design.md)

## Delivery status

The runnable batch covers roster ownership, runner validation, team routing, pi/omp delegation and broadcasts, passive digests, reply collection, and bounded prompt context. CLI setup instructions and linked task results are available through `cafe team start` and `cafe thread --children`. Issue #179 has a separate store regression for append after a partial record.

The human clarification and live result paths remain open. The [clickable preview](../specs/2026-11-26-team-clarification-preview.html) is ready for UI review. For the next implementation, distinguish the authenticated recipient of a clarification from a network-wide display name. Bind an answer to the clarification and the original requester, then deliver it only to the requesting agent. Model pending child work separately from `order.closed` so existing wait clients can retain their Order-level contract. Both paths need a restart and cross-host scenario before release.

## Global Constraints

- Every Thread has at most one active Order. One broadcast has multiple targets.
- Keep ordinary channel and follow-up compatibility where there is no team scope.
- Use isolated fixtures for verification. Keep npm publishing with the operator.

## Review Focus

- An unsupported runner in an unselected member must fail at roster parsing.
- A saved worker passes the same validation when restored.
- A worktree copy must neither edit the roster by registration nor take ownership by explicit publication.
- An identical sync after claiming a legacy roster preserves revision and notification idempotence.
- A shared channel broadcast without a sender team returns an ambiguous-channel error.

### Startup and roster ownership

- [ ] Add rejection and compatibility assertions in `tests/cafe-file.test.ts`, `tests/team-roster.test.ts`, and `tests/supervisor.test.ts`. Verify no workers start for an invalid team spec. Verify a registered worktree copy leaves the authoritative members and revision intact and its explicit publish throws. Verify the owner can sync changes.
- [ ] Run the three files and observe the new assertions fail.
- [ ] Add `validateTeamRunners(team: TeamSpec): void` to `packages/protocol/src/cafeFile.ts`. Call it when reading `.cafe`, publishing a roster, and entering `Supervisor.startTeam`. Keep wire fields compatible. Resolve built-in names in `startTeam`, with pi using locally configured `piBin`.
- [ ] In `packages/daemon/src/daemon.ts`, store local canonical publisher directories by `rosterKey` in persistent KV. `learnTeam` only learns loose membership. `publishRoster` accepts publication from the canonical owner, including first explicit claim of legacy records. Map API validation errors to `bad_request`.
- [ ] Run the three files and all `team-*` tests. Confirm the source directory stays local and removed records retain their owner.

### Deterministic team delivery

- [ ] Extend `tests/team-sessions.test.ts` to assert explicit team and member channel inheritance, no front-door self-dispatch, loose front-door rejection, and zero cross-team duty or broadcast deliveries in a shared channel.
- [ ] Run the new cases and observe the current routing failures.
- [ ] In `Daemon`, resolve team scope by `(host, team, channel)` from a registered sender in that channel or the sole authoritative channel owner. Restrict duty and broadcast to the selected team. Reject ambiguous unscoped broadcasts. Share front-door validation between fresh channel orders and team addresses. Persist the channel of a resolved explicit team target before `order.created`.
- [ ] Run the team, channel, and collection suites. Confirm the default channel retains its existing behavior.

### pi/omp parity and notification cost

- [ ] Extend `tests/pi-extension.test.ts` to assert explicit `broadcast` reaches all eligible recipients, a requested delegation uses the current Order as parent, and a digest queues no model turn.
- [ ] Run the new cases and observe failures.
- [ ] Update `packages/pi-extension/src/index.ts` to forward `broadcast`, provide an explicit `delegate` switch when processing an incoming Order, and deliver display-only digest notifications. Apply equivalent passive digest behavior to the Claude session host. Align playbook guidance with the available entry points.
- [ ] Run extension, session-host, and digest tests.

### Clarification and task lifecycle

- [ ] Add a deterministic human-to-front-door-to-worker round-trip fixture with a human clarification, an early progress report, and a child terminal outcome.
- [ ] Define persisted clarification identifiers and the authenticated human reply path before publishing or forwarding an answer. Keep parent Order closure and the visible pending child-task count independent. Add a bounded parent-context projection to sub-Orders. Preserve explicit routing and the legacy plain Thread behavior.
- [ ] Verify restart, late results, and answer routing. Prototype the user-visible changes for review before changing Web UI.

### Final verification and handoff

- [ ] Run `npm run typecheck`, `npm test`, `npm run routing:eval`, Web check/build, release smoke and plugin tests. Run independent TypeScript review and resolve verified findings.
- [ ] Update `docs/handoff/handoff.md` with completed changes, verification and open work. Show the diff before committing. Push the verified branch to `origin main` by fast-forward as authorized.
