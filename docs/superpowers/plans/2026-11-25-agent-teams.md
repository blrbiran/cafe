# Agent Teams & Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement v4-11: teams (`.cafe` roster, per-member processes), channels (routing scope), explicit escalation sub-Threads, `collect: all`, and observer digests, end to end (protocol → daemon → CLI/MCP/extensions → Web).

**Architecture:** Protocol gains optional fields (channel, duty, team, collect, escalate, parentThreadId, failure). The daemon filters routing by channel, creates sub-Threads for escalation, aggregates team rosters to the Root, and assembles observer digests at the Root. The supervisor runs one worker per roster member with its own cwd. The Web adds a Teams page and makes channel a first-class route/store dimension.

**Tech Stack:** TypeScript (Node 22.18+), npm workspaces, zod, ws, better-sqlite3, React + Vite.

**Spec:** `docs/specs/v4-11-agent-teams.md` (rev 2). Every task assumes both this plan and that spec are being read.

## Global Constraints

- TDD: write the failing test first, run it, implement, run it, commit.
- Tests never touch real state: scratch `CAFE_HOME`, isolated `HOME`, `CAFE_DISCOVERY=0` (vitest config), FAST timings from `tests/helpers.ts`, TEST-NET-1 (`192.0.2.0/24`) for fake IPs.
- Backward compatibility: every new protocol field is optional; an old client must behave exactly as today; an old daemon strips new fields and the new client must detect that.
- Channels are not ACLs. Never write "private"/"isolated" copy.
- Verification baseline before the final push: `npm run typecheck`; `npm test` twice; `npm run routing:eval`; `npm run build:web`; `npm run test:release` (packaging changed); `npm run test:claude-plugin` (plugin changed).
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- After daemon/Web changes: `node packages/cli/bin/cafe.js daemon stop && … start`, then `cafe daemon status`.
- Use `/bin/rm`, `/bin/cp` for scratch files (the user's aliases are interactive).

## Review Focus

These inputs are likely to bite and are not obvious from the type signatures; each gets a test in the owning task.

1. **A TUI member in a sibling worktree with no `.cafe` of its own** must load its identity from the roster via `--team-dir`/`CAFE_TEAM_DIR`, not fail as an anonymous customer (Task C2/C6).
2. **An old client that sets `parentOrderId` on every ask** must keep today's routing (no escalation) while a new client using `escalate: true` reaches the parent (Task A2/A3).
3. **A slow `collect: all` target** answering after the old 2 s grace must stay `pending`, then be `skipped` at the deadline — never a decline — and `targetStates` must name it (Task B2).
4. **A team member's fresh ask with no explicit channel** must land in its home/team channel, never `default` (Task B1).
5. **Switching the Web channel and pressing "load older"/searching** must not mix threads from another channel (Task E1/E2).
6. **An observer while the Root is offline** must get a digest marked `partial`, not an empty digest that looks like no activity (Task D1).

---

## Phase A — Escalation sub-Threads (P1 bug)

### Task A1: Protocol fields for escalation and failures

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Test: `tests/protocol-escalate.test.ts`

**Interfaces:**
- Produces: `CreateOrderParams.escalate?: boolean`, `CreateOrderParams.parentThreadId?: string`, `Order.parentThreadId?: string`, `RoutingDecision.failure?: string`.
- Produces: `export const SubOrderFailure = z.enum(["parent_offline","unknown_team","team_offline","ambiguous_team","ambiguous_address","no_channel_members"])` and its type.

- [ ] **Step 1: Write the failing test** — parse `CreateOrderParams` with `{ body, escalate: true, parentOrderId, parentThreadId }` and assert the fields survive; parse a `RoutingDecision` with `failure: "parent_offline"`; assert an unknown failure string fails.
- [ ] **Step 2: Run it** — `npx vitest run tests/protocol-escalate.test.ts` (use `npm test -- tests/protocol-escalate.test.ts` if the direct binary is hooked). Expected: FAIL, fields unknown/undefined.
- [ ] **Step 3: Implement** — add the optional fields to `CreateOrderParams`, `Order`, `RoutingDecision` (next to `whyNot`/`fanout`), and the enum.
- [ ] **Step 4: Run it** — expected PASS.
- [ ] **Step 5: Commit** — `feat(protocol): escalation and sub-order failure fields`.

### Task A2: Daemon escalation creates a sub-Thread to the parent sender

**Files:**
- Modify: `packages/daemon/src/daemon.ts` (`createOrderInner` ~1362, `route` ~1458, `updateMeta` ~2291)
- Test: `tests/escalate.test.ts`

**Interfaces:**
- Consumes: Task A1 fields.
- Produces: `Daemon.findParentOrder(orderId, parentThreadId?): Order | undefined` (knownOrders → thread JSONL) and `RouteOutcome` via `RoutingDecision.failure`.
- Behavior: `escalate` requires `parentOrderId`; new Thread; `parentThreadId` set; channel inherited (Phase B reads it; in A store `parentThreadId`); routing precedence explicit `to` → broadcast → parent sender; no router fallback; `unknown_parent` RpcError; `parent_offline` failure.

- [ ] **Step 1: Write the failing tests** in `tests/escalate.test.ts` using `startDaemon`/`barista`/`customer`:
  1. customer → leader; leader delegates to `dev` with `to: dev`; dev sends `escalate: true, parentOrderId: <leader order>, parentThreadId: <leader thread>`; assert the leader receives the order (`leader` handle's body), the new thread's `parentThreadId` equals the leader thread, and the parent thread's `replies` are unchanged.
  2. parent offline: dev escalates after the leader disconnects; assert `order.failed` reason `parent_offline` and that no other barista received it.
  3. unknown parent: `escalate: true` with a random id → `RpcError` code `unknown_parent`.
  4. explicit `to: leader` from inside the chain succeeds (no `targets=0`).
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**:
  - In `createOrderInner`, when `p.escalate`: require `p.parentOrderId`; resolve parent via a new helper; if missing throw `RpcError("unknown_parent", …)`; force `threadId = ulid()`; set `parentThreadId = p.parentThreadId ?? parent.threadId`; set `chain`/`depth` from the parent as today; do **not** run the `thread_busy` check for this new thread.
  - In `route`, before the `answeredBefore` branch: if `order` came from an escalation (store `escalate` locally or infer from `parentThreadId && !threadContinuation`), handle explicit `to` (resolve against all online baristas, including chain members and observers, excluding the sender), then broadcast, then `parent.from.id`; otherwise `failure: "parent_offline"` and `targets: []`. Never call the router.
  - In `createOrderInner`'s empty-target branch, use `decision.failure ?? "no barista available"` as the `order.failed` reason.
  - In `updateMeta`, write `parentThreadId`/`parentOrderId` on the new Thread only.
- [ ] **Step 4: Run** — expected PASS; also run `npm test -- tests/routing-grace.test.ts tests/routing-fixtures` to ensure no regression.
- [ ] **Step 5: Commit** — `feat(daemon): explicit escalation creates a sub-thread to the parent`.

### Task A3: Client plumbing for escalation

**Files:**
- Modify: `packages/pi-extension/src/index.ts` (`cafe_ask` handler ~619, prompt ~120)
- Modify: `packages/cli/src/main.ts` (`ask` ~744)
- Modify: `packages/cli/src/mcp.ts` (`cafe_ask` ~199)
- Modify: `packages/cli/src/bridge/session-host.ts` (`buildPrompt`)
- Test: `tests/cli.test.ts` (extend), `tests/mcp.test.ts` if present; otherwise a unit test for the request body.

**Interfaces:**
- Produces: CLI flags `--parent <orderId> --escalate`, `--channel <name>`, `--collect any|all`.
- Produces: MCP `cafe_ask` params `parent_order_id`, `escalate`, `channel`, `collect`; pi tool params `escalate`, `channel`, `collect`.
- Produces: the injected prompt carries the current order id and the sentence: “To ask the sender of this order a clarifying question, call cafe_ask with escalate true; unrelated questions must not set a parent.”

- [ ] **Step 1: Write failing tests** — call the CLI `cafe ask --escalate --parent <id>` against a scratch daemon and assert the HTTP body contains both fields; assert the pi tool handler fills `parentOrderId`/`parentThreadId` only when `escalate` is true; assert the session-host prompt contains the order id and the escalate instruction.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** — thread the fields through each surface; in the pi extension use the in-process `current` order; in the Claude prompt include `current.orderId` (the hook already has it); in MCP pass the params; in CLI add flags.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(clients): explicit escalate, channel and collect parameters`.

---

## Phase B — Channels, duties, collect all

### Task B1: Protocol identity/order channel fields and routing filter

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/daemon/src/daemon.ts` (`eligible` ~1439, `createOrderInner` channel resolution, `updateMeta`)
- Test: `tests/channel-routing.test.ts`

**Interfaces:**
- Produces: `ChannelName` (`/^[a-z0-9_-]{1,64}$/`); `AgentIdentity.duty?`, `member?`, `team?`, `teamChannel?`, `channels?: ChannelName[]`, `observer?: boolean`; helper `channelsOf(a): string[]` (`channels ?? ["default"]`); `Order.channel`, `CreateOrderParams.channel`, `ThreadMeta.channel`.
- Produces: `Daemon.resolveOrderChannel(p, peer, parentThread): string`.
- Behavior: `eligible` filters `!observer` and `channelsOf.includes(order.channel)`; explicit `to:` bypasses the channel filter; follow-up inherits and rejects a mismatch (`channel_mismatch`); agent sender defaults to `channels[0]`, human to `default`.

- [ ] **Step 1: Write the failing tests**:
  1. a barista with `channels: ["team"]` does not receive a `default` broadcast; a `team` order reaches it;
  2. a default barista does not receive a `team` broadcast;
  3. explicit `to: team-barista` from default works;
  4. a team member's ask without `channel` gets `channel: "team"` on the Order/ThreadMeta;
  5. a follow-up with a different channel gets `channel_mismatch`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the protocol fields, `channelsOf`, resolution helper, filter, explicit bypass, and meta channel. Keep `role` untouched.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(protocol,daemon): channel scope and home-channel routing`.

### Task B2: `collect: all`, deadline skips, `targetStates`

**Files:**
- Modify: `packages/protocol/src/index.ts` (`ThreadMeta.targetStates`)
- Modify: `packages/daemon/src/daemon.ts` (`track`, `finishOnDeadline`, `updateMeta`)
- Test: `tests/collect-all.test.ts`

**Interfaces:**
- Produces: `ThreadMeta.targetStates?: { agentId: string; state: "pending"|"acked"|"replied"|"declined"|"failed"|"skipped" }[]`.
- Behavior: `collect: "all"` never arms `grace`; a deadline skip emits `order.declined {skipped:true, reason:"deadline"}`; the close status is `done` with ≥1 final reply, else `failed`.

- [ ] **Step 1: Write the failing tests**: two targets 100 ms and 400 ms apart with `collect: all`, FAST grace 60 ms, broadcast deadline 1200 ms → both replies in the Thread, closes after the second; a silent target → at the deadline it is `skipped` (not in `meta.declines`) and `meta.targetStates` says `skipped`; `collect: any` still closes after the first + grace.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the no-grace branch, deadline skip event/status, and targetStates updates in `updateMeta`/`track`.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(daemon): collect all and per-target states`.

### Task B3: Duty as a routing signal

**Files:**
- Modify: `packages/daemon/src/router.ts` (score ~77, LLM cache key ~292)
- Test: `tests/routing-duty.test.ts`, `tests/routing-fixtures.ts` (new cases)

**Interfaces:**
- Behavior: rules score text = `name duty tags scope description`; duty hits score 4 (above a generic token, below the name 5); LLM prompt includes duty and channel; cache key includes `duty` and `channel`.
- Produces: `TEAM_CASES` entries for duty routing, `collect: all`, escalation (unblocked by A/B).

- [ ] **Step 1: Write the failing test** — three candidates `developer`/`tester`/`writer` with identical descriptions; “write a failing test for the parser” routes to the tester; “implement the parser” to the developer.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** scoring and cache key; add eval cases.
- [ ] **Step 4: Run** — expected PASS; `npm run routing:eval` shows the team cases moving.
- [ ] **Step 5: Commit** — `feat(router): duty signal and channel-aware cache`.

### Task B4: Thread channel column and server-side filters

**Files:**
- Modify: `packages/daemon/src/store.ts` (schema/migration, `listThreads`, `search`)
- Modify: `packages/daemon/src/server.ts` (`/api/snapshot`, `/api/threads`, `/api/search`)
- Test: `tests/store-channel.test.ts`, `tests/server-channel.test.ts`

**Interfaces:**
- Produces: `Store.listThreads(limit, opts?: { channel?: string; before?: number })`, `Store.search(..., opts?: { channel?: string })`.
- Produces: HTTP `?channel=` on the three endpoints; absent = all (old clients).
- Migration: add `threads.channel TEXT`, backfill `'default'`, index; old rows read as `default`.

- [ ] **Step 1: Write failing tests** — create threads in two channels; `listThreads({channel:"team"})` returns only team; snapshot/threads/search HTTP with `?channel=` filter; an old row without channel lists as `default`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the column/migration and filters; place `meta.channel` on every new Thread.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(daemon): channel column and server filters`.

### Task B5: CLI and MCP channel/collect surface

**Files:**
- Modify: `packages/cli/src/main.ts` (`ask`, `thread` display)
- Modify: `packages/cli/src/mcp.ts`
- Test: `tests/cli.test.ts`, `tests/mcp.test.ts`

**Interfaces:**
- Produces: `cafe ask --channel <name> --collect any|all`; `cafe thread` prints `channel`; MCP `cafe_ask` accepts both.
- Behavior: a human `cafe ask` without `--channel` posts to `default`.

- [ ] **Step 1: Write failing tests** — CLI body includes channel/collect; thread output shows `#team`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(cli): channel and collect flags`.

---

## Phase C — Team roster, supervisor, team CLI

### Task C1: `.cafe` team schema and validation

**Files:**
- Modify: `packages/protocol/src/index.ts` (`TeamMember`, `TeamSpec`, `CafeDocument`)
- Modify: `packages/protocol/src/cafeFile.ts` (`readCafeFile`, `loadIdentity`)
- Test: `tests/cafe-team.test.ts`

**Interfaces:**
- Produces: `TeamMember`, `TeamSpec`, `CafeDocument = CafeFile.extend({ team: TeamSpec.optional() })`; `readCafeFile(path): CafeDocument`.
- Validation: member names unique/regex; duty ≤64; channel sanitized or explicit; `default` reserved; observer includes the team channel; `mode: tui` only with codex.
- `AgentIdentity` stays `CafeFile.extend(...)` (no `team` block).

- [ ] **Step 1: Write failing tests** — parse the spec's example; reject duplicate member names, `team.channel: default`, an observer without the team channel, a team named `my.proj` without an explicit channel (sanitizes to `my-proj`), a TUI member with a non-codex agent.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the schemas and validation.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(protocol): .cafe team roster schema`.

### Task C2: Roster-backed member identity outside the `.cafe` tree

**Files:**
- Modify: `packages/protocol/src/cafeFile.ts` (`loadTeamIdentity`)
- Modify: `packages/cli/src/bridge/barista.ts`, `packages/cli/src/bridge/session-host.ts`
- Modify: `packages/pi-extension/src/index.ts`
- Test: `tests/team-identity.test.ts`

**Interfaces:**
- Produces: `loadTeamIdentity(rosterDir: string, member: string): { file, team: TeamSpec, member: TeamMember, identity: AgentIdentity } | undefined`.
- Produces: `CAFE_TEAM_MEMBER` + `CAFE_TEAM_DIR`; `--member`/`--team-dir`.
- Behavior: a member dir with no `.cafe` still registers the member identity; the bridge/session-host no longer refuse with “no barista .cafe”.

- [ ] **Step 1: Write failing tests** — temp roster dir with `.cafe`; member dir is a sibling with no `.cafe`; `loadTeamIdentity` returns the member; the pi extension registers `team/member/duty/channels`; an unknown member lists the roster.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(protocol,cli): roster-backed member identity`.

### Task C3: Supervisor runs one worker per member with its own cwd

**Files:**
- Modify: `packages/daemon/src/supervisor.ts` (`BaristaSpec`, `Worker`, `start`, `stop`, `save`, `restore`, `launch`, `list`)
- Modify: `packages/daemon/src/server.ts` (`/api/baristas`)
- Test: `tests/supervisor-team.test.ts`

**Interfaces:**
- Produces: `BaristaSpec.team?: { rosterDir: string; spec: TeamSpec }`; `Worker.member?: string; memberDir?: string; rosterDir?: string`.
- Produces: `startTeam(rosterDir, spec): WorkerInfo[]`, `stopTeam(rosterDir, member?): number`.
- Behavior: one worker per member; spawn `--agent <agent> --dir <memberDir> --member <name> --team-dir <rosterDir>`; log `barista-<member>-<hash8(memberDir)>-1.log`; `save()` one spec per rosterDir; `restore()` restarts members; `stopTeam` never touches a plain barista in the same dir.

- [ ] **Step 1: Write failing tests** — start a 3-member team with two members in `dir: "."` and one sibling; assert 3 workers, distinct logs, distinct cwds; `stopTeam(dir)` stops all; `save`/new supervisor/`restore` restarts 3; a plain `start` in the same dir still throws.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(daemon): supervisor team workers with per-member cwd`.

### Task C4: Team records, `/api/teams`, Root sync and `to: <team>`

**Files:**
- Modify: `packages/protocol/src/index.ts` (`TeamRecord`, Methods `teamUpsert/teamRemove/teamsList`)
- Modify: `packages/daemon/src/daemon.ts` (registration upsert, child removal, `teams()`, team resolution in `route`)
- Modify: `packages/daemon/src/server.ts` (`GET /api/teams`)
- Test: `tests/teams-api.test.ts`, `tests/team-addressing.test.ts`

**Interfaces:**
- Produces: `TeamRecord = { team, host, channel, members: TeamMember[] }`; `Daemon.teams(): TeamRecord[]`.
- Behavior: a member registration with `team` upserts the host's roster; a child disconnect removes its teams; Root re-sends rosters on child connect; `GET /api/teams` includes online member addresses and current Threads; `to: <team>` resolves orchestrator → non-observer members; `unknown_team`/`team_offline`/`ambiguous_team`/`ambiguous_address`.

- [ ] **Step 1: Write failing tests** — register two members of one team; `/api/teams` shows the roster; `to: team` reaches the orchestrator; an offline orchestrator falls back to members; a team with no online members → `team_offline`; two same-named teams → `ambiguous_team`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(daemon): team records, team addressing and /api/teams`.

### Task C5: `cafe team start/status/stop`

**Files:**
- Modify: `packages/cli/src/main.ts`
- Test: `tests/cli-team.test.ts`

**Interfaces:**
- Produces: `cafe team start [member…] [--dir] [--team-dir] [--dry-run] [--force]`; `cafe team status [--json]`; `cafe team stop [member…]`.
- Behavior: idempotent; starts missing headless members; prints exact TUI commands with `--agent`/`--team-dir`; status shows roster, online, current Thread, warnings; stop only supervised team members.

- [ ] **Step 1: Write failing tests** — `team start --dry-run` lists the plan; a second start adds nothing; status after one TUI registration shows 1/3 online; stop removes only the supervised workers.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(cli): cafe team start/status/stop`.

### Task C6: `/cafe-team` member selection in TUI sessions

**Files:**
- Modify: `packages/pi-extension/src/index.ts` (command registration)
- Modify: `packages/cli/src/bridge/session-host.ts` (identity/session)
- Modify: `claude-plugin/hooks/register.ts` + command docs (if `/cafe-team` must be a Claude slash command)
- Test: `tests/team-command.test.ts`, `npm run test:claude-plugin`

**Interfaces:**
- Behavior: `/cafe-team <member>` re-registers the session with the member identity; warns on a cwd mismatch; unknown member prints the roster; a TUI member in a sibling worktree works with `CAFE_TEAM_DIR`.

- [ ] **Step 1: Write failing tests** — invoke the handler with a roster and assert the registration identity; unknown member error text.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(clients): /cafe-team member selection`.

---

## Phase D — Observers and channel APIs

### Task D1: Observer digests assembled at the Root

**Files:**
- Modify: `packages/protocol/src/index.ts` (Methods `channelDigest`, `ChannelDigest` type)
- Modify: `packages/daemon/src/daemon.ts` (digest timer, assembly, send; `timing.digestIntervalMs`)
- Modify: `packages/daemon/src/server.ts` (health/timing if needed)
- Test: `tests/observer-digest.test.ts`

**Interfaces:**
- Produces: `ChannelDigest = { channel, since, threads: [...], omitted, partial? }`; `Methods.channelDigest`; `RunOptions.timing.digestIntervalMs` (default 60_000; `CAFE_DIGEST_INTERVAL_MS`).
- Behavior: one digest per observer per channel per interval while there is activity; observers are never routing targets; thread-close events are folded into the interval; a child with no Root sets `partial: true`; digest contains no attachment contents.

- [ ] **Step 1: Write failing tests** — an observer and a working barista; two orders in the team channel within one FAST interval → one digest with 2 threads; no digest for `default` unless the observer lists it; observer never receives an `order/deliver`; with the Root stopped, the child digest is `partial`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(daemon): observer channel digests`.

### Task D2: Channel history API and `cafe channel`

**Files:**
- Modify: `packages/daemon/src/server.ts` (`GET /api/channels`, `GET /api/channels/:name/threads`)
- Modify: `packages/cli/src/main.ts` (`cafe channel threads <name> [--after]`)
- Test: `tests/channel-api.test.ts`

**Interfaces:**
- Produces: `GET /api/channels` → `{name, teams, threads, lastActivityAt}[]`; `GET /api/channels/:name/threads?after=<ms>&limit=` → `{threads, hasMore}`.
- Behavior: after-cursor catches up; empty channel is explicit.

- [ ] **Step 1: Write failing tests** — two channels; `/api/channels` lists both; `after` returns only newer; unknown channel returns an empty list with `exists:false`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(daemon,cli): channel history API`.

### Task D3: Clients handle digests (pi + Claude session-host/plugin)

**Files:**
- Modify: `packages/protocol/src/client.ts` (`onDigest`)
- Modify: `packages/pi-extension/src/index.ts` (queue a digest turn)
- Modify: `packages/cli/src/bridge/session-host.ts` (`digest` message type)
- Modify: `claude-plugin/hooks/register.ts` (`digest` handling)
- Test: `tests/digest-client.test.ts`, `npm run test:claude-plugin`

**Interfaces:**
- Produces: `CafeClient.onDigest(cb: (d: ChannelDigest) => void)`.
- Behavior: one digest → one summarized turn; queued behind an in-flight Order; no ack/reply; never interrupts.

- [ ] **Step 1: Write failing tests** — the client dispatches `channelDigest` notifications to `onDigest`; the pi handler queues one item; the session-host prompt contains the digest summary.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(clients): observer digest handling`.

---

## Phase E — Web

### Task E1: Channel in route, store, API

**Files:**
- Modify: `packages/web/src/route.ts` (`Route`, `parseRoute`, `hashFor`)
- Modify: `packages/web/src/store.ts` (channel state, per-channel reset, `loadOlder`, search)
- Modify: `packages/web/src/api.ts` (channel params)
- Test: `tests/web-route-channel.test.ts`, `tests/web-store-channel.test.ts`

**Interfaces:**
- Produces: `Route = { page: "feed"; filter; channel?: string }` (channel defaults `default`); `store.setChannel(name)`; `api.snapshot(channel)`, `api.threads(channel)`, `api.search(q, channel)`.
- Behavior: channel survives navigate/refresh; a channel change resets threads and re-snapshots; `loadOlder`/search never mix channels.

- [ ] **Step 1: Write failing tests** — `parseRoute("#/feed?channel=team")`; `hashFor` round-trip; store reset on `setChannel`; `loadOlder` request includes the channel.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(web): channel route and per-channel store`.

### Task E2: Feed channel chips and composer destination

**Files:**
- Modify: `packages/web/src/Shell.tsx`, `packages/web/src/pages/Feed.tsx`, `packages/web/src/i18n.ts`, `packages/web/src/styles.css`
- Test: `tests/web-channel-ui.test.ts` (render/unit) + `npm run build:web`

**Interfaces:**
- Behavior: chips `default` + every channel from `/api/channels`; composer shows `→ #channel`; clicking switches; empty channel says "no Threads in this channel"; zh/en strings; no privacy wording.

- [ ] **Step 1: Write failing tests** — chips render from a mocked channels list; the composer label follows the route; an empty channel renders the explicit empty state.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS; `npm run build:web`.
- [ ] **Step 5: Commit** — `feat(web): channel chips and composer destination`.

### Task E3: Teams page and roster drawer

**Files:**
- Create: `packages/web/src/pages/Teams.tsx`, `packages/web/src/TeamDrawer.tsx`
- Modify: `packages/web/src/route.ts`, `Shell.tsx`, `api.ts`, `i18n.ts`, `styles.css`
- Test: `tests/web-teams.test.ts` + `npm run build:web`

**Interfaces:**
- Produces: route `#/teams`; `api.teams()`; cards (name, channel, online/total, open/today, member chips, observer icon); drawer (roster table, `Ask orchestrator`, `Open channel`); empty state with `.cafe` + `cafe team start`.
- Behavior: remote teams render from `/api/teams`; offline members shown; no fabricated counts.

- [ ] **Step 1: Write failing tests** — route parse/hash; cards render online/total and channel; drawer lists offline members; `Ask orchestrator` navigates with `to=<team>&channel=<team channel>`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS; `npm run build:web`; screenshot at 1440/390.
- [ ] **Step 5: Commit** — `feat(web): teams page and roster drawer`.

### Task E4: Sub-Thread links in the Thread view

**Files:**
- Modify: `packages/web/src/pages/Conversation.tsx` (or the thread page), `api.ts`, `i18n.ts`
- Test: `tests/web-subthread.test.ts`

**Interfaces:**
- Behavior: a child Thread shows “parent” link; a parent shows “N clarifications” with status; replies are not mixed.

- [ ] **Step 1: Write failing tests** — given a meta with `parentThreadId`, the page renders the parent link; a parent with children renders the link list.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — expected PASS; `npm run build:web`.
- [ ] **Step 5: Commit** — `feat(web): sub-thread links`.

### Task E5: Docs, verification, handoff, push

**Files:**
- Modify: `README.md`, `README_zh.md`, `docs/handoff/handoff.md`, `docs/specs/v4-5-agent-teams.md` (mark superseded), `SKILL.md` if present.
- Test: the full baseline.

- [ ] **Step 1: Update docs** — team quickstart, channel semantics (“not private”), observer, `collect: all`, escalation, permissions.
- [ ] **Step 2: Run the full baseline**:
  `npm run typecheck`; `npm test` (twice); `npm run routing:eval`; `npm run build:web`; `npm run test:release`; `npm run test:claude-plugin`.
- [ ] **Step 3: Restart the local daemon and check `cafe daemon status` / `cafe status`**.
- [ ] **Step 4: Update `docs/handoff/handoff.md` §5** with: what shipped, verification, behavior changes, waiting-on-user items, next steps. Do not hardcode a git HEAD.
- [ ] **Step 5: Commit and push** — `git add … && git commit -m "feat: agent teams and channels (#71 #72)"`; `git push origin main`.
- [ ] **Step 6: Final report** — include the 10-line executive summary.

---

## Self-review notes (kept for the executor)

- Spec coverage: §2.1 → C1; §2.2 → B1; §2.3 → A1/B1; §2.5 → C4; §3.1 → B1; §3.2 → B1/C4; §3.3 → A2/A3; §3.4 → A2 (invariant kept); §3.5 → B3; §3.6 → B2; §3.7 → A3; §4 → C3/C5; §4.5 → C2/C6; §5 → D1/D2/D3; §6 → E1–E4; §7 → B4/A1; §8 → A2/B1; §9 → every phase.
- Dangerous inputs covered in Review Focus and in tests.
- Type names are consistent: `ChannelName`, `TeamMember`, `TeamSpec`, `CafeDocument`, `TeamRecord`, `ChannelDigest`, `targetStates`, `parentThreadId`, `escalate`, `failure`.
- Deliberate non-goals: Codex escalation, DAG, ACLs, per-team TOP_K.