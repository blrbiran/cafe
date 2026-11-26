# v4-13 — Team sessions (the team has one front door)

**Status:** draft for review, 2026-11-26.
**Supersedes:** the team-routing parts of `v4-11-agent-teams.md` (roster/channel primitives stay;
`to: <team>` semantics change).
**Depends on:** v4-11 (teams/channels/escalate/collect), v4-12 (feature negotiation).

## 1. Intent

v4-11 shipped the protocol pieces of a team: a `.cafe` roster, channels, `to: <team>`,
`collect: all`, `escalate`, observer digests. What it did not ship is a team that behaves like
one. Three things are wrong for a person actually running a team:

1. **A message in a team channel is a broadcast.** Every member is woken and every member's
   context grows. The person usually wants the team's lead, not five agents.
2. **`to: <team>` is a multicast.** A worker that asks "the team" a question wakes everyone;
   the lead is not a front door, just one of the targets.
3. **Nothing tells an agent it is in a team.** A generic Claude/pi worker does not know the
   roster, its duty, how to assign, how to report, or when to escalate. The primitives are
   inert without a playbook.

v4-13 makes the team a **session with one front door**: exactly one orchestrator, a channel
whose default recipient is that orchestrator, explicit assignments, and a playbook delivered
to every member. Cafe still does not own a task graph, a workspace model, or git merges.

## 2. Goals

- A team always has exactly one **orchestrator**; it is structural, not an optional duty.
- `to: <team>` and a fresh message in a team channel reach the orchestrator, not everyone.
- Reaching everyone requires an explicit `broadcast: true`.
- Every member knows its duty, its teammates, the channel, and how to assign/report/escalate.
- Roster changes (add/remove/re-duty) reach online members without waking them into a turn.
- A follow-up never falls back to the rules/LLM router when the people who answered are gone.
- Sub-threads are the task tree; the Web shows parent ↔ children and per-target state.
- Mixed releases fail honestly: fields the old daemon cannot honour are refused before an
  Order is created.

## 3. Non-goals

- No task graph / DAG, no retries, no dependency model, no merge integration (D4/D6).
- No workspace/branch model; cafe never runs `git`.
- No permission model. Channels remain scopes, not ACLs (D7).
- No hot role switching inside one process; duty follows the process (third-round finding).
- No new `urgency` field in v1 (see §9.4).

## 4. Anti-goals

- A default broadcast inside a team channel.
- A "team run" object that duplicates what Threads already are.
- Silently degrading `escalate` into a normal Order.
- Guessing which of two same-named teams a bare name means.

## 5. Approaches considered

| Approach | What it is | Why not |
|---|---|---|
| **Minimal patch** | Fix #108/#111/#112/#113, add a duty lexicon, keep broadcast/follow-up semantics | Does not fix the two causes of context amplification (channel broadcast, follow-up fan-out). The team still feels like a room of agents. |
| **Team session (chosen)** | One orchestrator; channel front door; explicit assignments; playbook; roster pushes; sub-thread tree | Fixes the actual pain without a task engine. Smallest protocol surface that makes the team usable. |
| **Built-in orchestrator** | The daemon splits tasks, assigns, retries, collects | Re-introduces the DAG/dependency/failure questions D4/D6 assigned to orca; large and fragile. |

## 6. The model

A team is a `.cafe` roster with **exactly one orchestrator**:

```yaml
name: shop
team:
  name: shop
  channel: shop
  members:
    - { name: orch,  duty: orchestrator, mode: tui,      dir: . }
    - { name: dev1,  duty: developer,    dir: ../wt/dev1 }
    - { name: tester,duty: tester,       dir: ../wt/tester }
```

Validation (`readCafeFile`):

- exactly one member with `duty: orchestrator`; 0 or >1 → hard error naming the problem;
- member names unique; a member name may not equal the team name;
- `team.channel` is not `default`; every member's `channels` includes it;
- an observer may not be the orchestrator.

