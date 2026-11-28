# Dogfooding Upgrade Safeguards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect authenticated Order results and let existing users upgrade, inspect their teams, and recover standalone configuration safely.

**Architecture:** Validate authenticated Agent events against recorded assignment and delivery evidence. Normalize legacy TUI declarations at file load, preserve originals when replacing standalone identities, and resolve read-only runtime names before reporting readiness.

**Tech Stack:** TypeScript, Node 22, Vitest, YAML.

**Spec:** [Reviewed dogfooding safeguards](../specs/2026-11-28-dogfooding-upgrade-safeguards-design.md), [Host and caller authorization](../specs/2026-11-27-host-and-caller-authorization-design.md), and [Team worker permissions](../specs/2026-11-27-team-worker-permissions-design.md).

## Global Constraints

- Existing event files and databases are preserved.
- TUI permissions are controlled by the terminal. Keep headless permission declarations effective and preserve the original YAML when loading legacy files.
- Keep production Pi/OMP read-only launch disabled until the real runtime isolation checks pass.
- Run tests with the isolated `npm test` entry point.

## Review Focus

- A legacy Agent client can omit the assignment field on its local RPC. The daemon still has the exact durable delivery and should use it for authenticated relay.
- A report after reconnect retains its assignment identity. Identical retries stay idempotent.
- A mixed TUI/headless roster retains the headless member's declared access and does not rewrite the file.
- Repeated explicit identity replacement preserves each original byte sequence in a separate backup.
- A PATH-resolved Pi/OMP executable remains blocked when no verified production isolation probe is enabled.

### Task 1: Authenticated Agent events (#223)

**Files:** `packages/daemon/src/daemon.ts`, `tests/host-assignment-relay.test.ts`.

- [ ] Use the stored delivery assignment as the authoritative source for reported Agent events on authenticated links. Cover a legitimate report or reply and its delivery evidence in local fixtures.
- [ ] Require the assignment and matching delivery for incoming Agent results. Keep coordinator-generated skips on the owner-authority path. Leave journal reading and authorized pending replay intact.
- [ ] Run the authenticated assignment, direct-link and team result suites.

### Task 2: Legacy TUI declarations (#218)

**Files:** `packages/protocol/src/cafeFile.ts`, `packages/cli/src/{main,doctor}.ts`, `tests/{team-path-auth,cli,doctor}.test.ts`, worker permissions design and README files.

- [ ] Check that `readCafeFile(path, { onIgnoredTuiAccess })` accepts a legacy TUI declaration, emits the affected member name, returns no TUI `access`, preserves headless `access`, and leaves the source bytes intact.
- [ ] Use that callback for actionable status/start/sync and Doctor diagnostics. Published TUI status identifies the terminal as the permission manager. Retain strict validation of the normalized launch configuration.
- [ ] Run the parser, roster, CLI and Doctor tests.

### Task 3: Recoverable standalone initialization (#203)

**Files:** `packages/cli/src/{init,main}.ts`, `tests/cli-init.test.ts`.

- [ ] Check that explicit replacement creates a unique byte-for-byte backup and returns its path in CLI output. Cover a second replacement and existing team/malformed file refusal.
- [ ] Add `backupFile?: string` to `InitResult`. Before replacing the verified regular file, back up its original contents to a unique sibling with exclusive creation and validate that the source has not changed. Print the backup path and update `--force` help.
- [ ] Run the init and Doctor suites.

### Task 4: Read-only runtime diagnostics (#221)

**Files:** `packages/daemon/src/supervisor.ts`, `tests/team-worker-permissions.test.ts`.

- [ ] Check that a bare executable resolves from the daemon PATH, a missing executable has a distinct diagnostic, and production preflight still refuses an unverified read-only launch.
- [ ] Resolve bare names through PATH and explicit absolute paths canonically. Give an actionable diagnostic for the missing/unverified cases. Keep the production gate disabled until the isolation evidence is available.
- [ ] Run the worker permissions suite, full `npm test`, and the TypeScript checks. Report fixture and real-runtime acceptance separately.
