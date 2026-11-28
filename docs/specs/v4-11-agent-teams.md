# v4-11 — Agent teams and channels (#71, #72)

Status: **design revised after independent adversarial review, 2026-11-25.**
This spec supersedes `v4-5-agent-teams.md` for team semantics. Two decisions
changed after review:

- **A sub-order is a new sub-Thread, not a second open Order in the parent
  Thread.** `ThreadMeta` is a one-Order aggregate; parallel Orders would corrupt
  its replies, `history`, `turn`, SSE follow and `cancel` semantics. A sub-Thread
  inherits the parent's channel and links back with `parentThreadId`.
- **Escalation is explicit (`escalate: true`).** `parentOrderId` alone keeps its
  current meaning (provenance/chain), so an old client cannot be silently
  redirected. The pi/Claude tool surface sets `escalate` only when the model
  means "ask the sender of the order I am handling".

## 0. Why

The ledger's team research (2026-11-25) established the constraints:

- **TUI context boundary = process boundary.** A role change inside one process
  does not isolate context. Each duty needs its own process, and the duty must be
  part of the registered identity, not of a Thread.
- **The team loop is broken today.** A developer's clarifying question is
  excluded from its parent by `eligible()`'s chain rule, and the rules router's
  top-k fallback then broadcasts the internal question to unrelated agents.
- **Broadcast cuts slow members** 2 s after the first final answer.
- **No channel scope.** Team traffic and default traffic share one pool.

The owner's decisions (2026-11-23 → 2026-11-25): the team definition lives in
`.cafe`; `team` and `channel` are two concepts; duties are defined in the repo;
merge/worktrees stay with the developer agent (cafe does not manage git); a
channel is **not** a security boundary; one `.cafe` = one team; Web channel
switching is part of the feature; an observer/monitor role is a first-class
daemon concept.

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **team** | Membership declared in one `.cafe`. One team per `.cafe`; a second team is a second directory/worktree. |
| **duty** | A free-form label on a member (`orchestrator`, `developer`, `writer`, `法务`, …). A routing signal, not an enum. |
| **channel** | A message scope name. `default` is the implicit channel for everyone. Not a security boundary. |
| **observer** | A team member that watches a channel but is never routed to. Daemon-enforced. |
| **member** | An entry in the team roster, registered by one process. |
| **sub-Thread** | A Thread created for a clarification/escalation. It links to its parent with `parentThreadId` and inherits the parent's channel. |

## 2. Data model

### 2.1 `.cafe` team block (backward compatible)

```yaml
name: myproj
description: the project this team works on
tags: [typescript]
role: barista
concurrency: 1

team:
  name: myproj-dev           # optional; default: the .cafe `name`
  channel: myproj-dev        # optional; default: sanitize(team.name)
  agent: pi                  # optional default runtime for members: pi|omp|codex|claude
  members:
    - name: orch
      duty: orchestrator
      description: splits work, assigns developers, collects results
      mode: headless
      dir: .
      agent: claude
    - name: arch
      duty: architect
      description: owns the design and answers design questions
      mode: tui
      dir: ../myproj-arch
    - name: dev1
      duty: developer
      description: implements code in its own worktree
      mode: headless
      dir: ../myproj-dev1
    - name: t1
      duty: tester
      description: runs end-to-end tests and reports failures
      mode: headless
      dir: .
      collect: all
    - name: watch
      duty: monitor
      observer: true
      channels: [myproj-dev, default]
      mode: tui
```

Protocol (`packages/protocol/src/index.ts`) gains:

```
TeamMember = {
  name, duty?, description? = "", tags? = [], scope? = [],
  mode? = "headless" | "tui", dir? = ".",
  channels?, observer? = false, collect? = "any" | "all",
  agent? | bin? | access?,   // headless launch, same values as `cafe barista start`
}
TeamSpec = { name?, channel?, agent?, members: TeamMember[] }
CafeFile.team?: TeamSpec
```

Validation (at `.cafe` parse time; messages name the offending line/value):

