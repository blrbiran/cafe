# v4-12 — Feature advertisement and mixed-release behaviour

Status: draft rev 3 (2026-11-26), after an independent review against v4-11 §7 and the tagged v0.1.5
build. Scope: a client or Daemon must notice that a peer predates v4-11 instead of silently changing
the meaning of `channel`, `escalate`, `collect: all`, observer registration or team identity.
Not in scope: a protocol version bump, remote upgrades, ACLs.

## 1. The problem

`PROTOCOL_VERSION` stays 1, so 0.1.5 and a v4-11 build connect. The old side parses new fields with
a schema that does not declare them (zod drops them):

- `POST /api/orders` → `CreateOrderParams.parse` (`packages/daemon/src/server.ts:817`)
- WS `agent/register` → `AgentIdentity.parse` (`packages/daemon/src/daemon.ts:802`)

What changes without an error:

| Caller sends | Old daemon does | Consequence |
|---|---|---|
| `channel: "dev"` | drops it, routes in `default` | the question reaches Baristas outside `dev` |
| `escalate: true` + `parentOrderId` | drops `escalate`, keeps legacy provenance | the clarification becomes a fresh routed ask; rules can broadcast it |
| `collect: "all"` | drops it | first answer + grace closes the Thread |
| `observer: true` | drops it | the observer becomes a routable Barista |
| `team`/`duty`/`channels` | drops them | a team member lands in `default` as an ordinary Barista |

`order/relay` between Daemons passes the Order through as JSON; an old receiver does not re-parse it.
The strip hazard is the two parse points above, plus **routing**: an old Daemon that receives a new
Agent's registry record does not know `observer` or `channels`, so it can *select* that Agent for an
Order even though the new Agent registered correctly on its own Host.

v4-11 §7 already named the idea (`features: ["teams","channels","escalate","collect"]` on
`initialize` and `/api/health`, client refuses a non-legacy request). This spec implements it and
**supersedes the refusal policy**: the owner decided on 2026-11-26 to warn and continue for order
semantics, because the old behaviour is a graceful degradation. It keeps two hard refusals:
observer registration (when the Daemon is confirmed incapable) and team writes (there is no old
behaviour for `/api/teams`).

## 2. Decisions