A team declared in `.cafe` is **authoritative**: its roster does not grow from live
registrations. A team with no `.cafe` roster (ad-hoc `team`/`teamChannel` registrations) is
**loose**: it still appears in `cafe agents`/Teams, but it cannot be addressed as a team
(`to: <team>` → `no_orchestrator`) until it has an authoritative roster.

## 7. Routing

Resolution order for a fresh Order:

1. `escalate` → the v4-11 escalation path (unchanged).
2. Follow-up (`threadId` + a previous Order) → §8.
3. `to: <address|member>` → the named agent.
4. `to: <team>` → that team's orchestrator.
5. `to: <duty>` → the unique eligible member with that duty.
6. `broadcast: true` → every eligible member of the channel.
7. A team channel with no `to:` → its orchestrator.
8. Otherwise → the existing rules/LLM router.

| Caller intent | Write |
|---|---|
| Talk to the team | `to: <team>`, or no `to:` in the team channel |
| Assign one member | `to: <member>` |
| Ask whoever owns a duty | `to: <duty>` (unique online member; `ambiguous_duty` lists names) |
| Wake everyone | `broadcast: true` (and `collect: all` if you need every answer) |

`to: <team>` failures:

| Situation | Failure |
|---|---|
| no team with that name | `unknown_team` |
| several same-named teams and the sender's Host has none | `ambiguous_team` |
| the roster has no orchestrator | `no_orchestrator` |
| the orchestrator is offline | `team_offline` |
| the orchestrator record disappeared between two reads | `team_offline` (never `TypeError`) |

A **busy** orchestrator is not offline: the Order queues behind its current turn (the client's
own queue), so a busy team still accepts work.

`to: <duty>`:

- member/address match wins; a team name wins over a duty; a duty is considered only when
  neither matched (`.cafe` rejects a member name equal to its team name, but a network-wide
  collision is still possible and resolves to the agent/team);
- duty matching is case-insensitive and trimmed; member/team names are exact;
- `duty@host` filters to that Host;
- no member has the duty → `unknown_duty`; members have it but none are online →
  `no_online_barista` naming the duty; more than one online member → `ambiguous_duty` with
  their names.

Team channel default recipient (only for a **fresh, non-broadcast, no-`to:`** Order):

- exactly one team owns the channel → its orchestrator;
- more than one team owns the channel → `ambiguous_channel` (a configuration warning is also
  logged and shown in `/api/channels`);
- no team owns the channel → the normal router.

`ambiguous_channel` never applies to a follow-up (which uses §8), a `broadcast: true` (which
uses the whole channel), or an explicit `to:`. Those are not "the channel’s default".

`broadcast: true` remains explicit and unchanged: all eligible members, never observers.

## 8. Follow-up

A follow-up is an Order with `threadId` where the Thread already has a previous Order.

Targets, in order:

1. the **immediately preceding Order's final responders** — `ThreadMeta.replies` is reset at
   every new turn and only final replies are stored (`daemon.ts:2841-2882`), so this is already
   a per-turn set, not history; filter to currently eligible agents;
2. if none: the immediately preceding Order's targets — `ThreadMeta.targetStates` is reset at
   every turn and holds that Order's targets; fall back to `ThreadMeta.targets` only for old
   Threads with no `targetStates` (that field is cumulative);
3. if none: fail with `responders_offline` (new code).

**A follow-up never falls through to the rules/LLM router.** An explicit `to:` or
`broadcast: true` overrides all three; `to:` may name an agent, team, or duty (with the same
`unknown_team`/`unknown_duty` failures as a fresh Order). This is the fix for the
"clarification broadcast to an unrelated agent" failure; the current code already uses only the
previous turn's replies, so the change is the no-router fallback plus an honest failure code
and the per-turn target fallback.

## 9. Context delivery

### 9.1 `teamContext` at registration

When an Agent registers with `team`, the `agent/register` **result** carries:

```ts
type TeamContext = {
  team: string;
  channel: string;
  revision?: number;
  self: { name: string; duty?: string; mode: "headless" | "tui" };
  orchestrator: string;
  roster: Array<{ name: string; duty?: string; online: boolean }>;
  playbook: string;
};
```

