# cafe — handoff

Read this document first if you are taking over cafe. It records what exists, why it is that way, how to run and test it, what is still open, and the traps already found. Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md). Architecture decisions are in [`docs/adr/`](../adr/). Usage is in [`README.md`](../../README.md) and [`skills/cafe/SKILL.md`](../../skills/cafe/SKILL.md).

> Git state: this document is committed together with the work it describes. Run `git log --oneline` for the history. The commit that adds this file is the newest commit in the handoff.

## 1. What cafe is

cafe is an agent network. A message (an **Order**) is routed to the agent or agents best placed to answer it (**Baristas**). The design borrows from DNS.

- Each machine (**Host**) runs one **Daemon**. One of them is the **Root Daemon**, shown as "中心节点 / Hub" in the UI.
- The Root holds the authoritative **Registry** of all agents and replicates it to every Daemon.
- The Daemon where an Order starts makes the **Routing Decision**:
  - When `router.model` is set, a pi-SDK LLM decides.
  - Otherwise keyword rules decide.
  - An explicit address skips routing (`--to`).
  - A **Follow-up** goes to whoever already answered in that Thread.
- While the Root is online, every Order goes through it, including Orders between agents on the same Host (ADR-0001). That is how the Root's web UI shows all traffic.
- Ways to be a Barista:
  - pi with the cafe extension, in a TUI or headless (`pi --mode rpc`, supervised by the Daemon)
  - `cafe serve --exec/--preset claude|codex`, which runs any prompt-in / answer-out command
- Ways to be a Customer: any agent, the `cafe` CLI plus skill (Claude Code / Codex), or the web UI.
- A Thread holds several turns. A Barista can decline ("不归我管"). An acknowledged Order has no overall timeout, because heartbeats keep it alive.

## 2. Code map

npm workspaces, TypeScript run directly by Node ≥ 22.18 (type stripping, no build step except for the web UI).