- member `name` unique within the team, `[a-zA-Z0-9_.-]+`.
- `duty` a non-empty string ≤64 chars; free-form.
- `dir` resolves against the directory holding `.cafe`; default `.`. It need not
  exist at parse time (it must at `team start`). cafe never creates it, never
  runs git.
- `mode` default `headless`.
- `channels` defaults to `[team.channel]`; an observer must include the team
  channel. `default` is always reachable as a **sender**; joining it as a
  **receiver** requires listing it.
- `team.channel` = explicit value, else `sanitize(team.name ?? .cafe name)` where
  `sanitize` lowercases and replaces invalid characters with `-`. If the result
  is `default`, empty, or not `[a-z0-9_-]{1,64}`, parsing fails with a message
  asking for an explicit `team.channel`.
- `agent` defaults to `team.agent` then `pi`. `mode: tui` is valid for any agent:
  the person starts that session themselves (codex via `cafe barista run --tui`,
  pi/Claude via `/cafe-team`). `team start` never auto-starts a TUI member; it
  only prints the command. Headless members are auto-started for any `agent`.
- Top-level fields keep their current meaning for a plain (non-member)
  `cafe barista start`. A plain start registers the top-level identity exactly
  as today; it does not join the team.

### 2.2 `AgentIdentity` additions (all optional)

| Field | Type | Meaning |
|---|---|---|
| `team` | string | Team name this process belongs to. |
| `teamChannel` | string | The team's channel (so the Web and `to: <team>` need no roster). |
| `member` | string | Roster entry name. |
| `duty` | string | Routing label. |
| `channels` | string[] | Channels this agent receives from. Absent = `["default"]`. The first entry is its **home channel**. |
| `observer` | boolean | Never a routing target. |

Old clients register unchanged. An old daemon's zod parser strips these keys;
the client compares the echoed `AgentRecord` with its identity and, when
`team`/`channel` was stripped, logs once: `the daemon does not support teams;
upgrade it`. `CafeClient` refuses to connect as a member in that case (never act
as a team member against a daemon that drops the fields).

### 2.3 `Order`, `CreateOrderParams`, `ThreadMeta`

- `channel?: string` on all three. The stored Order always has a concrete value.
- `collect?: "any" | "all"` on Order and CreateOrderParams. Absent = `"any"`.
- `escalate?: boolean` on CreateOrderParams only. Requires `parentOrderId`.
- `parentThreadId?: string` on Order and CreateOrderParams. The Thread that holds
  the parent Order; required when the parent Order is not in the daemon's memory.

Channel resolution (in `createOrderInner`, never in the client):

1. `escalate`/sub-Thread → inherit the parent Thread's channel.
2. `threadId` given (a follow-up) → inherit that Thread's channel; an explicit
   different `channel` is `channel_mismatch`.
3. Registered agent sender → its home channel (`channels[0]`, else `default`).
4. Human CLI/Web/MCP → `default` unless the caller passes a channel.
5. Otherwise → `default`.

An **explicit `channel` on a fresh Order overrides the home channel** for any
sender (channels are scopes, not ACLs), so an observer can post to `default` and
a member can address another team. For a sub-Thread (`escalate`) the parent
channel wins; an explicit different channel is `channel_mismatch`. For a
follow-up, the Thread channel wins; a different explicit channel is
`channel_mismatch`.

`ThreadMeta` gains `channel`, `parentThreadId?`, `parentOrderId?` and
`targetStates?: { agentId, state }[]` (see §3.6). One open Order per Thread
remains the invariant; sub-Threads are separate Threads.

### 2.4 Channel names

`[a-z0-9_-]{1,64}` after sanitizing; `default` is reserved. Channels are
network-wide names. The Root keeps a channel index (team, host) and logs a
warning when two teams on different hosts declare the same channel; it does not
rename either team.

### 2.5 Team roster replication

`TeamRecord = { team, host, channel, members: TeamMember[] }`.