The stored/broadcast `AgentRecord` does **not** carry it (no registry bloat). The client
stores it on `CafeClient.teamContext` and exposes `onTeamContext`. Clients deliver it once per
process, before the first Order: pi injects a non-trigger system note; the Claude session-host
prepends it to the first Order's text; `cafe serve` prepends it to the first command prompt.
`cafe team context` prints the same text for debugging.

### 9.2 Playbook

A short, static template rendered with the roster (kept in `packages/protocol/src/team.ts`,
so every client renders the same words). It states:

- who you are (`member`, `duty`, team, channel) and who the orchestrator is;
- if you are the orchestrator: split, assign one member at a time with `to:`, pass the
  received `parentOrderId`/`parentThreadId` so assignments form a sub-thread tree, use
  `collect: all` only when every answer is needed, report to the asker, never broadcast;
- if you are a member: do the work, reply to the Order, keep reports short (what changed,
  where, what is blocked), escalate to the asker (`escalate: true`) for decisions;
- `to: <team>` is the orchestrator, not everyone; `broadcast: true` is the only way to reach
  the team; the roster may change and `cafe team status` is authoritative before a big
  assignment; channels are scopes, not privacy boundaries.

### 9.3 `team/roster` updates

New daemon → agent notification:

```ts
type TeamRosterUpdate = {
  team: string;
  channel: string;
  revision: number;
  members: Array<{ name: string; duty?: string; online: boolean }>;
  change: { added: string[]; removed: string[]; updated: string[] };
  removedTeam?: boolean;
};
```

- Sent when `storeTeam` accepts a **changed** roster (content hash differs) and on
  `team/remove`.
- Sent to local members only; the existing `team/upsert` propagation makes each daemon notify
  its own local members, so nobody receives it twice.
- The registering agent is skipped (it just received `teamContext`).
- `revision <= last seen` is ignored. `last seen` is **process-local**: it starts from the
  revision in the registration result and resets on every reconnect (the register result is the
  authoritative catch-up), so a daemon restart that restarts its sequence cannot wedge a client.
- Clients inject a short system note (pi) or prepend it to the next Order (Claude/serve); it
  never creates an Order and never triggers a turn.
- A removed team notifies its members with `removedTeam: true`; clients drop the team context.

### 9.4 No `urgency` field in v1

The two routing rules (§7, §8) remove the daemon-enforced causes of amplification. What
remains is "a direct assignment or report", which should be processed. If dogfooding shows the
orchestrator is still woken too often by reports, a later version adds `urgency:
now|next|digest`; do not add it speculatively.

Event text injected into a session (not the task body) is capped at ~160 chars with the thread
id, matching the list-view summary.

## 10. Roster lifecycle

