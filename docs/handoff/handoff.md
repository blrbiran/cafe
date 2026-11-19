# cafe — handoff

Read this document first if you are taking over cafe. It records what exists, why it is that way, how to run and test it, what is waiting on the user, and the traps already found. Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md). Architecture decisions are in [`docs/adr/`](../adr/). Feature specs (v2-x done, v3-1 phase 1 done, v3-2 done) are in [`docs/specs/`](../specs/). Usage is in [`README.md`](../../README.md) and [`skills/cafe/SKILL.md`](../../skills/cafe/SKILL.md).

> Git state: this file is updated at the end of each work batch and committed with it, so check `git log --oneline` and `git status` yourself instead of trusting any hash written here. The v2 work starts after `docs: add handoff document for the next agent`. Published npm versions: `npm view @blrbiran/cafe versions`.

## 1. What cafe is

cafe is an agent network. A message (an **Order**) is routed to the agent or agents best placed to answer it (**Baristas**). The design borrows from DNS.

- Each machine (**Host**) runs one **Daemon**. One of them is the **Root Daemon**, shown as "中心节点 / Hub" in the UI.
- The Root holds the authoritative **Registry** of all agents and replicates it to every Daemon.
- The Daemon where an Order starts makes the **Routing Decision**:
  - When `router.model` is set, a pi-SDK LLM decides; otherwise keyword rules decide (CJK text is split into bigrams).
  - Recent declines are a **weak hint** (`router.learn`, default on): they only reorder Baristas that tie on the description. See `docs/specs/v2-1-routing-hints.md`.
  - An explicit address skips routing (`--to`). A **Follow-up** goes to whoever already answered in that Thread.
- While the Root is online, every Order goes through it (ADR-0001), so the Root's web UI shows all traffic. **While the Root is offline, cross-host Orders go over a direct Daemon-to-Daemon link** and are backfilled to the Root when it returns (ADR-0004).
- On a LAN a Daemon without `root` finds the Root over mDNS. `cafe daemon install` gives autostart (launchd / systemd --user).
- Daemons exchange their cafe version in `initialize`: a different `PROTOCOL_VERSION` is refused with `protocol_mismatch` and an upgrade hint; a different cafe version on the same protocol only warns (`cafe daemon status`, Network page). Published as the npm package `@blrbiran/cafe` (command `cafe`).
- Ways to be a Barista: pi with the cafe extension (TUI or headless `pi --mode rpc`, supervised by the Daemon); the same extension inside **oh-my-pi** (`--agent omp`); **native Codex / Claude Code** (`cafe barista start --agent codex|claude`, a **Bridge** process supervised by the Daemon, read-only by default, follow-ups continue the same Codex thread / Claude session; ADR-0005); `cafe serve --exec/--preset claude|codex` for any prompt-in / answer-out command (no session).
- Ways to be a Customer: any agent, **`cafe mcp`** (MCP stdio server: `cafe_agents`, `cafe_ask`, `cafe_wait`, `cafe_cancel`; `cafe mcp install` registers it with Claude Code / Codex), the `cafe` CLI plus skill, or the web UI.
- A Thread holds several turns. A Barista can decline ("不归我管"); operational declines (timeout, abort, shutdown, command failure) carry `unavailable` and do not count against a topic. An acknowledged Order has no overall timeout, because heartbeats keep it alive.

## 2. Code map

npm workspaces, TypeScript run directly by Node ≥ 22.18 (type stripping, no build step except for the web UI).

