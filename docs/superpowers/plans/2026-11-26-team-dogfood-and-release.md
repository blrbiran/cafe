# Team Dogfood and 0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify v4-13 team-session behavior end to end, correct remaining CLI skip wording, and prepare and install a locally validated 0.2.0 release candidate.

**Architecture:** Keep the approved team-session design: one orchestrator front door, explicit member assignment, child Threads, and explicit broadcast. Use scratch daemons and deterministic Baristas for network checks; do not add a task engine or paid model dependency. Package and locally link the release candidate, then restart the user's daemon as authorized.

**Tech Stack:** TypeScript, Node 22, npm workspaces, Vitest, existing CafeClient/Daemon helpers, Vite/Web UI.

**Spec:** `docs/specs/v4-14-team-dogfood.md`; protocol semantics: `docs/specs/v4-13-team-sessions.md`.

## Global Constraints

- A `.cafe` team has exactly one `duty: orchestrator`.
- `to: <team>` and a fresh team-channel message without `to:` reach only the orchestrator; reaching everyone requires explicit `broadcast: true`.
- Follow-ups target the previous turn's final responders, then its targets, then fail `responders_offline`; never fall back to rules/LLM.
- A daemon without `team-sessions` hard-rejects channel, escalation, collect-all, team identity, and team target before creating an Order.
- Root publishes complete digests while online; a child publishes partial digests only while Root is offline.
- Use scratch `CAFE_HOME` for synthetic agents. Do not run paid model calls or edit the external issue ledger.
- Do not publish to npm; prepare the package and leave publication to the operator.

## Review Focus

- A deadline skip and a grace-window skip have different reason strings; CLI must not call either a decline. Pin both cases in `tests/cli.test.ts`.
- A roster update forwarded across Root and child Daemons must reach each local member once without creating an Order. Pin in `tests/team-sessions.test.ts`.
- An unchanged roster sync must not bump revision or send a note. Keep covered by the content-hash assertion in `tests/team-sessions.test.ts`.
- A Root/child digest handover must not publish duplicate full digests or replay stale activity. Run the Root/child cases in `tests/observer-digest.test.ts`.
- An old daemon must reject team features before Order creation. Run the capability matrix in `tests/capabilities.test.ts` and `tests/cli.test.ts`.

---

### Task 1: CLI skip event wording

**Files:**
- Modify: `packages/cli/src/main.ts` (`describe`, `order.declined` case)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes `ThreadEnvelope.event.skipped` and its existing `reason` string.
- Produces a clear history/live message: deadline → “did not respond before the deadline”; grace skip → “was skipped: another Barista answered first”; ordinary decline keeps its current wording.

- [x] Add a CLI regression test for both `reason: "deadline"` and `reason: "skipped: another Barista answered first"`; assert neither is rendered as `declined`.
- [x] Run `node_modules/.bin/vitest run tests/cli.test.ts -t 'formats skipped reason'` and confirm the tests fail against the old formatter.
- [x] Implement the minimal `e.skipped` formatting branch in `packages/cli/src/main.ts`.
- [x] Re-run the focused CLI test and the full `tests/cli.test.ts` file.

### Task 2: Cross-daemon team roster delivery

**Files:**
- Modify: `tests/team-sessions.test.ts`

**Interfaces:**
- Use `startDaemon`, `barista`, `identity`, `waitFor`, and `CafeClient.onRoster` from `tests/helpers.ts` and the protocol client.
- Exercise Root → child roster propagation using real daemon links and deterministic in-process Baristas.

- [x] Add a Root plus team-host child scenario. Publish the authoritative roster from the child, then update it and connect a remote Customer through the Root.
- [x] Assert the Root converges on the child's new roster revision and the child member receives exactly one `team/roster` update.
- [x] Assert the remote Customer's `to: <team>` Order is routed through the Root to the child orchestrator; the roster note creates no Order/Thread event and starts no extra turn.
- [x] Run the new test alone, then run `node_modules/.bin/vitest run tests/team-sessions.test.ts tests/team-roster.test.ts` (15 passed).

### Task 3: Full verification and package candidate

**Files:**
- Modify: `package.json` and `package-lock.json` only for the 0.2.0 version bump.
- Generated: `release/` (ignored build output; do not commit it).

- [x] Run `npm run typecheck` and the full `npm test` suite; final verification passed with 693 tests after fixing the optional revision assertion in the new integration test (the initial typecheck caught it).
- [x] Run `npm run routing:eval` and `npm run check --workspace @cafe/web && npm run build:web` (67/67 routing; 56 Web modules built).
- [x] Bump the root package from `0.1.5` to `0.2.0`; keep the workspace CLI package's independent version unchanged.
- [x] Run `npm run release:build` and `npm run test:release`; the packed CLI reports `0.2.0`, health reports the version, and the release bundle contains `team-sessions`.
- [x] Run `npm run test:claude-plugin` (5 passed; validator emitted two TypeScript environment warnings and an icon warning).

### Task 4: Scratch team dogfood and browser inspection

**Files:**
- No persistent product files; scratch data stays under a new temporary directory.

- [x] Start isolated Root/child Daemons with non-default ports and plaintext scratch configs; do not connect synthetic agents to the user's real `~/.cafe` (scratch Root plus Root/child integration test).
- [x] Run the scenario table in `docs/specs/v4-14-team-dogfood.md` with deterministic Baristas; capture targets, turn counts, response timing, and roster/digest observations (front-door, assignment, broadcast/collect-all run in scratch; follow-up and roster paths covered by integration tests).
- [x] Start the Web UI against the scratch scenario and inspect the Feed channel, team front-door target, parent/child navigation, per-target status, and skipped wording in a real browser.
- [x] Exercise Root-online and Root-offline digest handover with local Root/child daemons; no second physical Host was available, so physical-host validation remains a follow-up.
- [x] Stop the scratch daemon after browser inspection; the in-process Baristas exited after seeding.

### Task 5: Local install, daemon restart, and handoff

**Files:**
- Modify: `docs/handoff/handoff.md`
- Add: `docs/superpowers/plans/2026-11-26-team-dogfood-and-release.md`

- [x] Verify the existing global `cafe` link points to this workspace's `packages/cli`; after the root version bump, `cafe --version` reports `0.2.0`.
- [x] Run `cafe daemon restart`, then `cafe daemon status` and `cafe doctor`; the live Root reports `0.2.0`, advertises all 6 features including `team-sessions`, and health checks pass.
- [x] Update handoff §5/§8 with completed checks, remaining physical-host/browser/model limits, the external issue-ledger status, and the exact operator action still required for npm publication. Do not write a hard-coded HEAD value.
- [ ] Review `git diff --check`, status, and diff summary; commit on the feature branch, merge into `main`, and push `origin main` as authorized.