D1. **Vocabulary and wire fields.** `packages/protocol/src/version.ts` exports
    `FEATURES = ["teams","channels","escalate","collect","digests"]`, `CURRENT_FEATURES`,
    `Feature`, `missingFeatures(have, need)`. The field is `features` (v4-11 §7's name):
    - `InitializeParams.features?: string[]`, and every `initialize` result gains
      `features: string[]`.
    - `DaemonRecord.features?: string[]` (the Root learns each child's list at handshake).
    - `GET /api/health` gains `features` and, on a child, `rootFeatures?: string[]`.
    - `GET /api/snapshot` gains `features` (the Web discovers its serving Daemon in the same call).
    - `GET /api/teams` items gain `rosterShared?: boolean` (see D8).
    No nested objects; a flat list keeps old parsers intact.

D2. **An absent list means "support unconfirmed", not "unsupported".** The release tagged 0.1.5
    already contains v4-11 code but does not advertise features; treating absence as incapable would
    falsely warn against the owner's own build. Detection order:
    1. `features` present → authoritative.
    2. For identity, compare the `agent/register` echo: an old Daemon strips `observer`, `team`,
       `channels`; a v4-11 Daemon echoes them.
    3. For team commands, `GET /api/teams` (v4-11 has it; older has 404).
    4. Otherwise warn "support unconfirmed" and describe the observed outcome — never claim a field
       was ignored unless the probe proved it.

D3. **Warn and continue for order semantics (owner decision).**

| Caller sends | Capability | Absent/confirmed-incapable | Behaviour |
|---|---|---|---|
| plain ask / reply / follow-up | — | — | unchanged |
| `channel` | `channels` | **warn** | routed in the old scope; say "may have ignored the channel" when unconfirmed |
| `escalate` | `escalate` | **warn** | "sent as a normal question, not to the parent"; the decision's mode/targets are named |
| `collect: "all"` | `collect` | **warn** | "first answer wins on that Daemon" |
| `parentThreadId` without `escalate` | — | — | a legacy lookup; an unknown parent is a loud `unknown_parent` |
| `team`/`teamChannel`/`member`/`teamDir`/`duty` | `teams` (+`channels`) | **warn** | identity registered without the team/channel; plain Barista |
| `observer: true` | `digests` | **refuse** when the list is present and lacks it; otherwise register, compare the echo, and close immediately + refuse if stripped | an observer that becomes routable receives Orders it should never see |
| `cafe team start|status|stop` | `teams` | **fail before any write** | no old behaviour; preflight `GET /api/teams` then features |
| `to: <team>` | `teams` | **warn** when the CLI knows the name is a team in the local `.cafe` | an old Daemon treats it as an agent name and fails `no_online_barista` |
| channel history `/api/channels/...` | `channels` | **fail with the feature hint** (404 is loud already) | |

D4. **A warning must reach the caller, on the transport it uses.**
    - CLI `cafe ask`: one `warning:` line on stderr before following; `--json` output carries
      `warnings: string[]` (the SSE follower does not replace the creation response).
    - MCP: reads `GET /api/health` (HTTP, not `CafeClient`) once per process, prepends a warning
      line to the `cafe_ask` result.
    - pi: uses `CafeClient`; the warning is prepended to both the non-wait and wait tool results.
      A registration warning/refusal is shown with `ctx.ui.notify` at session start.
    - Claude session-host: logs the warning; the hook surfaces it (a `warning` message) so the
      person is not left with a generic "session-host is not running".
    - Web: a banner (D9); the Teams page says "Teams unavailable" when the endpoint is absent.
    A log line alone does not satisfy this decision.

D5. **Registry publication is filtered per peer.** This is the network-level protection the
    registration check cannot give:
    - Never publish an Agent with `observer: true` to a peer that does not advertise `digests`.
    - Never publish an Agent whose `channelsOf()` does not include `default` to a peer that does not
      advertise `channels`.
    Apply to `registry/sync` (child→Root), `registry/snapshot` and `registryDelta` (Root→child), and
    `registry/upsert`. An incapable peer therefore never learns of an observer or a channel-only
    member, so its `eligible()` cannot select one. The cost is stated: during rollout those Agents
    (and their Teams rows) are absent from an old Host's view; the Root's own view still has them.
    A new peer always receives everything.

D6. **The Root's routing fallback is skipped when it would change channel semantics.** A child with
    `router.fallback: "root"` asks the Root to decide only when the Root advertises `channels`; for
    a non-default channel or an escalation it routes locally instead (the candidate list is already
    channel-filtered locally, so the decision is safe; only duty/hint quality is lower). A plain
    default-channel ask still delegates. The child logs one line when it routes locally for this
    reason.

D7. **Team writes preflight before touching a worker.** `cafe team start` and `cafe team stop`
    fetch `GET /api/health`, then `GET /api/teams` when `features` is absent; on failure they exit
    non-zero and send **no** POST/DELETE. Rationale: a tagged v0.1.5 Daemon handles
    `DELETE /api/baristas?team=1&member=…` as a plain `stop(dir)` and would stop unrelated workers.

D8. **Roster sharing is visible, not inferred.** `features` on the Root is exposed as
    `rootFeatures` in health and as `rosterShared` on each `/api/teams` item (`true` when this Host
    is the Root or the Root advertises `teams`). A child whose Root does not advertise `teams`
    skips `team/upsert`, logs once, and `cafe team status` says "roster not shared with the Root";
    the digest-style `partial` flag stays about Thread metrics only. A roster learned while the Root
    was offline is published on reconnect when the Root advertises `teams`.

D9. **The Web has an explicit legacy view.** When the snapshot has no `features`:
    - the store forces `channel = "default"` and stops sending `?channel` on snapshot, search,
      paging and create-order requests (an old Daemon ignores it, but a URL-selected label would
      otherwise lie);
    - the channel chips are replaced by a banner ("the running daemon does not support channels;
      restart it after upgrading");
    - the Teams page shows "Teams unavailable" on a 404/absent endpoint, not an empty roster.
    A new bundle against an old API is rare (the Daemon serves its own bundle), so this is a
    degraded view, not a second UI.

D10. **Hints name host, version, feature and fallback.** Warning text:
    `daemon <host> (cafe <version or "unknown">) does not advertise <feature>; <observed fallback>.
    If that Host already runs a newer cafe, restart it there (cafe daemon restart); otherwise
    upgrade cafe on it first.` For a local CLI/MCP process that is itself newer than the Daemon,
    also mention restarting the CLI/MCP process when it caches the connection.

D11. **No protocol bump.** `protocolVersion` stays 1; old peers keep working. A future feature that
    cannot degrade safely may bump the protocol then.

## 3. Operation matrix (what a caller must check)

| Operation | Feature | When absent/unconfirmed |
|---|---|---|
| `POST /api/orders` with `channel` | channels | warn (D3) |
| `POST /api/orders` with `escalate` | escalate | warn (D3) |
| `POST /api/orders` with `collect: all` | collect | warn (D3) |
| `POST /api/orders` `to: <team>` | teams | warn if the name is a team in `.cafe` |
| `agent/register` with `observer` | digests | probe echo; refuse if stripped |
| `agent/register` with team/channels/duty | teams + channels | warn |
| `cafe team *` / `POST|DELETE /api/baristas` team writes | teams | fail before write |
| `/api/channels/*`, `cafe channel *` | channels | fail with the hint |
| `/api/teams` (Web) | teams | "Teams unavailable" |
| observer record publication | digests | filtered out (D5) |
| non-default-channel record publication | channels | filtered out (D5) |
| Root `route/decide` delegation | channels | route locally for channel/escalate (D6) |

## 4. Tests

- `tests/capabilities.test.ts`: new Daemon advertises the list in `initialize`, `/api/health`,
  `/api/snapshot`, `/api/daemons`; a v4-11-style daemon with no list is "unconfirmed", not told it
  dropped fields; the registration echo detects stripped `observer`/`team`.
- `tests/capability-warnings.test.ts`: fake old daemon (no features) → warnings for channel,
  escalate, collect, team identity; observer registered then immediately closed and refused;
  a daemon advertising features without `channels` → the same warnings without a probe.
- `tests/capability-registry.test.ts`: a new Root with a fake old child (initialize without
  features) → the child's snapshot/deltas omit observers and non-default-channel agents; a new
  child never publishes an observer to a fake old Root.
- `tests/capability-cli.test.ts`: `cafe ask --channel` warns and still creates; `--json` has
  `warnings`; `cafe team start/stop` against an old daemon exits non-zero and sends no POST/DELETE.
- `tests/capability-doctor.test.ts`: the running daemon is older than the CLI → one warn line with
  host/version/feature and the restart hint.
- Web: snapshot without `features` forces the legacy view (store test) and the banner copy is
  asserted in zh/en.
- Root routing: a child with an incapable Root routes a channel order locally.

## 5. Non-goals

- No remote upgrade or auto-restart.
- No repeated warning on every request; a client may cache one per connection, but the first is
  visible.
- No change to routing/escalation/channel/team semantics themselves.
- No old-client gate: an old client never sends new fields.

## 6. Calls made in this revision

1. `features` (v4-11's name) not `capabilities`; list extended with `digests`.
2. Absence = unconfirmed, with probes; not "unsupported".
3. Registry filtering per peer (D5) — the review's P1.
4. Team writes preflight `GET /api/teams`, not only `features` (D7) — the review's P1.
5. Root fallback routes locally only for channel/escalate (D6).
6. Web legacy view forces `default` (D9).
7. Observer: pre-send refusal when confirmed incapable; echo-probe + immediate close when absent.

## 7. Verification

`npm run typecheck`; `npm test` twice; `npm run routing:eval`; `npm run build:web`;
`npm run test:release`; `npm run test:claude-plugin` (the session-host/hook changed). Restart the
local Root; check `/api/health.features`, `/api/snapshot.features`, `cafe doctor`, and that the Web
still shows channels.