- A daemon that owns a roster (`cafe team start`, or any member registering)
  sends the **full** `TeamRecord` to the Root with a per-`(host, team)`
  monotonic `revision`. The Root keeps the roster in memory and in
  `CAFE_HOME/teams.json`, pushes changes to connected children, replays the full
  set on connect, and **keeps an offline host's roster** (marked offline) until
  an explicit `team/remove` or host forget.
- A TUI registration carries `teamDir`; the local daemon reads that `.cafe` and
  upserts the full roster, so a team started only by TUIs still has a roster.
  On reconnect the owning daemon re-publishes every roster it owns.
- `/api/teams` on any daemon returns local + replicated teams, each with:
  roster (including offline members), online member addresses from the registry,
  open Thread count and last activity in its channel, and the current Thread per
  busy member. **Metrics are computed by the Root** (it sees every Thread event
  and every Agent registration); a child proxies the Root's team view when the
  Root is online and merges its own local view. When the Root is offline the
  response carries `partial: true` and local-only metrics — never fabricated
  remote counts.
- `AgentRecord` gains optional `activeThreadId` (the Order/Thread the client is
  currently handling, set by the daemon that owns the connection on deliver and
  cleared on reply/decline). It is replicated with the rest of the record; this
  is what "current Thread" means. It is indicative, not a lock.
- `/api/channels` is derived from teams + Threads:
  `{ name, teams: [{team, host}], threads, lastActivityAt }[]`.

This is what makes remote team cards and `cafe team status` possible; the
registry alone cannot show offline members or mode/dir.

## 3. Routing

### 3.1 Channel filter

`eligible(order)` adds:

```
r.role === "barista" && r.status !== "offline" && !excluded.has(r.agentId)
&& !r.observer
&& channelsOf(r).includes(order.channel)
```

`channelsOf(r)` is `r.channels` (absent → `["default"]`). A plain agent is in
`default` only. Default traffic never reaches a team member that lists only its
team channel; a team broadcast never reaches a plain agent.

### 3.2 Explicit addressing is the escape hatch

An explicit `to:` resolves against **all online baristas** (any channel,
observers included), excluding only the sender itself. This lets a team member
reach a default agent, a human reach an observer, and a sub-agent name its
parent. Depth still caps the chain.

`to: <team>` resolution:

1. an exact agent address/id wins (existing `Registry.resolve`);
2. else a team whose name is `team`:
   - prefer a team on the sender's own host, then a team sharing the sender's
     channel, then a unique team network-wide;
   - two matches with no preference → `ambiguous_team` (lists hosts);
   - a known but offline team → `team_offline`;
   - unknown → `unknown_team`;
   - a team maps to its single online non-observer `duty: orchestrator` member;
     with no orchestrator, it is a multicast to all online non-observer members.

A bare member name (`to: dev1`) inside a team resolves inside the sender's own
team first, then network-wide; ambiguity is `ambiguous_address`.

Explicit addressing deliberately bypasses the chain filter, so an ancestor can be
named. Revisits are bounded by `MAX_ORDER_DEPTH` (4): A→B→A cannot loop forever,
and every hop is recorded in the chain. This is the documented trade-off.

### 3.3 Escalate: an explicit sub-Thread to the parent's sender

`escalate: true` requires `parentOrderId`. The daemon:

1. Resolves the parent Order from `knownOrders`, else from the parent Thread's
   JSONL (`parentThreadId` + `order.created`). If neither finds it →
   RpcError `unknown_parent` (never route).
2. Creates a **new Thread** in the parent's channel. `threadId` in the request is
   used only as `parentThreadId` if `parentThreadId` is absent; it does not
   continue the parent Thread.
