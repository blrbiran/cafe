# Team Worker Permissions and Directories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ensure every Cafe-managed headless worker has truthful file access, every roster path is locally authorized, overlapping writers are rejected, and roster sync cannot resurrect stale access.

**Architecture:** Use the last locally committed roster as the permission source. Resolve every member path through `realpath`; require a host-local, member-specific grant for paths outside the roster root. Apply explicit read-only tool allowlists to supported Pi/OMP binaries and preserve existing Codex/Claude sandboxes. Persist roster-root ownership, write reservations, TUI stale reservations, and reconciliation intent before changing processes or publishing roster updates.

**Tech Stack:** TypeScript, Node `fs`/`path`, Commander, Pi/OMP RPC, Supervisor process groups, SQLite/JSON state, Root roster RPC, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-team-worker-permissions-design.md`

## Global Constraints

- Headless Cafe-managed workers default to `read-only`; writing requires `--write` or roster `access: write`.
- Roster TUI members cannot claim Cafe-enforced access; their permissions are `managed by host`.
- Pi read-only tools: `read,grep,find,ls` plus Cafe tools; disable auto extensions and MCP.
- OMP read-only tools: `read,grep,glob` plus Cafe tools; unsupported binary hashes fail closed if the no-model isolation probe fails.
- Roster `dir` is relative; external realpaths require a local per-roster/member grant that includes device/inode and grantId.
- Write scopes from configured members reserve directories even when stopped or offline; stale TUI reservations remain until explicit release by reservationId.
- `team sync` stops/restarts only existing desired workers, does not start new members, and never publishes if a required stop is unconfirmed.
- `team relocate` is one durable local ownership transition; recovery cannot restore source-root workers after relocation intent is committed.
- Root roster publication is compare-and-swap, durable before ack, idempotent on same revision/hash, and conflict-safe across multiple offline local syncs.

## Review Focus

- A symlink/path replaced after a grant must fail its stored canonical-path/device/inode match and stop the active worker.
- A path grant revoked while another member's roster entry is invalid must still stop the revoked member; unchanged members retain their state.
- A process group whose leader exited but descendants remain must keep its write scope reserved across daemon restart.
- A same-version Pi/OMP binary replaced on disk must trigger a new read-only isolation probe by binary hash.
- A `.cafe` edited but not committed with `team sync` must not change an already running TUI's memberLaunchHash or the daemon's active write reservations.

---

## File map

- `packages/protocol/src/cafeFile.ts`, `protocol/src/index.ts` — validate TUI access declarations, canonical member access inputs, memberLaunchHash shape, and roster identity fields.
- `packages/daemon/src/config.ts`, `store.ts` — mode-0600 local path grants, committed roster snapshots, relocation intents, stale TUI reservations, process-group quarantine, and Root publication state.
- `packages/daemon/src/supervisor.ts` — effective access, safe argv, preflight, worker start intent, whole-group stop/recovery, and overlap reservation checks.
- `packages/daemon/src/daemon.ts`, `server.ts` — path validation, TUI launch-hash registration, team sync/relocate APIs, roster revision compare-and-swap, and Root acknowledgment.
- `packages/cli/src/main.ts`, `cli/src/bridge/barista.ts` — `team trust-path`, `paths`, `revoke-path`, `release-tui`, `relocate`, and truthful access/TUI status/help.
- `packages/pi-extension/src/index.ts` — capture memberLaunchHash once at startup, persist assignment/identity context as needed, and retain it across reconnects.
- `scripts/readonly-runtime-probe.mjs` or focused test fixture — isolated no-model tool allowlist and fake MCP side-effect probe keyed by executable hash.
- Tests: new `tests/team-path-auth.test.ts`, `tests/team-worker-permissions.test.ts`, `tests/team-sync-recovery.test.ts`, plus existing `tests/team-roster.test.ts`, `tests/team-sessions.test.ts`, `tests/supervisor.test.ts`, and CLI tests.

## Task 1: Path-grant store and safe roster resolution

**Files:** `packages/daemon/src/config.ts`, new focused helper `packages/daemon/src/team-paths.ts`, `packages/protocol/src/cafeFile.ts`, `packages/protocol/src/index.ts`, `tests/team-path-auth.test.ts`

**Interfaces:**
- `resolveMemberPath(rosterRoot: string, memberDir: string) -> { rosterRoot, realPath, dev, ino, insideRoot }` resolves existing directories and rejects unsafe input.
- `trustMemberPath(home, rosterRoot, team, member, memberDir) -> { grantId, realPath }` grants only the member's currently declared target after explicit operator confirmation.
- `revokeMemberPath(home, grantId) -> RevokedPathGrant` durably marks revoked before process termination.
- `readPathGrants(home)` returns grants by grantId, including active, stale, and revoked-pending state.
- `effectiveMemberAccess(member, mode) -> read-only|write|host-managed` maps omitted headless access to read-only and refuses a TUI access field.

- [ ] Add RED tests for traversal, absolute paths, NUL, symlink escape, internal symlink, missing directory, device/inode mismatch after recreation, multiple grants per member, grantId revocation when path is gone, and exact roster/member binding.
- [ ] Add RED tests for invalid TUI `access`, omitted headless access resolving to read-only, and TUI returning `host-managed`.
- [ ] Run `npx vitest run tests/team-path-auth.test.ts` and confirm expected failures.
- [ ] Implement `team-paths.ts` with atomic mode-0600 grant file writes; key grants by canonical roster root/member/realpath/device/inode, and persist grantId/state.
- [ ] Update `cafeFile.ts` to validate relative member paths and prohibit `access` on roster TUI entries without preventing `..` paths that later match a local grant.
- [ ] Run the focused test file and `npm run typecheck`; confirm pass.
- [ ] Review `git diff --check`, stage only Task 1 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 2: Pi/OMP read-only execution

**Files:** `packages/daemon/src/supervisor.ts`, `packages/cli/src/main.ts`, `scripts/readonly-runtime-probe.mjs`, `packages/pi-extension/src/index.ts`, `tests/team-worker-permissions.test.ts`, `tests/supervisor.test.ts`

**Interfaces:**
- `readonlyToolArgs(agent: "pi"|"omp", cafeExtension: string) -> string[]` returns Pi `['--tools', 'read,grep,find,ls,cafe_ask,cafe_agents,cafe_reply,cafe_decline', '--no-mcp', '--no-extensions', '-e', cafeExtension]`; OMP returns `['--tools', 'read,grep,glob,cafe_ask,cafe_agents,cafe_reply,cafe_decline', '--no-extensions', '-e', cafeExtension]`.
- `probeReadonlyRuntime(binary, agent, extensionHash) -> { supported, binaryHash, reason? }` runs in a temporary isolated profile without a model or real Cafe daemon; result is cached only by resolved executable SHA-256 + extension hash.
- Standalone `barista start --agent pi|omp` uses read-only by default and the same `--write` opt-in as headless Codex/Claude.

- [ ] Add RED argv tests for Pi and OMP read-only/write modes and for the standalone CLI help text.
- [ ] Add a fake MCP server fixture with a write-side-effect marker. The probe starts the runtime with production flags, directly attempts the namespaced fake write tool, and asserts it is unavailable and the marker is absent.
- [ ] Add a binary-hash cache test: same executable reuses a successful probe; changed executable bytes force a new probe even when `--version` output is unchanged.
- [ ] Run focused supervisor/CLI tests and verify RED.
- [ ] Implement per-runtime allowlists, disable auto extension discovery, pass only Cafe's explicit extension, and reject an OMP/Pi binary whose exact-hash no-model isolation probe fails.
- [ ] Register no more than the named Cafe tools in the probe fixture; assert the real Cafe extension's tool registrations match the allowed names.
- [ ] Run `npx vitest run tests/team-worker-permissions.test.ts tests/supervisor.test.ts tests/cli.test.ts` and `npm run typecheck`.
- [ ] Review `git diff --check`, stage only Task 2 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 3: Write-scope registry and TUI reservations

**Files:** `packages/daemon/src/team-paths.ts`, `packages/daemon/src/supervisor.ts`, `packages/daemon/src/daemon.ts`, `packages/protocol/src/cafeFile.ts`, `packages/pi-extension/src/index.ts`, `tests/team-path-auth.test.ts`, `tests/team-sessions.test.ts`

**Interfaces:**
- `writeScopeConflicts(candidate, committedRosterScopes, liveWorkerScopes, staleTuiScopes) -> Conflict[]` uses realpath/device/inode and ancestor overlap.
- `memberLaunchHash(rosterRootId, team, member, effectiveConfig) -> sha256` has separate headless/TUI inputs; TUI omits host-selected model and permissions, while headless includes resolved runtime/bin/model/dir/access.
- `releaseTuiReservation(home, reservationId)` frees only the named stale TUI scope after explicit operator confirmation.

- [ ] Add RED tests for exact/nested overlap, partial team starts, unstarted/stopped/restart-backoff reservation, TUI-vs-write conflicts, path release after process exit, and stale TUI reservation release by ID when its old directory no longer exists.
- [ ] Add RED tests that memberLaunchHash is stable across duty/description/tags/scope edits but changes for member identity, team/channel, mode, runtime/bin, directory, access, observer, or headless model.
- [ ] Add RED tests that uncommitted `.cafe` edits do not change the committed hash and a TUI reconnect continues sending the hash captured at process startup.
- [ ] Implement canonical scope registry across team and non-team managed write workers; keep failed-stop reservations until the full process group is gone.
- [ ] Implement TUI member launch-hash validation against the last committed local roster, disconnect stale live TUI sessions after commit, and keep old TUI scopes until release-tui.
- [ ] Run focused scope/TUI tests and typecheck.
- [ ] Review `git diff --check`, stage only Task 3 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 4: Team sync reconciliation and durable recovery

**Files:** `packages/daemon/src/supervisor.ts`, `packages/daemon/src/daemon.ts`, `packages/daemon/src/server.ts`, `packages/daemon/src/store.ts`, `packages/cli/src/main.ts`, `tests/team-sync-recovery.test.ts`, `tests/team-roster.test.ts`, `tests/supervisor.test.ts`

**Interfaces:**
- `TeamSyncIntent { rosterRootId, fromPath, toPath?, committedHash, targetHash, phase, affectedGroups, staleTuiReservationIds }` persists before any worker stop/reconcile.
- `syncTeam(rosterRoot) -> { localRevision, rootRevision?, publishPending, workers, errors }` is idempotent and does not start newly added or intentionally stopped members.
- `relocateTeam(oldRoot, newRoot) -> TeamSyncResult` writes a relocation intent, stops groups, commits the new root, clears old grants, and publishes/retries as one recoverable operation.
- `publishRosterCAS({ host, rosterRootId, baseRevision, revision, contentHash, roster, tombstones }) -> { revision, contentHash }` acknowledges only after durable Root persistence.

- [ ] Add RED tests for sync field diffing (`agent/bin/model/mode/dir/access` restart; description/duty/scope changes do not), new-member no-start, intentionally stopped-member preservation, and same-hash no-op.
- [ ] Add RED tests for malformed/unreadable roster stopping all relevant workers/TUIs; per-member validation errors safety-stop only affected workers; unrelated workers remain.
- [ ] Add RED tests for stop failure retaining process-group reservation and blocking publication; persistence failure leaving changed workers stopped; replacement failure leaving worker offline; Root offline state and retry.
- [ ] Add RED tests for crash/restart through each `TeamSyncIntent` phase, including relocation after old workers stop but before ownership commit; restore must never restart old-root workers.
- [ ] Add RED tests for Root revision rules: same revision/hash ack, same revision/different hash conflict, stale base conflict, Root save failure no ack, lost ack retry, multiple offline local revisions rebased from a known Root snapshot, unknown concurrent Root state requires explicit resolution.
- [ ] Implement atomic local owner mapping keyed by rosterRootId + canonical path; migrate legacy `(host, team, channel)` entries only when realpath matches. Implement `team relocate` retaining rosterRootId, clearing external grants, and preserving stale TUI reservation IDs.
- [ ] Implement stop/restart reconciliation. Preflight the whole roster; apply safety revocations first; persist process-group revoking records before signal; do not publish until all required stops and local persistence succeed. Replacement start failures publish desired state with that member offline.
- [ ] Implement Root compare-and-swap publication; make `saveTeams` propagate durable write errors; persist Root tombstone + rename upsert atomically; retain pending snapshots/rebase logic through Root reconnect.
- [ ] Run focused sync/recovery tests and `npm run typecheck`.
- [ ] Review `git diff --check`, stage only Task 4 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 5: User-facing commands and operational status

**Files:** `packages/cli/src/main.ts`, `packages/daemon/src/server.ts`, `packages/web/src/pages/Teams.tsx`, `packages/web/src/i18n.ts`, `tests/cli.test.ts`, `tests/web-team-permissions.test.ts`

- [ ] Add RED CLI tests/help for `team trust-path`, `team paths`, `team revoke-path <grantId>`, `team release-tui <reservationId>`, and `team relocate <old> <new>` including confirmation of canonical targets.
- [ ] Add RED status tests for effective headless access, `host-managed` TUI permissions, `revocation_pending`, `publish pending`, `revision_conflict`, stale TUI reservations, and relocated roster ownership.
- [ ] Implement local-only grant/relocation endpoints guarded by the matching operator credential; never store grant content in `.cafe` or replicate it to Root.
- [ ] Update Web/CLI output with plain-language member names, paths, effective permission, and the exact repair command; no protocol- or hash-only diagnostics.
- [ ] Run focused CLI/Web/daemon tests, `npm run check --workspace @cafe/web`, and `npm run build:web`.
- [ ] Review `git diff --check`, stage only Task 5 files, and commit with the required attribution trailer; never stage `.vitest/`.

## Task 6: Verification

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test` and require every file/test to pass.
- [ ] Run `npm run routing:eval`, Web check/build, `npm run test:release`, and `npm run test:claude-plugin` when the installed CLI allows it.
- [ ] Preserve the existing `.vitest/` directory and do not stage it.
- [ ] Restart the local workspace Root using the user's established stop/start procedure and run `cafe doctor`; do not claim real second-Host or mixed-version readiness.
- [ ] Update the newest `docs/handoff/handoff.md` §5 entry with completed issue groups, verification results, Root restart/doctor result, and external blockers. Do not hard-code the checkout HEAD hash; do not update the external dogfooding ledger.
- [ ] Run `git diff --check`, stage only reviewed tracked changes, create the final documentation commit with the required attribution trailer, fast-forward local `main`, and push `origin main` as authorized. Keep `.vitest/` untouched/untracked.