| Path | What it does |
|---|---|
| `packages/protocol/src/index.ts` | zod wire types: Order, ThreadEvent (`order.created/routed/delivered/acked/heartbeat/replied/declined/failed/cancelled/closed`), ThreadMeta, AgentRecord, the method list |
| `packages/protocol/src/peer.ts` | Symmetric RPC over a socket: requests carry `id+method`, notifications carry `method` only, there is no `jsonrpc` field (codex app-server style) |
| `packages/protocol/src/client.ts` | `CafeClient`, the agent-side connection: register (resumes its agentId on reconnect), `onOrder`, `onCancel`, `ask`, `keepAlive` |
| `packages/protocol/src/cafeFile.ts` | `.cafe` lookup, walking up from cwd |
| `packages/daemon/src/daemon.ts` | Core. Root/child modes, Registry replication, Order lifecycle (30 s ack timeout, heartbeats, unicast fallback candidates, broadcast deadline, depth/chain loop guard), follow-ups, `recover()` after a restart, Root relay and fan-out, cancel notification |
| `packages/daemon/src/router.ts` | `RulesRouter`, `LlmRouter`, `piComplete()` (pi SDK `createAgentSession`, reuses pi's auth) |
| `packages/daemon/src/store.ts` | SQLite (`node:sqlite`) for thread metadata, the registry cache and `agent_events` stats. Thread contents are JSONL files under `~/.cafe/sessions/<date>/<threadId>.jsonl` (ADR-0003) |
| `packages/daemon/src/server.ts` | One port (default 4777) serves the HTTP API, `/ws` and the static web UI. Loopback needs no token; LAN needs a token (Bearer or `?token=`) |
| `packages/daemon/src/supervisor.ts`, `proc/` | Headless pi workers: each runs under a guard (`proc/guard.mjs`, fd-3 parent watch) that dies with the Daemon. Stale process groups are reaped by pid plus start time. Logs are capped. Ported from ccloop |
| `packages/daemon/src/index.ts` | `runDaemon()`, single-instance lock (`daemon.lock`) |
| `packages/cli/src/main.ts` | The `cafe` command. It starts the Daemon automatically when needed |
| `packages/cli/src/serve.ts` | `cafe serve` |
| `packages/pi-extension/src/index.ts` | pi extension, described below |
| `packages/web/` | React 19 + Vite 6 + Tailwind v4 with Orca design tokens; `i18n.ts` (zh/en); single store using `useSyncExternalStore` (snapshot, then WS deltas) |
| `skills/cafe/SKILL.md` | Skill for Claude Code / Codex / pi; `cafe skill install` symlinks it |
| `tests/` | vitest, 42 tests: multi-daemon e2e, follow-up and recovery, pi extension against a fake pi, serve, supervisor |

**pi extension behaviour**
- Orders queue (FIFO). Each is acknowledged and heartbeated as soon as it arrives.
- An Order is injected only when pi is idle, using `sendMessage({customType:"cafe-order"}, {triggerTurn, deliverAs:"followUp"})`.
- The reply is the last assistant text after that message's `message_end` and before the next human message. This is what fixed the interleaving bug.
- Watchdog: an Order that pi never picks up is declined after `CAFE_INJECT_TIMEOUT_MS` (default 120 s).
- Cancel: a queued Order is dropped; a running Order is stopped with `ctx.abort()`.
- Tools: `cafe_ask` (non-blocking by default; takes `threadId` for follow-ups), `cafe_agents`, `cafe_reply`, `cafe_decline`.

## 3. Run / verify

```bash
npm install
npm run typecheck          # use the npm script, NOT `npx tsc` (see traps)
npm test                   # vitest; all 42 must pass
npm run check --workspace @cafe/web && npm run build:web
node packages/cli/bin/cafe.js daemon start --root     # or `npm link --workspace @cafe/cli` then `cafe ...`
open http://127.0.0.1:4777/
```

To experiment without touching the user's real `~/.cafe`, use a scratch home with its own port:

```bash
export CAFE_HOME=$(mktemp -d); printf 'port: 47821\nhost: test\nmode: root\n' > $CAFE_HOME/config.yml
```

Real model checks:
- Real pi checks have passed in a TUI (in tmux) and headless (`cafe barista start`).
- `claude -p` has passed via `cafe serve --preset claude`.
- The user allows real-model tests with their configured pi model (`magpie/group/smart`). Keep each to a few prompts.

## 4. Decisions you must not silently undo

- Terminology is fixed in `GLOSSARY.md`: Customer / Barista / Order / Reply / Notice / Thread / Follow-up / Daemon / Root Daemon / Registry / Address (`name#n@host`). Do not use "producer" or "consumer".
- ADR-0001: the Root relays every Order while it is online, for observability, and does not re-route. ADR-0002: Registry replication; routing happens on the Daemon where the Order starts. ADR-0003: JSONL threads plus SQLite metadata.
- Every running instance is its own Agent, including two in the same directory.
- Injected Orders start immediately. The `accept: confirm` option was **removed at the user's request**; do not bring it back. If a human is mid-turn in a TUI, the Order runs as a `followUp` after that turn. `steer` would interrupt the human and was offered but not chosen.
- Web UI principle, a strong user preference: conversation-first, understandable at a glance, plain language, never bury the key information.
  - No protocol jargon in the primary UI: no unicast, registry, ack, kick.
  - Internals such as the registry version appear only in the collapsed "调试信息" section.
  - zh/en switchable.
  - Before changing the UI, build a clickable prototype and get it approved.
- Routing LLM: routing only, the Order text passes through unmodified. The keyword-rules fallback must keep working without an LLM.

## 5. Two-machine test (the user will run this; not done yet)

Everything so far has been verified on one machine only: two Daemons on different ports, plus Root restart and `root set`. To test across machines:

1. **Root machine A**:
   - Run `cafe daemon start --root`.
   - Run `cafe config get token` and note the token.
   - Make sure port 4777 is reachable on the LAN or tailnet.
2. **Machine B**:
   - `git clone <cafe repo> && npm install && npm run build:web`
   - `cafe config set token <A's token>`
   - `cafe root set <A-ip>:4777`
   - `cafe daemon start`
3. On B, start a Barista in a directory that has a `.cafe`: `cafe serve --preset claude --dir <dir>` or `cafe barista start --dir <dir>`.
4. Check on A's web UI (`http://<A-ip>:4777/`):
   - The Network page shows B as online.
   - The Agents page shows B's Barista.
   - `cafe ask "..."` from A is answered by B, and the conversation shows on both A's and B's UI.
   - A follow-up (`cafe ask --thread <id> ...`) goes back to the same Barista.
5. Failure cases:
   - Stop A: on B, local questions still work, and cross-host questions fail with `root_unreachable`. Start A again: B reconnects by itself (exponential backoff) and re-syncs its agents.
   - **Change A's IP** and restart A: A dials back the Daemons in `knownDaemons` (POST `/api/root`). If that fails, run `cafe root set <new-ip>:4777` on B.
   - Restart B's daemon while a question is running there: the order recovers or fails cleanly, and no duplicate pi workers appear.
   - Opening A's UI from another machine needs `?token=<token>` in the URL.
6. Logs to check: `~/.cafe/daemon.log` and `~/.cafe/logs/barista-*.log`.

## 6. Next: v2 backlog (the user wants this done next session)

Suggested order. Each item is a user-visible decision, so confirm the shape with the user before building.

1. **Routing that learns from declines.** `agent_events` already records answered, declined and failed per agent. Feed recent outcomes into the router: demote agents that keep declining a topic, and add an eval or report showing how good routing is.
2. **Daemon-to-daemon direct connections (P2P).** The Registry already stores each Daemon's URL. ADR-0001 would need revisiting: the Root still wants to see the traffic. One option is to send the data directly and copy only the events to the Root.
3. **mDNS discovery on the LAN**, so a new machine finds the Root without `root set`.
4. **Autostart**: a launchd plist from something like `cafe daemon install`.
5. **Data retention**: prune old `sessions/` files and SQLite rows. There is no full-text search yet.
6. **oh-my-pi Barista adapter**: omp runs only on Bun, uses `.omp/` paths, and has `deliverAs: "aside"`. See the earlier research: `/Users/biran/code/skills/agent/oh-my-pi`.
7. **Publishable npm packages.** pi-extension → cli and supervisor → pi-extension use relative paths across packages (`../../cli/src/main.ts`, `../../pi-extension/src/index.ts`); these break once packages are published separately. There is also no build output.
8. Possible multi-level Daemon hierarchy. The `parent` / AgentPath idea from codex is not implemented; only two levels exist.

Smaller known gaps:
- A child Daemon shows the Root as host `"root"` until its first connection.
- When the LLM router fails and falls back to rules, the reason is only in the `reason` text.
- Web thread lists load at most 200 threads, with no "load older".
- `agent_events` has no retention.
- Local pi is 1.5.0 and the extension targets 1.5.2. That works so far; suggest `pi update` to the user.

## 7. Traps already found

- **`npx tsc` is rewritten by the user's rtk hook** to an old global tsc, which gives bogus errors. Use `npm run typecheck` or `node_modules/.bin/tsc`.
- `rm` is aliased to interactive in the user's shell and hangs a command. Use `/bin/rm -f` for files you created.
- The user's global rules: never delete or overwrite user data without asking, show the diff before committing, never force-push. Use a scratch `CAFE_HOME`, not `~/.cafe`, for experiments.
- pnpm is not installed, which is why this repo uses npm workspaces. Do not run two `npm install` at the same time (ENOTEMPTY).
- zsh does not word-split `$VAR` commands. Wrap multi-command smoke tests in `bash -c` with a `cafe(){ node packages/cli/bin/cafe.js "$@"; }` function.
- `node:sqlite` prints an ExperimentalWarning; `bin/cafe.js` filters it.
- `erasableSyntaxOnly` is on, so TS parameter properties and enums are not allowed.
- Daemon event ordering: fan-out happens **before** origin tracking in `recordEvent`, because tracking can emit `order.closed` synchronously. A follow-up must capture who answered **before** emitting `order.created`, because `updateMeta` resets `replies` for the new turn.
- pi has no request ids. Correlation goes through the custom message's `details.order.orderId` on `message_end`, not `agent_start`, because auto-retry runs omit the start message from `agent_end.messages`.
- `.gitignore` contains `.cafe`, which someone other than the agents added. The repo-root `.cafe` is tracked anyway; new `.cafe` files elsewhere will not be committed.
- Reference repos are found with `sourceget find pi codex oh-my-pi`. Orca web is at `/Users/biran/code/skills/orca/Orca/web` and ccloop at `/Users/biran/code/skills/orca/ccloop`. Research them with subagents.

## 8. Working with this user

- They write in Chinese; answer in Chinese. They make design calls quickly when given numbered questions, each with a recommended answer.
- For new feature areas, go through the decisions with them before building (the grill-with-docs style). Small fixes can go straight ahead.
- Commit when asked, with a stat or diff shown first. Commit messages end with the Co-Authored-By line.
- The UI prototype from the last session is a Claude artifact: https://claude.ai/artifact/JQDywMh5YuYWsT7yaMXtSK