3. Routes, in this order:
   - explicit `to` → the named target (may be the parent's sender or anyone);
   - `broadcast: true` → the channel's eligible members;
   - otherwise → the parent Order's `from.id`, if that agent is an online
     barista (reason `escalate to parent`). Parent offline → `parent_offline`.
4. **Never falls back to the rules/LLM router and never broadcasts
   implicitly.** An explicit `broadcast: true` is honored (it is the sender's
   stated intent); the default is the direct parent or `parent_offline`.

A registered caller must be a **target of the parent Order**; an Order id alone
is not a routing bypass (`not_a_target`). A supplied `parentThreadId` must match
the parent Order's Thread. The local CLI/MCP operator (token-authenticated) may
escalate manually; this is a trusted local surface, not a way for an agent to
escape routing.

The chain and depth rules are unchanged, so a sub-Thread cannot loop.

`parentOrderId` **without** `escalate` keeps today's meaning: provenance and
chain, normal routing. This is what old clients send. The pi/Claude tool surface
gains `escalate?: boolean`; only an explicit escalation sets it, and the tool
description says so. The bridge prompt states: unrelated question → no parent;
delegate → `to:`; clarify with the asker → `escalate: true`.

### 3.4 One open Order per Thread (unchanged)

`thread_busy` stays exactly as today: a follow-up on a Thread with an open Order
fails with the `cancel` / `replace` escape. Parallelism comes from sub-Threads
and from one multicast Order with `collect: all`, not from concurrent Orders in
one Thread. `cancel` and `reply` keep their one-Order-per-Thread meaning.

### 3.5 Duty as a routing signal

- **Rules router:** score a duty-token match above `description`/`tags` matches
  and below an exact name match. The scored text is
  `name + duty + tags + scope + description` (scope is not dropped).
- **LLM router:** the candidate table includes `duty`; the prompt states the
  order's channel; the decision-cache key includes `duty` and `channel`.
- `RoutingDecision` gains optional `failure` (see §3.7) and keeps `whyNot`.

### 3.6 Collection

- `collect: "any"` (default): unchanged. The first final answer arms `graceMs`
  (2 s prod); silent targets become `skipped` (auditable, not declined).
- `collect: "all"`: no grace timer. The Thread closes when every target is
  terminal (final reply / decline / failure) or the deadline fires. Deadline
  skips emit `order.declined { skipped: true, reason: "deadline" }` (like
  `finishGrace`), not `order.failed`, so they are not declines in the books.
  Close status: `done` if at least one final reply, else `failed`.
- `notice` Orders ignore `collect`.
- `ThreadMeta.targetStates` records each target's state
  (`pending | acked | replied | declined | failed | skipped`), bounded, updated
  from the same events. The Web and `cafe thread show` use it to show "still
  silent: dev1, dev2". This is a new optional field; absent means derive from
  `targets`/`replies`/`declines` (old rows).

### 3.7 Client plumbing for escalation

The current Order id must reach the tool that sends the clarification:

| Client | How it learns the current Order | How it escalates |
|---|---|---|
| pi / omp extension | in-process `current` OrderHandle | `cafe_ask` gains `escalate?: boolean`; the handler fills `parentOrderId`/`parentThreadId` from `current`. The injected prompt says: unrelated question → no parent; delegate → `to:`; clarify with the asker → `escalate: true`. |
| Claude session-host / plugin | `current.orderId` in the hook; the injected prompt includes the order id and thread id | the prompt tells the model to call `cafe_ask` with `parent_order_id: "<id>", parent_thread_id: "<threadId>", escalate: true`; the MCP server passes them through. |
| CLI | `cafe ask --parent <orderId> --parent-thread <threadId> --escalate` | explicit flags. |
| MCP | `cafe_ask` gains `parent_order_id`, `parent_thread_id`, `escalate`, `channel`, `collect` | passed through to `/api/orders`. |
| Codex bridge | no cafe tool surface today | **out of scope this round**: a Codex Barista cannot escalate; document it in the bridge prompt and README. |

`cafe ask` and the MCP tool also gain `--channel` / `channel` and
`--collect any|all` / `collect`.

Non-blocking is the intended workflow: a TUI processes one Order at a time, so
a parent that is still inside its own turn cannot answer a clarification until
that turn ends. The prompt for orchestrators says: do not block a turn waiting
for every sub-answer if a developer may escalate; let the Thread stay open and
answer clarifications when they arrive.

## 4. Team lifecycle

### 4.1 `cafe team start [member…]`

1. Load the roster from the nearest `.cafe` with a `team` block, starting at
   `--dir` (default cwd). `--team-dir <dir>` selects it explicitly.
2. Query `/api/teams` (or `/api/agents`) for the team's online members.
3. Presence:
   - headless member: the supervisor's worker record for
     `(rosterDir, member)` exists and is running;
   - TUI member: an online agent with the same `team` and `member` (or, for
     older clients, the same name) exists. A cwd difference is a warning, not a
     hard mismatch: a TUI process cannot change cwd.
   - A duplicate member (two online agents with the same `team`/`member`) is
     reported; `team start` does not add a third.
4. Missing `mode: headless` members are started through the supervisor with
   `{ rosterDir, member, dir }`. Missing `mode: tui` members are **not**
   started: print the exact command, including `--agent` and `--team-dir`:
   - codex: `cafe barista run --agent codex --tui --dir <dir> --member <name> --team-dir <rosterDir>`
   - Claude/pi: open the session in `<dir>` and run `/cafe-team <name>`.
5. Idempotent. `--dry-run` prints the plan. `--force` starts a missing headless
   member even when an unowned same-name agent is online.

### 4.2 `cafe team status`

Uses `/api/teams`: member, duty, mode, dir, online address, agent status,
current Thread (when busy), warnings (duplicate, TUI cwd, failed worker).
`--json` for scripts. Current Thread comes from the daemon's tracking and is
served by `/api/teams`; it is not stored in `AgentRecord`.

### 4.3 `cafe team stop [member…]`

Stops only workers the supervisor started for this team, identified by
`(rosterDir, member)`. It never signals a TUI/self-started agent. With no
member, it stops all supervised members of the team — not every barista in that
directory, and not a plain `cafe barista start` in the same dir.

### 4.4 Supervisor changes

- `BaristaSpec` gains an optional `team: { rosterDir, name, channel, members[] }`.
  One team spec per `.cafe` directory remains the persistence key, so `save()`
  keeps one spec per roster and `stop` can remove it.
- Each member is one `Worker` with `rosterDir`, `member`, `memberDir`, `cwd`
  (the member dir), `slot = 1`. Spawn args:
  `cafe barista run --agent <agent> --dir <memberDir> --member <name> --team-dir <rosterDir>`
  (or the pi extension path with `CAFE_TEAM_MEMBER` + `CAFE_TEAM_DIR`).
- Log names: `barista-<member>-<hash8(memberDir)>-1.log`.
- The duplicate-spec throw still rejects a second team spec for the same
  `rosterDir`. It does not conflict with TUI members, which the supervisor does
  not own.
- `restore()` restarts supervised members only. `list()` exposes member and
  cwd; `/api/baristas` carries them.
- `stopTeam(rosterDir, member?)` is the only path `cafe team stop` uses.

### 4.5 Selecting a member in a process

- `cafe barista run/start` and `cafe team start` accept
  `--member <name> --team-dir <dir>`; the environment equivalents are
  `CAFE_TEAM_MEMBER` and `CAFE_TEAM_DIR`.
- Identity resolution: when a member is selected, the roster `.cafe` is the one
  in `--team-dir` (or found upward from the member dir); the member's fields
  win over the top-level `.cafe` fields. If the member dir has its own `.cafe`
  with a different name, the roster dir's `.cafe` is authoritative and a warning
  is logged.
- `loadIdentity()` gains a team mode: with `CAFE_TEAM_MEMBER`/`CAFE_TEAM_DIR`
  set, it returns the member identity even when the member dir has no `.cafe`.
  `runBridge` and `session-host` bypass their "no barista .cafe" refusal when a
  roster-backed member identity is present — otherwise every member in a
  worktree would fail to start.
- The pi/omp/Claude extensions register the member's identity (name,
  description, tags, scope, duty, team, teamChannel, channels, observer).