| Path | What it does |
|---|---|
| `packages/protocol/src/index.ts` | zod wire types: Order, ThreadEvent, ThreadMeta, AgentRecord (v3-2 display fields `agent` / `access` / `command`, plain optional strings), RoutingDecision (`demoted`, `llmError`), RoutingHint, ClientKind (`agent/daemon/ui/peer`), the method list (incl. `agent/session/get|set`, local A→D only) |
| `packages/protocol/src/peer.ts` | Symmetric RPC over a socket (codex app-server style, no `jsonrpc` field) |
| `packages/protocol/src/version.ts` | Dependency-free `PROTOCOL_VERSION`, `DEFAULT_PORT`, `onlineVersions()` — the web UI imports only this (`@cafe/protocol/version`), never the zod index |
| `packages/protocol/src/client.ts` | `CafeClient`: register (resumes agentId), `onOrder`, `onCancel`, `ask`, `keepAlive`, `decline(reason, {unavailable})`, `getSession` / `setSession`; reconnect handles `error` and `close`, waits at most 5 s for a local daemon, 30 s for a remote one |
| `packages/daemon/src/daemon.ts` | Core: Root/child modes, Registry replication, Order lifecycle, follow-ups, `recover()`, Root relay/fan-out, routing hints (record/compute/push), **direct links + backfill**, prune/search |
| `packages/daemon/src/hints.ts` | Tokenizer (CJK bigrams), order keywords, time-decayed decline topics, penalty (< 1) |
| `packages/daemon/src/router.ts` | `RulesRouter` (description score, then idle bonus − history penalty), `LlmRouter` (weak-hint lines), `piComplete()` |
| `packages/daemon/src/discovery.ts` | mDNS advertise (Root) / discover (`multicast-dns`) |
| `packages/daemon/src/store.ts` | SQLite: thread metadata, registry cache, `agent_events` (+ `identity`, `tokens`), `agent_sessions` (Bridge Thread → Codex thread / Claude session, keyed by kind + Barista dir + Thread), `kv` (peerUrls, backfill, rootHost); prune helpers. Thread contents are JSONL under `~/.cafe/sessions/<date>/` (ADR-0003) |
| `packages/daemon/src/server.ts` | One port (4777): HTTP API, `/ws`, static web UI. New: `/api/routing/hints`, `/api/search`, `/api/prune`, `/api/threads?before=` |
| `packages/daemon/src/supervisor.ts`, `proc/` | Headless workers under a guard that dies with the Daemon; per-Barista `bin` (pi / omp) or `agent` (codex / claude → `node <defaultCliBin()> barista run`), `access`, `model` |
| `packages/daemon/src/index.ts` | `runDaemon()`, lock, discovery start/stop |
| `packages/cli/src/main.ts` | The `cafe` command. New: `stats`, `search`, `prune`, `root discover`, `daemon install/uninstall`, `barista start --agent`, `pi-extension-path`, `--version`. `daemon start` (and the pi extension's auto-start) goes through launchd/systemd when autostart is installed for this `CAFE_HOME` |
| `packages/cli/src/service.ts` | launchd plist / systemd unit generation and (un)install; `servicePath()` drops temp and per-terminal shim dirs (cmux) from the service PATH; `startInstalledService()` |
| `scripts/build-release.mjs` | esbuild → `release/` (publishable package `@blrbiran/cafe`), see `docs/specs/v2-7-publishing.md` |
| `scripts/test-release.mjs` | `npm run test:release`: pack, install into a temp prefix, smoke-test the installed `cafe` (no model; includes `cafe mcp` and a supervised Codex Barista on the fake app-server). Run before every publish |
| `scripts/sim-hosts.sh` | Three local Daemons (Root + 2 children) running the section 6 failure cases without a model; run before a real multi-machine test |
| `packages/cli/src/serve.ts` | `cafe serve`; `buildPrompt` / `buildFollowup` / `DECLINE_MARKER` are shared with the Bridges |
| `packages/cli/src/bridge/` | v3-1 Bridges: `barista.ts` (register, queue one turn at a time, cancel, decline, session mapping via the Daemon), `codex.ts` (`codex app-server` client, `refuseServerRequest()`), `claude.ts` (`claude -p` per turn, `claudeArgs()`), `engine.ts` (types). Run as `cafe barista run --agent …` |
| `packages/cli/src/mcp.ts` | `cafe mcp`: hand-written JSON-RPC 2.0 over stdio (no MCP SDK); `mcpInstallCommands()` |
| `packages/pi-extension/src/index.ts` | pi extension; also runs under oh-my-pi (`isOmp()`), see below |
| `packages/web/` | React 19 + Vite 6 + Tailwind v4; zh/en; single store with `useSyncExternalStore`; feed has "load older" and full-text search |
| `skills/cafe/SKILL.md` | Skill for Claude Code / Codex / pi; `cafe skill install` symlinks it |
| `tests/` | vitest, **91 tests**: e2e, follow-up/recovery, pi extension (incl. omp mode) against a fake pi, serve, supervisor, routing hints, routing eval, direct links, discovery (real multicast), service files, retention/search, client reconnect while the daemon stays down, versions across Daemons and protocol mismatch, **Bridges** (`bridge.test.ts`, fakes `fixtures/fake-codex.mjs` / `fake-claude.mjs`), **MCP** (`mcp.test.ts`) |

**pi extension behaviour**
- Orders queue (FIFO), are acked and heartbeated on arrival, and are injected only when idle with `sendMessage({customType:"cafe-order"}, {triggerTurn, deliverAs:"followUp"})`.
- The reply is the last assistant text after that message's `message_end` and before the next human message.
- Run end: `agent_settled` on pi; on omp the `agent_end` without `willContinue` (abort read from the last assistant `stopReason`).
- System prompt: pi `systemPromptOptions.sections.cafe`; omp returns `{systemPrompt: [...]}`.
- Watchdog `CAFE_INJECT_TIMEOUT_MS` (120 s) declines as `unavailable`. Cancel drops a queued Order or `ctx.abort()`s a running one.
- Tools: `cafe_ask`, `cafe_agents`, `cafe_reply`, `cafe_decline`.

## 3. Run / verify

```bash
npm install
npm run typecheck          # use the npm script, NOT `npx tsc` (see traps)
npm test                   # vitest; all 91 must pass (run twice: earlier flakes were unhandled rejections)
npm run check --workspace @cafe/web && npm run build:web
npm run test:release       # only when packaging/paths changed; ~1 min, no model
node packages/cli/bin/cafe.js daemon start --root     # or `npm link --workspace @cafe/cli` then `cafe ...`
open http://127.0.0.1:4777/
```

Scratch home for experiments (never touch the user's `~/.cafe`); turn discovery off so it does not answer on the LAN:

```bash
export CAFE_HOME=$(mktemp -d); printf 'port: 47821\nhost: test\nmode: root\ndiscovery: false\n' > $CAFE_HOME/config.yml
```

Tests run with `CAFE_DISCOVERY=0` (vitest.config.ts); `tests/discovery.test.ts` opts back in on a private service name.

Real checks done so far: Network-page version banner checked in a browser (Root 0.1.1 + child started with version 0.1.0); pi TUI (tmux) and headless; `claude -p` via `cafe serve --preset claude`; **omp 18.17.0 real Q&A** (headless answer, follow-up to the same Barista, Order shown in omp's TUI as `☕ Order from …`; ~$0.11); **`cafe daemon install` on the user's Mac** (launchd runs the Root now; `kill -9` → relaunched, `cafe daemon stop` → stays stopped, `cafe daemon start` → kickstarts the service, the pi TUI Barista reconnects); `scripts/sim-hosts.sh` all six steps pass; the packed `@blrbiran/cafe` tarball installed into a temp prefix passes a smoke test (web, serve, headless pi with the bundled extension, skill install, LLM router from the optional dependency); web UI for the routing-hint display checked in a browser against a scripted scenario. **v3-1 (no model cost):** the real `codex app-server` (codex-cli 0.170.0) driven through `CodexEngine` with the ccloop codex-qa mock Responses model and an isolated `CODEX_HOME`: fresh turn, follow-up, `thread/resume` in a new process, unknown thread → new thread, `turn/interrupt` (scripts were in the session scratchpad; recipe in `docs/specs/v3-1-native-codex-claude.md`). Real `claude` 2.1.327 accepts every flag the Bridge passes and prints `No conversation found with session ID` for a missing session. **Real-model Bridge Q&A (2026-11-19, approved):** Claude 2.1.327 (local login) and Codex 0.170.0 (the user's provider `group/smart`), each in a scratch `CAFE_HOME`: answer, follow-up continues the same session, cancel (no leftover process; the next question still works), an edit request refused in read-only mode (file hash unchanged). Codex also resumed its thread after a Barista restart; a Codex usage-limit error became an `unavailable` decline. `cafe mcp` over stdio answered `cafe_ask` + a follow-up from the Codex Barista; the user ran `cafe mcp install` and this Claude Code session loads the `cafe` tools (`cafe_agents` lists the user's `cafe#1`). v3-2 agent-kind tags checked in a browser (Agents page, conversation page). The user allows real-model tests with their pi model (`magpie/group/smart`), a few prompts each, but **every new paid run needs its own approval**.

## 4. Decisions you must not silently undo

- Terminology is fixed in `GLOSSARY.md`. Do not use "producer" or "consumer".
- ADR-0001: the Root relays every Order while online and does not re-route. ADR-0002: Registry replication, routing at the origin. ADR-0003: JSONL + SQLite. **ADR-0004: direct links only while the Root is offline**, backfill on return. **ADR-0005: Codex / Claude Baristas are Bridges; read-only by default, never full access; Claude uses the local login with `--setting-sources user` (`--bare` with an API key); session mapping lives in the Daemon.**
- Every running instance is its own Agent, including two in the same directory.
- Injected Orders start immediately. `accept: confirm` was **removed at the user's request**; do not bring it back. `followUp` (not `steer`, not omp `aside`).
- Routing: descriptions are primary. History is auxiliary: penalty < 1, never excludes, never beats a better description match, only declines count (no bonus for answering). Operational declines do not count against topics.
- Web UI: conversation-first, plain language, no protocol jargon, internals collapsed, zh/en; **prototype and get approval before UI changes**.
- Routing LLM: routing only; the Order text passes through unmodified; rules fallback must work without an LLM.
- Data safety: nothing is deleted automatically unless the user sets `retention.days`; `cafe prune` is a dry run unless `--yes`.

## 5. Waiting on the user (start the next session here)

Done and approved earlier: v2 defaults; Q60–Q70; omp real Q&A; `cafe daemon install` on the Mac; web load-older + search; **Q71 A (Network page versions) approved**; the user restarted their daemon. The user published 0.1.0 and 0.1.1 themselves. Q72–Q79 answered as recommended; Q80 = C (no side work, focus on v3-1).

Done on 2026-11-19 with the user: v3-1 reviewed (the extra `cafe_cancel` MCP tool approved); both paid Bridge runs done and passed (section 3); `cafe mcp install` run by the user and checked; daemon restarted. **v3-2** (`docs/specs/v3-2-agent-kind.md`, Q81–Q83 as recommended, prototype https://claude.ai/artifact/X3F3dx2PtBQf3R5HwsiRL5): Agents report which agent runs them; the web UI shows a kind tag (pi / oh-my-pi / Codex / Claude Code / 命令) on Agent cards and in conversations, "运行方式" says read-only / can edit files; `cafe agents` shows `codex·rw`, `claude·ro`, `pi·tui`. This also fixes the old label "后台 pi" shown for every headless Agent.

Waiting on the user:
1. **Restart the daemon** (`cafe daemon stop && cafe daemon start`) to load v3-2 (new web build); Baristas started before the restart show no tag until they reconnect.
2. **Publish 0.1.2**: `npm version 0.1.2` → `npm run test:release` → `npm publish ./release`. Machines on 0.1.0/0.1.1 show "未知（0.1.0 之前）" on the Network page and no kind tags until upgraded.
3. **Real two-machine test** (section 6), later.
4. Suggest `pi update` (local pi 1.5.0, extension targets 1.5.2). Reinstall autostart (`cafe daemon install`) after changing Node version or moving the repo; same for `cafe mcp install` (it registers absolute node + cafe.js paths).

## 6. Two-machine test (the user runs this)

1. **Root A**: `cafe daemon start --root`; `cafe config get token`; port 4777 reachable on the LAN/tailnet.
2. **B**: `npm i -g @blrbiran/cafe` (same version as A; or clone + `npm install && npm run build:web`); `cafe config set token <A's token>`; then either `cafe root set <A-ip>:4777` or, on the same LAN, just `cafe daemon start` and check `cafe root discover` / the log line `discovered root`.
3. On B start a Barista in a dir with `.cafe`: `cafe serve --preset claude --dir <dir>`, `cafe barista start --dir <dir>` or `--agent omp`.
4. On A's UI (`http://<A-ip>:4777/`, remote browsers need `?token=`): Network shows B online with its version (no banner if both run the same release); Agents shows B's Barista with "近 7 天" counts; `cafe ask` from A is answered by B and shows on both UIs; a follow-up goes back to the same Barista.
5. Failure cases:
   - **Stop A** with a third machine C (or two child daemons): a question from C to B's Barista still gets answered (direct link). Start A again: C reconnects and A's UI shows that conversation (backfill).
   - Stop A and B: a question from C fails with "中心节点和对方机器都连不上" (`root_unreachable`).
   - Change A's IP and restart A: A dials back `knownDaemons`; else `cafe root set <new-ip>:4777` on B.
   - Restart B's daemon mid-question: recovers or fails cleanly, no duplicate pi workers.
   - `cafe daemon install` on B, reboot or `kill -9` the daemon: it comes back; `cafe daemon stop` keeps it stopped.
6. Logs: `~/.cafe/daemon.log`, `~/.cafe/logs/barista-*.log`.

## 7. Backlog after v2

- Multi-level Daemon hierarchy (codex `parent`/AgentPath idea) — not started; only two levels exist.
- v3-1 phase 2: a running Codex / Claude TUI session as a Barista (Codex shared app-server daemon + `thread/queue/add`; Claude channels, research preview only).
- CI (GitHub Actions: typecheck, test, build:web, test:release) — suggested, not started.
- LAN security (token is plain text over HTTP/WS; TLS or tailnet-only) — needs a spec.
- SQLite FTS if `cafe search` gets slow (it scans JSONL files).
- Web: maybe a routing-quality view (eval numbers are only in `tests/routing-eval.test.ts` and `cafe stats`).

## 8. Traps already found

- **`npx tsc` is rewritten by the user's rtk hook** to an old global tsc. Use `npm run typecheck` or `node_modules/.bin/tsc`.
- `rm` and `cp` are aliased to interactive and hang or silently skip; use `/bin/rm -f`, `/bin/cp -f` for files you created.
- **Node 22's built-in WebSocket fires only `error` (no `close`) when a connection attempt fails**, and leaves no handle: a reconnect loop driven by `close` stops after one failure and a process with nothing else alive exits with code 0 (`cafe serve` did). `CafeClient` now handles `error` and `close` once each. The daemon uses the `ws` package, which always emits `close`.
- The shell's PATH contains per-terminal shims (`~/.cmuxterm/cmux-cli-shims/<id>/pi`); never bake those into a service file (`servicePath()` filters them).
- The web build is read into memory when the daemon starts: after `npm run build:web`, restart the daemon to see changes.
- Importing anything at runtime from `@cafe/protocol` (the index) in the web UI bundles zod (+60 kB); use `@cafe/protocol/version` or `import type`.
- `scripts/test-release.mjs` waits for the daemon to exit before deleting its temp dir; deleting earlier fails with ENOTEMPTY (headless workers still write logs).
- The user's Root daemon is now owned by launchd (`dev.cafe.daemon`): stop it with `cafe daemon stop`, not `kill` (launchd restarts it).
- **Restarting the user's daemon is pre-approved**: after a batch that changes the daemon or the web UI, run `cafe daemon stop && cafe daemon start` yourself (via `node packages/cli/bin/cafe.js` from the repo; it goes through launchd), check `cafe daemon status`, and say so. Do it after `npm version` too, or the daemon keeps reporting the old version. Running pi TUIs keep their old extension until pi restarts.
- User rules: never delete or overwrite user data without asking, show the diff/stat before committing, never force-push. Use a scratch `CAFE_HOME`.
- pnpm is not installed (npm workspaces). Never run two `npm install` at once (ENOTEMPTY).
- zsh does not word-split `$VAR` commands: wrap smoke tests in `bash -c` with `cafe(){ node packages/cli/bin/cafe.js "$@"; }`.
- `node:sqlite` prints an ExperimentalWarning; `bin/cafe.js` filters it.
- `erasableSyntaxOnly` is on: no TS parameter properties or enums.
- Daemon event ordering: fan-out happens **before** origin tracking in `recordEvent`; a follow-up captures who answered **before** emitting `order.created`.
- pi has no request ids: correlate through `details.order.orderId` on `message_end`.
- **A Root shutting down must not mark children's Agents offline**, and a child losing the Root keeps Agents on directly reachable hosts online; otherwise direct links never get used (both guarded now).
- Test daemons must not advertise on the real LAN: keep `CAFE_DISCOVERY=0` in vitest config.
- In test Barista handlers, catch rejections (`h.ack().catch(()=>{})`, wrap async handlers): closing a client rejects pending requests and vitest reports an unhandled error even when all tests pass.
- Under omp (Bun) `process.execPath` is the omp binary; the extension starts the daemon with `node` (`CAFE_NODE`).
- `.gitignore` contains `.cafe`; the repo-root `.cafe` is tracked anyway.
- Codex app-server wire values are kebab-case (`sandbox: "read-only" | "workspace-write"`, `approvalPolicy: "never"`); approval answers differ per method (`decline` for v2 item approvals, `denied` for legacy `applyPatchApproval` / `execCommandApproval`). Regenerate with `codex app-server generate-json-schema --experimental --out <dir>` after a Codex upgrade.
- Test a real Codex for free: `codex -c model_provider=… -c model_providers.mock_provider.base_url=http://127.0.0.1:<port>/v1 … app-server` with an isolated `CODEX_HOME` and the mock from ccloop `reference/oh-my-openagent/.agents/skills/codex-qa/scripts/lib/mock-model.mjs`; shasum `~/.codex/config.toml` before and after.
- Every Bridge prompt contains the `CAFE_DECLINE:` instruction: test fakes must look at the question line, not the whole prompt.
- Test Baristas that take longer than ~200 ms need `keepAlive(h, 50)` (FAST timing in `tests/helpers.ts` marks them lost).
- macOS has no `timeout` command.
- Reference repos: `sourceget find pi codex oh-my-pi`; oh-my-pi at `/Users/biran/code/skills/agent/oh-my-pi`; Orca web at `/Users/biran/code/skills/orca/Orca/web`; ccloop at `/Users/biran/code/skills/orca/ccloop`. Research them with subagents.

## 9. Working with this user

- They write in Chinese; answer in Chinese. They decide quickly when given numbered questions with a recommended answer (last used number: **Q83**; nothing open).
- New feature areas: go through the decisions first; small fixes go straight ahead. When they are away, follow the recommendations, keep going on what does not need them, and list the review items at the end.
- Commit when asked (or at the end of an away batch they asked to hand off), with a stat or diff shown first; messages end with the Co-Authored-By line.
- UI prototypes are Claude artifacts: v1 https://claude.ai/artifact/JQDywMh5YuYWsT7yaMXtSK, routing-history display https://claude.ai/artifact/JJit3GCxiQZUypYVWZFxFg (approved: Q51–Q53 as recommended), older threads + search https://claude.ai/artifact/ARjRg8XRAdsx44YSdYehvZ (approved: Q67–Q68 as recommended), versions https://claude.ai/artifact/SVLEJhirFrxq7ugMipjeiZ (Q71 A, implemented), agent kinds https://claude.ai/artifact/X3F3dx2PtBQf3R5HwsiRL5 (Q81–Q83 as recommended, implemented).
