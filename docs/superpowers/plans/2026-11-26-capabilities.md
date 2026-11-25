# Daemon capabilities implementation plan (v4-12)

> **For the implementer:** read `docs/specs/v4-12-capabilities.md` first. Each task is small,
> test-first, and independently verifiable. Verification gate at the end.

**Goal:** a client or daemon notices when its peer predates v4-11 and warns (or, for observer
registration, refuses) instead of silently changing the meaning of `channel`, `escalate`,
`collect: all`, `observer` or team identity.

**Non-goal:** a protocol bump, remote upgrades, ACLs.

## Global constraints

- Every new wire field is optional; an old peer omits it and that is the signal (`[]`).
- "Warn and continue" is the owner decision; the one refusal is `observer: true`, whose fallback
  identity would receive Orders it should never see.
- A warning must reach the caller (CLI stderr, MCP/pi tool result, Web banner), not only a log.
- Tests never touch real state; scratch `CAFE_HOME`; TEST-NET-1 addresses.

## Task 1 — Vocabulary (`packages/protocol/src/version.ts`)

- Export `CAPABILITIES = ["channels","escalate","collect-all","teams","digests"] as const`,
  `CURRENT_CAPABILITIES`, `type Capability`, and `missingCapabilities(have, need)`.
- Test: the module is dependency-free (import from `@cafe/protocol/version` in a test), list is
  stable, helper returns the difference in input order.

## Task 2 — Wire advertisement

- `InitializeParams.capabilities?: string[]`; the `initialize` result (all kinds) gains
  `capabilities: string[]`. `DaemonRecord.capabilities?: string[]`.
- Daemon: `capabilities()` returns `CURRENT_CAPABILITIES`; `peer.meta.capabilities` from
  `initialize`; `daemonRecords` stores a child's list; `connectRoot` stores
  `rootCapabilities` (and health exposes it); `/api/health` and `/api/snapshot` gain
  `capabilities`; `/api/daemons` entries carry theirs.
- Root→child: replay team records only to a peer that advertises `teams`.
- Child→Root: send `team/upsert` only when `rootCapabilities` includes `teams`; log once when a
  roster stays local.
- Tests: new daemon advertises everywhere; a fake old peer leaves the list empty; an old Root gets
  no `team/upsert`; an old child gets no `teamUpsert` replay.

## Task 3 — Client detection (`packages/protocol/src/client.ts`)

- Capture the initialize result's capabilities; `capabilities`, `supports(cap)`.
- `warnings: string[]` plus `onWarning(fn)` (or a drained list) for `ask`/`connect`.
- `ask` warns when `channel`, `escalate` or `collect: all` was sent without its capability.
- `connect(identity)` refuses `observer: true` without `digests` with
  `RpcError("unsupported_capability", hint, { capability: "digests" })`; warns for
  `channels`/`team`/`duty` identity fields.
- Tests: a fake old daemon (no capabilities) → warnings per field; observer refusal; a new daemon
  → no warnings.

## Task 4 — Surface the warnings

- pi extension: prepend client warnings to the `cafe_ask` tool result; the observer refusal becomes
  a tool error.
- MCP: fetch `/api/health` once per process (or per ask) and prepend a warning line; reuse the
  Task 3 client path where it already uses it.
- Claude mod / session-host / bridge: log the warning once; the observer refusal fails the
  registration with the hint. (No new UI.)
- CLI: `cafe ask` warns on stderr (and `warnings` in `--json`); `cafe team` fails fast with the
  restart/upgrade hint; `cafe status`/`doctor` compare the running daemon's capabilities and warn.
- Tests: CLI ask warning + team failure; doctor check; MCP result text.

## Task 5 — Web degraded state

- `Snapshot.capabilities`; store field.
- Feed: when `channels` is missing, show a banner ("the running daemon does not support channels")
  and keep a single channel; Teams: when `teams` is missing, show the banner and disable Start.
- zh/en strings.
- Test: a snapshot without capabilities sets the degraded flag (store test); banner copy asserted.

## Task 6 — Docs + handoff

- README, README_zh, `skills/cafe/SKILL.md`: a short "mixed releases" section (restart after
  upgrade; what degrades; observer refusal).
- handoff §5 newest entry.

## Verification

`npm run typecheck`; `npm test` twice; `npm run routing:eval` (unchanged); `npm run build:web`;
`npm run test:release` (packaging unchanged, run once); `npm run test:claude-plugin` if the plugin
changed. Restart the local Root and check `/api/health.capabilities`, `/api/snapshot.capabilities`,
`cafe doctor`.