- `/cafe-team <member>` re-registers the current session as that member. It
  warns when the member `dir` differs from the process cwd (context is not
  isolated in a TUI). An unknown member lists the roster.

## 5. Observers

- Registered with `observer: true`; never a candidate under §3.1. Explicit `to:`
  can still reach one; then it is an ordinary Order and the observer's client
  must ack/reply like any barista.
- **Delivery is a digest, not a firehose.** The daemon the observer is registered
  on assembles per-channel digests from the Threads it can see. On the Root that
  is the whole network (it receives every Thread event); on a child it is that
  child's view. The digest carries a `digestId`; the client keeps the last
  `digestId` per channel and ignores a replay, so a Root reconnect cannot repeat
  old activity. Cross-host relay of a digest to an observer on a third Host is a
  v1 boundary (see §12): run the observer on the Root or on the team's Host.
  Shape:
  `{ digestId, channel, since, threads: [{ threadId, status, from, summary,
     targets, replies, declined, closedAt, parentThreadId? }], omitted, partial? }`.
  - At most once per `timing.digestIntervalMs` (default 60 s) per channel while
    there is new activity. Thread-close events are folded into the next interval;
    there is no per-close send.
  - Pi/OMP display ordinary activity. They group newly closed failed Orders with an
    exact Order ID into an observation turn. Each observer session starts at most
    one automatic observation turn per 60 seconds and handles explicit Orders first.
    An observation has no ack or reply and does not create a Thread.
  - If the Root is offline, a child assembles a local digest and sets
    `partial: true` (honest boundary: it sees only its own Threads).
  - The extension turns one digest into one summarized message; it does not
    trigger a turn per Order or per reply.
