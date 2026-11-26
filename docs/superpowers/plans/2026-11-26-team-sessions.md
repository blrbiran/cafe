# v4-13 team sessions — implementation plan (2026-11-26)

Spec: `docs/specs/v4-13-team-sessions.md` (reviewed by an independent subagent; the review's
five must-fix items are folded in). Land in batches; each batch is typechecked and tested
before the next.

## Batch A — quick correctness

1. **#114 channel default on reads** (`packages/daemon/src/store.ts`)
   - `getThread`, `listThreads`, `listThreadsIn`, `listThreadsInByActivity`, `openThreads`:
     return `{ ...parsed, channel: parsed.channel ?? "default" }`.
   - Test: `tests/store.test.ts` / `tests/store-channel.test.ts` — a pre-channel meta read
     through all four paths is `"default"`.

2. **#107 Codex TUI candidate dedupe** (`packages/cli/src/bridge/codex-tui.ts`)
   - `candidates()`: de-duplicate by `id` before sort/slice; keep the newest row per id.
   - Test: `tests/codex-tui.test.ts` — a `thread/list` response with duplicate rows yields
     one entry per id and does not lose a unique session.

3. **#112 parent/sub-thread API + Web**
   - `GET /api/threads?parent=<threadId>` (`server.ts`), backed by
     `store.listThreadsByParent(parent, limit)` (SQL on a new `parent_thread_id` column with a
     migration; fallback to a meta scan for old rows).
   - `ThreadMeta.parentThreadId` already exists.
   - Web: `ConversationPage` fetches children via `api.children(threadId)`; renders a
     "clarifications" block with open/closed state; a child page links to its parent.
   - Tests: `tests/threads-parent.test.ts`; Web build.

4. **#111 targetStates display**
   - `cafe thread show`: print a `targets:` line from `meta.targetStates`
     (`replied / declined / skipped / failed / pending`).
   - Web `ConversationPage`: a targets block using `meta.targetStates`; silent members
     highlighted; old Threads without it render nothing.
   - Test: `tests/collect-all.test.ts` asserts the CLI formatter; Web build.

## Batch B — team correctness

5. **#108 roster key includes the channel + authoritative/removed**
   - Key: `${host}/${team}/${channel}` (`storeTeam`, `learnTeam`, `publishRoster`, `teams`,
     `forgetHost`, startup load).
   - `resolveTeamTarget` prefers the sender's Host, then a team sharing the sender's channel;
     otherwise `ambiguous_team`.
   - Registry/member lookup includes `teamChannel`.
   - Tests: `tests/team-roster.test.ts` — two same-host same-name teams with different
     channels are two records; `to: dup` with no preference is `ambiguous_team`; with the
     sender's channel it resolves the right one.

6. **#113 team/remove + channel conflict**
   - Tombstone (`removed: true`) as in the spec; `DELETE /api/teams?team=&host=` with a 409
     when a member is online; propagate via `team/upsert`; implement `Methods.teamRemove` as
     the same operation.
   - `cafe team remove <team>`.
   - `storeTeam` logs one warning per channel when >1 team uses it; `channels()` adds
     `conflict: true`; `cafe channel list` marks it.
   - Tests: `tests/team-roster.test.ts` (remove survives restart and a stale upsert),
     `tests/teams-api.test.ts` (channels conflict), CLI test.

## Batch C — team session core

7. **Protocol** (`packages/protocol/src/index.ts`, `version.ts`)
   - `team-sessions` feature; `TeamRecord` fields; failure codes; `TeamContext`,
     `TeamRosterUpdate`, `renderTeamPlaybook`; `Methods.teamRoster`; `ChannelDigest.digestId`
     accepts string or number.
8. **`.cafe` validation** (`cafeFile.ts`)
   - exactly one orchestrator; member name != team name; observer may not be orchestrator.
   - Update every test roster to include one orchestrator.
9. **Routing** (`daemon.ts`)
   - `to: <team>` → orchestrator only (`team_offline` / `no_orchestrator`).
   - `to: <duty>` after agent/team; case-insensitive; `@host` filters; `ambiguous_duty`,
     `unknown_duty`, `no_online_barista`.
   - team channel default recipient for fresh, non-broadcast, no-`to:` Orders;
     `ambiguous_channel`.
   - follow-up: previous turn's final responders → previous turn's targetStates targets →
     `responders_offline`; never the router; explicit `to:` wins.
10. **teamContext + roster**
    - `agent/register` result carries `teamContext` (rendered from the local `.cafe` when
      readable, else the authoritative replicated roster; no context for a loose team).
    - `learnTeam` merge rules from the spec (preserve authoritative; ignore tombstoned
      registrations; do not add unknown members to an authoritative roster).
    - `publishRoster`: full roster, content hash, clears tombstone.
    - `storeTeam`: content hash no-op; notify local members `team/roster` with added/removed/
      updated; Root/child propagation through `team/upsert`.
    - `teams()`: skip registry derivation for authoritative/removed.
11. **Client** (`client.ts`)
    - store the register result's `teamContext`; `onTeamContext`, `onRoster`; reset on open.
    - hard reject `escalate`/`collect`/non-default `channel`/team identity/`to: own team`
      per the spec.
    - digest dedupe by id and `(channel, since)`.
12. **Digests** (`daemon.ts`)
    - `isRoot || !rootOnline` publisher; child takeover cursor = now;
    - `digestId` `${host}:${seq}`.

## Batch D — surfaces

13. **CLI** (`main.ts`)
    - `cafe team sync`, `cafe team context`, `cafe team remove`.
    - `team start/status` validate the orchestrator.
    - hard-reject helper using `/api/health.features`; `cafe ask` uses it for channel/collect/
      escalate/team target; exit non-zero.
    - `cafe thread show` targets line; `cafe channel list` conflict marker.
14. **MCP** (`mcp.ts`)
    - hard reject the same fields before POST; keep the warning for `duty` only.
15. **pi + session-host**
    - pi: `onTeamContext`/`onRoster` → `pi.sendMessage(..., { triggerTurn: false })`.
    - session-host: prepend `teamContext` and pending roster notes to the first/next Order;
      no extra turn.
    - `cafe serve`: prepend the playbook to the first command prompt.
16. **Web**
    - store: `teams`, `features`; composer default target in a team channel; target picker
      lists the roster.
    - Conversation: parent/children, targetStates.
    - Teams page: orchestrator badge, revision, conflict.
    - i18n zh/en keys.

## Batch E — verification + docs

17. `npm run typecheck`; `npm test` twice; `npm run routing:eval`; `npm run build:web`;
    `npm run test:release`; `npm run test:claude-plugin`.
18. Update `docs/handoff/handoff.md` and the ledger statuses (#107/#108/#109/#110/#111/#112/
    #113/#114/#71).
19. Commit per batch; push to origin main.

## Test updates required by the new invariants

- Every `.cafe` roster in `tests/` must have exactly one orchestrator (the hard validation is
  intentional).
- `tests/teams-api.test.ts` "falls back to online members when the orchestrator is offline"
  becomes `team_offline`.
- `tests/capabilities.test.ts` warnings for channel/collect/escalate become rejections (the
  fake daemon advertises nothing); keep the "decision proves escalate" case as a positive.
- `tests/team-roster.test.ts` rosters gain an orchestrator; add authoritative/removal/
  tombstone cases.
- `tests/observer-digest.test.ts` adds the Root/child publisher switch and string ids.