- `publishRoster` always publishes the **full** `.cafe` roster (the server already reads the
  file; the CLI's member selection only chooses who to start).
- `TeamRecord` gains `authoritative?: boolean`, `contentHash?: string`, `removed?: boolean`.
  - `authoritative` = the roster came from `.cafe`; `teams()` does not add registry records to
    an authoritative roster. This fixes a removed member reappearing while its process runs.
  - `contentHash` makes a re-publish of identical content a no-op: no revision bump, no push.
  - `removed` is a **tombstone**: members are empty, `revision` is newer than the record it
    replaces, and `teams()`/`resolveTeamTarget`/`storeTeam` treat it as absent. `teams.json`
    keeps it, so a restart does not forget the deletion.
- `learnTeam` merge rules (fixes the resurrection path the review found):
  - a readable, matching `.cafe` roster → members from the file, `authoritative: true`;
  - a record that is already authoritative but whose `.cafe` is unreadable (the Root hearing a
    child registration, a sibling worktree) → **keep** the stored members and the
    `authoritative` flag; do **not** add the registering member if it is not in the roster;
  - a record that is not authoritative → keep the previous members and add the registering
    member (the v4-11 ad-hoc behaviour);
  - a tombstoned record → ignore the registration (log once); only `publishRoster`/`team start`
    clears the tombstone.
- `teams()` skips registry derivation for `authoritative` and `removed` records.
- `cafe team start` always republishes the full roster (so editing `.cafe` then starting one
  member syncs everyone). `cafe team sync` does the same without starting any process.
  `publishRoster` clears `removed` and sets `authoritative: true`.
- `cafe team stop` stops workers and keeps the roster; members become offline, not removed.
- `cafe team remove <team>` writes the tombstone. It refuses while a member is online; run
  `cafe team stop` first. Convergence:
  - the daemon that handles the call stores the tombstone and notifies its local members with
    `removedTeam: true`;
  - a child sends `team/upsert` with the tombstone to the Root; the Root stores it and
    re-broadcasts to the other children; each child stores it and notifies its local members;
  - the existing revision guard makes a delayed `team/upsert` from before the deletion lose;
  - Root offline → the child keeps the tombstone locally and publishes it on reconnect (the
    existing "republish this Host's rosters" path sends `removed` records too);
  - `Methods.teamRemove` is implemented as the same operation for callers that use the named
    method; the wire carries a tombstone `team/upsert` so older code that only understands
    `team/upsert` converges as well.
- `forgetHost` already drops that Host's rosters; add a regression test.
- Two teams on one channel: log a warning once per channel, expose `conflict: true` on
  `/api/channels`, show it in `cafe channel list` and the Web.
- Revision durability: revisions are wall-clock based (existing behaviour). The tombstone uses
  `max(now, current.revision + 1)`, so a restart keeps it winning over queued older upserts;
  a genuinely newer roster (a person re-running `team start`) restores the team.

## 11. Protocol changes

| Change | Detail |
|---|---|
| `FEATURES` | add `"team-sessions"`; `teams` keeps its v4-11 meaning (roster/channel fields) |
| `TeamRecord` | `authoritative?`, `contentHash?`, `removed?` (tombstone) |
| `TeamContext` | new type; `agent/register` result may carry it |
| `TeamRosterUpdate` | new type |
| `Methods.teamRoster` | `"team/roster"` |
| `Methods.teamRemove` | implemented (was a name only) |
| `SubOrderFailure` | add `no_orchestrator`, `ambiguous_duty`, `unknown_duty`, `ambiguous_channel`, `responders_offline` |
| `CafeClient` | `teamContext`, `onTeamContext`, `onRoster`; hard reject (§12); digest `since` dedupe |

## 12. Capability negotiation

A Daemon that does not advertise `team-sessions` (including a 0.1.5/0.1.6 `teams` daemon)
would silently multicast `to: <team>`, drop team semantics, or route a follow-up to the
router. Clients therefore reject **before creating an Order**:

| Requested | Requires | On a daemon without it |
|---|---|---|
| `escalate: true` | `escalate` | `unsupported_capability` |
| non-default `channel` | `channels` | `unsupported_capability` |
| `to: <team>` (own team or a known team name) | `team-sessions` | `unsupported_capability` |
| team identity (`identity.team`) | `team-sessions` | refuse registration |
| `collect: "all"` | `collect` | `unsupported_capability` |
| `duty` | — | warn only (routing quality) |

Client mechanics:

- `CafeClient` checks `supports(feature)`; `undefined` (an old daemon that advertises
  nothing) counts as unsupported for `escalate`/`collect`/`team-sessions`. `channels` may be
  proven by the registration echo (`identity.channels` echoed back).
- CLI/MCP check `GET /api/health.features` (or `CafeClient.features`) before sending; the CLI
  exits non-zero with the upgrade hint.
- Web checks `snapshot.features`; a missing capability shows an error instead of a form.
- A `to:` that is neither the caller's team nor a known team name is left to the daemon; the
  client cannot distinguish an agent named `shop` from team `shop`. This is the honest
  boundary.
- The **new daemon cannot enforce this for an old daemon**: it supports the fields, so it has
  nothing to refuse. The check belongs to the side that knows the peer is old. `cafe ask` and
  MCP are HTTP clients of the local daemon and therefore check `/api/health.features`; the Web
  checks `snapshot.features`; `CafeClient` checks the `initialize` advertisement. A third-party
  client talking straight to an old daemon is outside our control (documented).
- The registration result is `AgentRecord & { teamContext?: TeamContext }`. An old daemon
  returns the bare `AgentRecord`; a new client treats a missing `teamContext` as "this daemon
  is not team-session capable" and does not inject a playbook.

## 13. Surfaces

### CLI

- `cafe team start/status/stop` unchanged, plus validation of the orchestrator.
- `cafe team sync` — publish the roster, start nothing.
- `cafe team context` — print the playbook for the current member.
- `cafe team remove <team>` — remove the roster (refuses while online).
- `cafe thread show` — a `targets:` line with `replied/declined/skipped/failed/pending`.
- `cafe channel list` — mark a channel used by more than one team.
- Failure copy for `no_orchestrator`/`ambiguous_duty`/`responders_offline`/`ambiguous_channel`.

### MCP / pi

- `cafe_ask` gains nothing; it uses the same client checks.
- The pi extension handles `onTeamContext`/`onRoster` with non-trigger notes.
- A `cafe_team` read-only tool (`status`) is optional; `cafe team status` via the existing
  tool surface is enough for v1.

### Web

- Feed composer in a team channel defaults to `to: <orchestrator>` and shows it; the target
  picker lists the roster.
- Conversation page: a "clarifications" block listing child Threads (`parentThreadId`), with
  open/closed state; a child page links back to its parent; a `targets` block for
  `targetStates` (silent members highlighted).
- Teams page: orchestrator badge, revision, conflict marker.
- `/api/threads?parent=<threadId>` and `/api/channels` `conflict` field.

## 14. Digests (#109)

- Publish condition: `isRoot || !rootOnline`. Root online → Root publishes the complete
  network digest for every observer; Root offline → each child publishes its own
  `partial: true` digest. A child that takes over sets its channel cursor to `now`, so it does
  not replay everything it saw while the Root was publishing.
- `digestId` becomes a string `${host}:${seq}`; cross-daemon ids never collide.
- Client dedupe: ignore a repeated `digestId`, and ignore an identical `(channel, since)` from
  the same publisher. **Do not** ignore a different publisher's overlapping window: after a
  Root↔child handover the two windows can overlap, and a repeated Thread summary is harmless
  (a digest is an observation, not an Order). This avoids dropping a child's takeover digest.
- The client's `seenDigests`/`seenSince` are per connection; a reconnect starts empty, and the
  publisher's first post-reconnect digest is accepted.

## 15. Migration and versioning

- No legacy rosters exist (owner, 2026-11-26): a roster with 0 or >1 orchestrators is a hard
  error; there is no multicast fallback.
- New feature flag `team-sessions` is required for the new semantics. An old daemon keeps its
  v4-11 multicast behaviour; a new client refuses to use team features against it.
- Suggested release: **0.2.0** (breaking team routing semantics).
- `cafe doctor` reports the daemon's `team-sessions` support and whether the local `.cafe`
  roster has exactly one orchestrator.

## 16. Acceptance criteria

1. `.cafe` with 0 or 2 orchestrators fails `cafe team start/status/sync` with a message naming
   the problem; a valid roster starts.
2. `to: <team>` reaches exactly the orchestrator; the orchestrator offline → `team_offline`;
   no orchestrator → `no_orchestrator`; `broadcast: true` still reaches every eligible member.
3. A fresh message in a team channel with no `to:` reaches the orchestrator; two teams on the
   channel → `ambiguous_channel`.
4. `to: <duty>` reaches the unique online member; two → `ambiguous_duty` with names.
5. A follow-up with no eligible responder/target fails `responders_offline`; it is never
   routed by rules/LLM. A follow-up with a responder reaches only that responder.
6. A member's `agent/register` result contains `teamContext` (playbook + roster + orchestrator);
   a fresh registration is the only delivery needed.
7. Adding/removing a member in `.cafe` + `cafe team sync` updates `/api/teams`, bumps the
   revision once, and sends one `team/roster` note to each online member; identical content
   sends nothing. A removed member does not reappear from a live registration.
8. `cafe team remove` refuses while a member is online; after `team stop` it removes the
   roster from `/api/teams`, `teams.json`, and other hosts.
9. Two teams on one channel log one warning and appear as a conflict in `/api/channels`.
10. A protocol-1 fake daemon (no `team-sessions`) makes the client refuse `to: <team>`,
    `escalate`, `collect: all`, a non-default channel, and team identity before creating an
    Order; `duty` only warns.
11. #114: `/api/threads`, `/api/snapshot`, `/api/threads/:id` return `channel: "default"` for
    pre-channel Threads.
12. #107: Codex TUI candidates are de-duplicated by id.
13. #111: `cafe thread show` and the Web show each target's state, including `skipped`.
14. #112: a parent Thread page lists its child Threads; a child links back.
15. #109: Root online → one digest per channel per interval with `partial` absent; Root
    offline → one `partial` digest; ids are `host:seq`; a replayed older digest is ignored.
16. `npm run typecheck`, `npm test`, `npm run routing:eval`, `npm run build:web`,
    `npm run test:release`, `npm run test:claude-plugin` all pass.

## 17. Test plan

- `tests/cafe-team.test.ts` / `team-roster.test.ts`: orchestrator validation, full-roster
  publish, content hash, authoritative removal, `team/remove`.
- `tests/team-sessions.test.ts` (new): `to: <team>`, channel front door, `broadcast`, duty,
  follow-up failure, `team/roster` delivery, `teamContext`.
- `tests/capabilities.test.ts`: `team-sessions` advertisement and the hard-reject matrix with
  a protocol-1 fake daemon.
- `tests/observer-digest.test.ts`: Root/child publisher switch, `since` dedupe, id shape.
- `tests/store.test.ts`: #114 default channel reads.
- `tests/codex-tui.test.ts`: #107 dedupe.
- Web tests: sub-thread list, target states, composer default target, i18n keys.

## 18. Honest boundaries

- Claude session-host cannot inject a silent system note; it prepends `teamContext` and roster
  deltas to the next Order. Between a roster change and the next Order, the session's view is
  stale; the playbook says `cafe team status` is authoritative before a big assignment.
- A new client talking to a pre-v4-12 daemon cannot prove `channels` from the feature list;
  the registration echo covers an Agent with `channels`, not a human CLI. The CLI/Web health
  probe covers the human path.
- `to:` resolution for a name that is both an agent and a team prefers the agent; `.cafe`
  validation prevents a member name equal to its team name, but a network-wide collision is
  still possible.
- A remote old daemon in an otherwise upgraded network can still receive Orders for its local
  agents; the new fields are on the Order from the originating daemon, so delivery works. The
  risk is routing decisions made *on* the old daemon for its own agents; registry filtering
  keeps team-scoped agents off its routing table.
- The orchestrator is one process; concurrent human tasks queue behind its current turn. That
  is the accepted cost of one front door. A **busy** orchestrator still accepts Orders; only an
  offline one produces `team_offline`.
- A bare `to: <name>` resolves member/address → team → duty. If an agent on the network has the
  same bare name as a duty (`to: developer`), the agent wins; there is no separate duty syntax.
  `.cafe` prevents the common case (a member name equal to its own team name) and the playbook
  tells the orchestrator to address members by name.
- The digest handover can repeat one Thread summary in the interval around a Root↔child
  switch. The Feed/Thread list is the source of truth; the digest is an observation.
- A third-party client that talks straight to an old daemon can still get old semantics; only
  the clients shipped in this repo perform the feature checks.
- `teams.json` is the durable store for rosters **and tombstones**. Removing the file forgets
  deletions; a `.cafe` on a Host can republish a team after a `team start`/`team sync`.

## 19. Implementation batches

A. Quick correctness: #114, #107, #111, #112.
B. Team correctness: #108, #113, authoritative roster, content hash.
C. Team session core: feature flag, `.cafe` validation, routing, follow-up, teamContext,
   team/roster, team/remove, digests.
D. Surfaces: CLI, MCP/pi, Web.
E. Verification, docs, handoff.