- **Pull for detail.** `GET /api/channels/:channel/threads?after=<ms>&before=<ms>&limit=`
  and the existing Thread endpoints; CLI `cafe channel threads <name> --after`.
  Threads are ordered by `lastActivityAt` descending; `after` is exclusive
  (`lastActivityAt > after`), `before` pages older, and `threadId` breaks ties.
  The `after` cursor lets a reconnecting observer catch up. The daemon serves the
  view it can see (Root: network-wide; child: local).
- **Sending.** An observer is a normal sender: it can send a fresh explicit Order
  to the orchestrator, address a team, or post to `default`. A digest turn has no
  parent Order, so it is a fresh Order, not an escalation. Recording issue
  documents is the agent's own tool work; the daemon only carries the message and
  attachments.
- A channel digest never contains attachment contents, only metadata (the
  existing attachment rule).

## 6. Web

### 6.1 Teams page

New route `#/teams`. One card per team, local and remote (from `/api/teams`):

```
┌ myproj-dev ──────────┐  ┌ cafe-core ───────────┐
│ ● 4/5 online         │  │ ● 2/3 online         │
│ #myproj-dev          │  │ #cafe                │
│ 3 open · 12 today    │  │ 1 open · 4 today     │
│ [orch][arch][dev1]…  │  │ [dev][tester][watch] │
└──────────────────────┘  └──────────────────────┘
```

Card click opens a drawer:

- roster table: member, duty, mode, dir, status, current Thread; observers
  marked with an eye icon;
- `Ask orchestrator` uses the **exact orchestrator address** from `/api/teams`
  when it is online, otherwise the qualified team address `to: <team>@<host>`
  (never a bare team name, which could resolve to a same-named local team);
- `Open channel` (navigates to the Feed filtered to the channel).

Empty state explains how to create a team (`.cafe` + `cafe team start`) and
links the README section.

### 6.2 Channel switching is global

- The Feed route gains `channel` (`#/feed?channel=<name>`); `parseRoute` and
  `hashFor` keep it through every navigate (filters included).
- Feed top bar: channel chips (`default` + every channel with Threads or a
  team). The composer always shows its destination (`→ #myproj-dev`); clicking
  it switches.
- The store keeps Threads **per selected channel**: a channel change resets the
  list and re-snapshots; `loadOlder` and search pass the channel. No cross-channel
  merge.
- Server-side filters: `/api/snapshot?channel=`, `/api/threads?channel=`,
  `/api/search?channel=`. Absent means all channels (old clients keep working).
- `threads` gets a `channel` column (migration: add, backfill `default`, index)
  so filtering does not scan JSON or rely on the 200-Thread snapshot.
- Switching to an empty channel says "no Threads in this channel"; it is never a
  silent blank caused by the snapshot cap.
- Copy must not imply privacy: channels are scopes, not ACLs.

### 6.3 Sub-Threads

A Thread with `parentThreadId` is shown in the team channel and linked from the
parent Thread page ("2 open clarifications"); it is not mixed into the parent
Thread's replies. The customer-facing Thread stays clean.

## 7. Migration and compatibility

- Old `.cafe` (no `team`) → plain identity, unchanged.
- Old client → no team fields; `default` traffic only; `parentOrderId` keeps its
  old meaning; explicit addressing can still reach it.
- Old daemon + new client → registration drops team fields; the client warns and
  refuses member mode. An old daemon also strips `channel`/`collect`/`escalate`
  from `order/create`; the client detects the daemon's feature set before
  sending and refuses a non-legacy request with a clear error. **Feature
  negotiation:** `initialize` (daemon and agent) and `GET /api/health` advertise
  `features: ["teams","channels","escalate","collect"]`. A new child whose Root
  lacks `channels` routes locally instead of asking that Root to route a channel
  Order. A mixed-version team is not silently downgraded: the request fails
  before an Order exists.
- Old orders/Threads without `channel` → `default`.
- `ThreadMeta.channel` is written on new Threads; the `threads` table adds a
  channel column with a backfill.
- Old Web build without channels keeps working (`absent = all`).

## 8. Failure semantics

Placement matters for tests and for users:

| Code | Where it appears | When |
|---|---|---|
| `thread_busy` | RpcError code | A follow-up on a Thread with an open Order; message keeps `cancel` / `replace`. |
| `channel_mismatch` | RpcError code | A follow-up names a channel different from its Thread. |
| `unknown_parent` | RpcError code | `escalate: true` without a resolvable parent Order, or a `parentThreadId` that disagrees. |
| `not_a_target` | RpcError code | A registered caller that did not receive the parent Order tries to escalate it. |
| `parent_offline` | `RoutingDecision.failure` + `order.failed.reason` | An escalation's parent sender is not an online barista. |
| `unknown_team` / `team_offline` / `ambiguous_team` | `RoutingDecision.failure` + `order.failed.reason` | `to:` names a team that is unknown, known but offline, or ambiguous. |
| `ambiguous_address` | `RoutingDecision.failure` + `order.failed.reason` | A bare member name matches more than one team. |
| `no_channel_members` | `RoutingDecision.failure` + `order.failed.reason` | The Order's channel has no eligible barista. |

No failure may silently turn into a broadcast. `cafe ask`, the pi tool and the
Web show the code and a translated reason; they no longer print only
"no barista available". `excluded_by_chain` stays only as a `whyNot` explanation
for explicit addresses that resolve to a chain-excluded agent; it is not a
failure code of its own.

## 9. Acceptance criteria

1. A `.cafe` with a five-member dev roster: `cafe team start` starts the missing
   headless members (each with its own cwd and identity), detects TUI members
   already registered, is idempotent, and `team stop` leaves TUI members
   running. Members in sibling worktrees find the roster through `--team-dir`.
2. Routing in channel `myproj-dev` never selects an agent whose `channels` omit
   it; a `default` broadcast never reaches the team; explicit `to: dev1` from
   another channel works.
3. `escalate: true` creates a sub-Thread in the parent's channel and reaches its
   parent's sender; with the parent offline it fails `parent_offline` and is
   never broadcast to strangers; with an unresolvable parent it fails
   `unknown_parent` at create time.
4. `collect: all` with two targets answering 4 s apart keeps the Thread open
   until both land; `any` still closes 2 s after the first final; deadline skips
   are `declined{skipped}` and `ThreadMeta.targetStates` names the silent member.
5. A clarification sub-Thread appears linked to its parent and does not change
   the parent Thread's replies, turn count or `history`; the parent Thread can
   still take a customer follow-up.
6. An observer receives channel digests (not per-Order deliveries), is never a
   routing target, can send a fresh explicit Order to the orchestrator and post
   to `default`; a digest is sent at most once per interval per channel, carries
   a `digestId`, and is `partial: true` when the Root is offline.
7. Web: Teams cards (including remote teams and offline members), roster drawer,
   channel chips, `#/feed?channel=` filtering with `loadOlder`/search scoped to
   the channel, and an explicit empty state.
8. An old `.cafe`, an old client, and Orders without team fields behave as
   today; an old client's `parentOrderId` does not escalate; `routing:eval`
   shows the team cases moving from `blocked` to passing.

## 10. Phases

| Phase | Content | Wire |
|---|---|---|
| **A** | Escalation: `escalate` + sub-Thread + parent resolution + `parent_offline`/`unknown_parent`; explicit addressing bypasses the chain; channel inherited. No general-router fallback. | `escalate`, `parentThreadId`, `RoutingDecision.failure` |
| **B** | `channel` + `duty` on identity; `channel` on Order/ThreadMeta; channel filter; home-channel default; `collect: all` + `targetStates`; CLI `--channel`/`--collect`; store channel column. | Optional fields |
| **C** | `.cafe` team block (protocol schema + validation); roster `team/upsert`; `/api/teams`; supervisor members with per-member cwd; `cafe team start/status/stop`; `--member` / `--team-dir`; `/cafe-team`. | Identity + team records |
| **D** | Observer digests, `channel/digest`, channel history API with `after`, CLI `cafe channel`. | New notification + endpoints |
| **E** | Web Teams page, drawer, global channel chips, per-channel store, server-side filtering, sub-Thread links. | HTTP params |

Each phase: update README / README_zh / SKILL / this spec / handoff, add
`routing:eval` cases, and run the full verification baseline.

## 11. v1 boundaries (after the second review)

These are deliberate, tested boundaries rather than silent gaps:

- **Observer placement:** an observer runs on the Root or on the team's Host. A
  third-Host observer does not receive digests in v1 (the daemon cannot relay a
  digest there without a dedicated delivery contract).
- **Remote team metrics:** `/api/teams` returns `partial: true` and local-only
  counts when the Root is offline. Never invent a remote "4/5 online".
- **Remote sub-Thread links:** the Root sees every Thread and serves the link
  list; a child's Web proxies to the Root when online and otherwise shows only
  local links.
- **Roster identity:** a roster is keyed by `(host, team)`; two teams with the
  same name on different hosts are distinct for `to: <team>@<host>`, and a bare
  `to: <team>` prefers the sender's host. A roster revision prevents a stale
  publisher from overwriting a newer one.
- **Headless presence:** an online foreground member counts as present; a worker
  in restart backoff is owned. `team start` upserts the selected member into the
  saved supervised subset; a second `team start` never duplicates it.
- **Mixed versions:** fail before creating an Order when the daemon lacks the
  feature (`escalate`/`channel`/`collect`), rather than silently downgrading.
- **Restart:** `collect: all` deadlines are re-armed from `createdAt + deadline`;
  an `any` grace window is not restored (it is a short-lived optimization).
  `targetStates` is derived from actual dispatch and terminal events, so a
  restart cannot relabel a silent target as answered.

## 12. Non-goals

- No DAG, task graph, worktree management, branch or merge policy (D4).
- No concurrent Orders in one Thread; parallelism is sub-Threads or one
  multicast with `collect: all`.
- No per-team `TOP_K` / depth override.
- Escalation reaches the direct parent only; deeper escalation is a later change.
- Channels are not ACLs; no per-channel authorization.
- One team per `.cafe`; a second team is a second directory/worktree.
- No automatic clock/monitor agent; an observer is a member the user starts.
- A remote observer gets digests assembled from what the Root can see; a child
  digest while the Root is down is explicitly `partial`.