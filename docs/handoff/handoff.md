# cafe — handoff

Read this document first if you are taking over cafe. It records what exists, why it is that way, how to run and test it, what is waiting on the user, and the traps already found. Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md). Architecture decisions are in [`docs/adr/`](../adr/). Feature specs (v2-x, v3-1 phases 1 and 2, v3-2: all done) are in [`docs/specs/`](../specs/). Usage is in [`README.md`](../../README.md) and [`skills/cafe/SKILL.md`](../../skills/cafe/SKILL.md).

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
- Ways to be a Barista: pi with the cafe extension (TUI or headless `pi --mode rpc`, supervised by the Daemon); the same extension inside **oh-my-pi** (`--agent omp`); **native Codex / Claude Code** (`cafe barista start --agent codex|claude`, a **Bridge** process supervised by the Daemon, read-only by default, follow-ups continue the same Codex thread / Claude session; ADR-0005); `cafe serve --exec/--preset claude|codex` for any prompt-in / answer-out command (no session); **a running Claude Code session** (the cafe Claude Code plugin, a mod, installed with `cafe claude install`; ADR-0006) and **a running Codex session** (`cafe barista start --agent codex --tui`, Orders go into the session's queue; ADR-0006).
- Ways to be a Customer: any agent, **`cafe mcp`** (MCP stdio server: `cafe_agents`, `cafe_ask`, `cafe_wait`, `cafe_cancel`; `cafe mcp install` registers it with Claude Code / Codex), the `cafe` CLI plus skill, or the web UI.
- First use: `cafe init` writes a commented `.cafe` (interactive or `--yes --name …`), `cafe extension install` puts the extension into pi's settings and links it with omp, `cafe doctor` checks daemon / identity / extension / skill / router / root and prints the next command. `cafe config get` prints `(not set)` for unset known keys and fails for unknown ones.
- Display names: `cafe host rename|alias`, `cafe agent rename|alias`, `cafe daemon rename` (Root). Internal `host` / `agentId` / Address never change; old names become aliases (ADR-0007). `knownDaemons` is written only after the Root can reach the child (prevents Docker-internal IPs).
- Routing control: `cafe router models|set|status|apply`; `router.model` can be switched and cleared on a running daemon, unknown models are rejected and rolled back. `router.timeoutMs` (10 s) and `router.concurrency` (2) bound the LLM. `cafe daemon restart` applies restart-required config; `cafe config set` says whether a change was applied or needs a restart.
- A Thread holds several turns. A Barista can decline ("不归我管"); operational declines (timeout, abort, shutdown, command failure) carry `unavailable` and do not count against a topic. An acknowledged Order has no overall timeout, because heartbeats keep it alive.

## 2. Code map

npm workspaces, TypeScript run directly by Node ≥ 22.18 (type stripping, no build step except for the web UI).

| Path | What it does |
|---|---|
| `packages/protocol/src/index.ts` | zod wire types: Order, ThreadEvent, ThreadMeta (v3-2 display fields, `summaryTurn`), AgentRecord (`displayName`, `aliases`), DaemonRecord (`hostId`, `displayName`, `aliases`), RoutingDecision (`demoted`, `llmError`), RoutingHint, ClientKind (`agent/daemon/ui/peer`), the method list (incl. `agent/session/get|set`, `agent/rename`, `host/identity`) |
| `packages/protocol/src/peer.ts` | Symmetric RPC over a socket (codex app-server style, no `jsonrpc` field) |
| `packages/protocol/src/version.ts` | Dependency-free `PROTOCOL_VERSION`, `DEFAULT_PORT`, `onlineVersions()` — the web UI imports only this (`@cafe/protocol/version`), never the zod index |
| `packages/protocol/src/client.ts` | `CafeClient`: register (resumes agentId), `onOrder`, `onCancel`, `ask`, `keepAlive`, `decline(reason, {unavailable})`, `getSession` / `setSession`; reconnect handles `error` and `close`, waits at most 5 s for a local daemon, 30 s for a remote one |
| `packages/daemon/src/daemon.ts` | Core: Root/child modes, Registry replication, Order lifecycle, follow-ups, `recover()` (only unfinished threads), Root relay/fan-out, routing hints (record/compute/push), direct links + backfill, display names/aliases + remote rename, `knownDaemons` reachability probe, prune/search |
| `packages/daemon/src/hints.ts` | Tokenizer (CJK bigrams), order keywords, time-decayed decline topics, penalty (< 1) |
| `packages/daemon/src/router.ts` | `RulesRouter`, `LlmRouter` (weak hints, 10 s timeout, single-candidate short circuit, concurrency gate), `piComplete()` (reuses one ResourceLoader, aborts on timeout), `listRouterModels()` |
| `packages/daemon/src/discovery.ts` | mDNS advertise (Root) / discover (`multicast-dns`) |
| `packages/daemon/src/store.ts` | SQLite: thread metadata, registry cache (upsert instead of delete+insert), `agent_events` (+ `identity`, `tokens`), `agent_sessions`, `kv`. `readEventsTail` / `openThreads` for long Threads and recovery. Thread contents are JSONL under `~/.cafe/sessions/<date>/` (ADR-0003) |
| `packages/daemon/src/summary.ts` | Faithful list titles: word/sentence-boundary truncation with `…` |
| `packages/daemon/src/server.ts` | One port (4777): HTTP API, `/ws`, static web UI. New: `/api/host`, `/api/hosts/rename`, `/api/agents/rename`, structured `/api/reload` (`ok/router/model/error`) |
| `packages/daemon/src/supervisor.ts`, `proc/` | Headless workers under a guard that dies with the Daemon; per-Barista `bin` (pi / omp) or `agent` (codex / claude → `node <defaultCliBin()> barista run`), `access`, `model`, `tui` + `thread` (codex only; one worker whatever the concurrency) |
| `packages/daemon/src/index.ts` | `runDaemon()`, lock, discovery start/stop |
| `packages/cli/src/main.ts` | The `cafe` command. New: `init`, `doctor`, `extension install|status|uninstall`, `router models|set|status|apply`, `host rename|alias`, `agent rename|alias`, `daemon rename|restart`, `connect`, `root test`; help has a Quick start; unknown commands fail even with `--help` |
| `packages/cli/src/init.ts`, `doctor.ts`, `extension.ts`, `errors.ts` | Guided `.cafe` creation; health checks; pi/omp extension install/status; daemon API error formatting |
| `packages/cli/src/service.ts` | launchd plist / systemd unit generation and (un)install; `servicePath()` drops temp and per-terminal shim dirs (cmux) from the service PATH; `startInstalledService()` |
| `scripts/build-release.mjs` | esbuild → `release/` (publishable package `@blrbiran/cafe`), see `docs/specs/v2-7-publishing.md` |
| `scripts/test-release.mjs` | `npm run test:release`: pack, install into a temp prefix, smoke-test the installed `cafe` (no model; includes `cafe mcp` and a supervised Codex Barista on the fake app-server). Run before every publish |
| `scripts/sim-hosts.sh` | Three local Daemons (Root + 2 children) running the section 6 failure cases without a model; run before a real multi-machine test |
| `packages/cli/src/serve.ts` | `cafe serve`; `buildPrompt` / `buildFollowup` / `DECLINE_MARKER` are shared with the Bridges |
| `packages/cli/src/bridge/` | v3-1 Bridges: `barista.ts` (register, queue one turn at a time, cancel, decline, session mapping via the Daemon; `tui` option), `codex.ts` (`AppServer` stdio client, `CodexEngine`, `refuseServerRequest()`), `codex-tui.ts` (`CodexTuiEngine`: `thread/list` → `thread/queue/add` → poll `thread/turns/list`; withdraw with `thread/queue/delete`), `claude.ts` (`claude -p` per turn, `claudeArgs()`), `engine.ts` (types), `session-host.ts` (`cafe session-host`, hidden: the network side of a running Claude Code session; JSON lines on stdout, HTTP over a Unix socket back). Run as `cafe barista run --agent …` |
| `packages/cli/src/claude-plugin.ts` | `cafe claude install|uninstall`: writes `CAFE_HOME/claude-marketplace` (plugin copy + `cafe.json` with absolute node + cafe.js) and runs `claude plugin marketplace add` + `claude plugin install cafe@cafe-local` |
| `claude-plugin/` | The cafe Claude Code plugin (not an npm workspace, not in the root tsconfig): `hooks/register.ts` (the mod: spawns `cafe session-host`, `$.prompt.submit`, matches `turn.start` by `[cafe order <id>]`, answers from `turn.complete`, `$.turn.abort`, `/cafe on|off`), `tests/register.test.ts` (`npm run test:claude-plugin`). Shipped in the release package |
| `packages/cli/src/mcp.ts` | `cafe mcp`: hand-written JSON-RPC 2.0 over stdio (no MCP SDK); `mcpInstallCommands()` |
| `packages/pi-extension/src/index.ts` | pi extension; also runs under oh-my-pi (`isOmp()`), see below |
| `packages/web/` | React 19 + Vite 6 + Tailwind v4; zh/en; single store with `useSyncExternalStore`; feed has "load older" and full-text search |
| `skills/cafe/SKILL.md` | Skill for Claude Code / Codex / pi; `cafe skill install` symlinks it |
| `tests/` | vitest, **151 tests** (+4 mod tests via `npm run test:claude-plugin`): identity/display names/aliases (`identity.test.ts`), `knownDaemons` reachability (`known-daemons.test.ts`), router control/timeout/concurrency (`router-control.test.ts`), CLI init/help/config/errors (`cli-init.test.ts`, `cli.test.ts`), extension/doctor (`extension.test.ts`, `doctor.test.ts`), thread summaries (`thread-summary.test.ts`), `.cafe` discovery (`cafe-file.test.ts`), store tail/recovery (`store.test.ts`), plus session host, Codex TUI, e2e, follow-up/recovery, pi extension, serve, supervisor, routing hints/eval, direct links, discovery, service files, retention/search, client reconnect, versions, Bridges, MCP |

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
npm test                   # vitest; all 151 must pass (run twice: earlier flakes were unhandled rejections)
npm run check --workspace @cafe/web && npm run build:web
npm run test:claude-plugin # claude plugin validate + claude plugin test (needs Claude Code ≥ 2.1.3xx on PATH, see traps)
npm run test:release       # only when packaging/paths changed; ~1 min, no model
node packages/cli/bin/cafe.js daemon start --root     # or `npm link --workspace @cafe/cli` then `cafe ...`
open http://127.0.0.1:4777/
```

Scratch home for experiments (never touch the user's `~/.cafe`); turn discovery off so it does not answer on the LAN:

```bash
export CAFE_HOME=$(mktemp -d); printf 'port: 47821\nhost: test\nmode: root\ndiscovery: false\n' > $CAFE_HOME/config.yml
```

Tests run with `CAFE_DISCOVERY=0` (vitest.config.ts); `tests/discovery.test.ts` opts back in on a private service name.

Real checks done so far: Network-page version banner checked in a browser (Root 0.1.1 + child started with version 0.1.0); pi TUI (tmux) and headless; `claude -p` via `cafe serve --preset claude`; **omp 18.17.0 real Q&A** (headless answer, follow-up to the same Barista, Order shown in omp's TUI as `☕ Order from …`; ~$0.11); **`cafe daemon install` on the user's Mac** (launchd runs the Root now; `kill -9` → relaunched, `cafe daemon stop` → stays stopped, `cafe daemon start` → kickstarts the service, the pi TUI Barista reconnects); `scripts/sim-hosts.sh` all six steps pass; the packed `@blrbiran/cafe` tarball installed into a temp prefix passes a smoke test (web, serve, headless pi with the bundled extension, skill install, LLM router from the optional dependency); web UI for the routing-hint display checked in a browser against a scripted scenario. **v3-1 (no model cost):** the real `codex app-server` (codex-cli 0.170.0) driven through `CodexEngine` with the ccloop codex-qa mock Responses model and an isolated `CODEX_HOME`: fresh turn, follow-up, `thread/resume` in a new process, unknown thread → new thread, `turn/interrupt` (scripts were in the session scratchpad; recipe in `docs/specs/v3-1-native-codex-claude.md`). Real `claude` 2.1.327 accepts every flag the Bridge passes and prints `No conversation found with session ID` for a missing session. **Real-model Bridge Q&A (2026-11-19, approved):** Claude 2.1.327 (local login) and Codex 0.170.0 (the user's provider `group/smart`), each in a scratch `CAFE_HOME`: answer, follow-up continues the same session, cancel (no leftover process; the next question still works), an edit request refused in read-only mode (file hash unchanged). Codex also resumed its thread after a Barista restart; a Codex usage-limit error became an `unavailable` decline. `cafe mcp` over stdio answered `cafe_ask` + a follow-up from the Codex Barista; the user ran `cafe mcp install` and this Claude Code session loads the `cafe` tools (`cafe_agents` lists the user's `cafe#1`). v3-2 agent-kind tags checked in a browser (Agents page, conversation page). **v3-1 phase 2 (no model cost, 2026-11-19):** a real Claude Code 2.1.328 TUI in tmux with `--plugin-dir`, an isolated `CLAUDE_CONFIG_DIR` and a fake Anthropic API (answer, follow-up, `CAFE_DECLINE`, cancel, `/cafe off|on`, `/exit` cleanup); a real Codex 0.170.0 TUI (`--no-daemon`, like cmux) with the ccloop mock model and an isolated `CODEX_HOME`, driven through `cafe barista run --agent codex --tui` (answer ~6 s, follow-up, 120 s withdraw). Recipes and findings in the phase-2 section of `docs/specs/v3-1-native-codex-claude.md`. **No real-model run of phase 2 yet.** The user allows real-model tests with their pi model (`magpie/group/smart`), a few prompts each, but **every new paid run needs its own approval**.

## 4. Decisions you must not silently undo

- Terminology is fixed in `GLOSSARY.md`. Do not use "producer" or "consumer".
- ADR-0001: the Root relays every Order while online and does not re-route. ADR-0002: Registry replication, routing at the origin. ADR-0003: JSONL + SQLite. **ADR-0004: direct links only while the Root is offline**, backfill on return. **ADR-0005: Codex / Claude Baristas are Bridges; read-only by default, never full access; Claude uses the local login with `--setting-sources user` (`--bare` with an API key); session mapping lives in the Daemon.** **ADR-0006: running Claude Code sessions join through a mod (not channels), automatically in a dir with a Barista `.cafe`, `/cafe off` pauses; running Codex sessions through `thread/queue/add` (`--tui`); both use the session's own permissions (approvals stay with the person), and an Order not started within 120 s is withdrawn and declined as unavailable.**
- Every running instance is its own Agent, including two in the same directory.
- Injected Orders start immediately. `accept: confirm` was **removed at the user's request**; do not bring it back. `followUp` (not `steer`, not omp `aside`).
- Routing: descriptions are primary. History is auxiliary: penalty < 1, never excludes, never beats a better description match, only declines count (no bonus for answering). Operational declines do not count against topics.
- Web UI: conversation-first, plain language, no protocol jargon, internals collapsed, zh/en; **prototype and get approval before UI changes**.
- Routing LLM: routing only; the Order text passes through unmodified; rules fallback must work without an LLM.
- Data safety: nothing is deleted automatically unless the user sets `retention.days`; `cafe prune` is a dry run unless `--yes`.

## 5. Waiting on the user (start the next session here)

Done and approved earlier: v2 defaults; Q60–Q70; omp real Q&A; `cafe daemon install` on the Mac; web load-older + search; **Q71 A (Network page versions) approved**; the user restarted their daemon. The user published 0.1.0 and 0.1.1 themselves. Q72–Q79 answered as recommended; Q80 = C (no side work, focus on v3-1).

Done on 2026-11-19 with the user: v3-1 reviewed (the extra `cafe_cancel` MCP tool approved); both paid Bridge runs done and passed (section 3); `cafe mcp install` run by the user and checked. **v3-2** (`docs/specs/v3-2-agent-kind.md`, Q81–Q83, prototype https://claude.ai/artifact/X3F3dx2PtBQf3R5HwsiRL5): kind tags on Agent cards and in conversations, `cafe agents` shows `codex·rw`, `claude·tui`, …; fixes the old "后台 pi" label. The user published **0.1.2** (`latest` on npm; commit + tag `v0.1.2`). The daemon was restarted by the agent and reports 0.1.2. The dogfooding batch below was reviewed and the user published **0.1.3** (commit + tag `v0.1.3`); the daemon reports 0.1.3. README is now English with a Chinese `README_zh.md`, linked from both; the release package ships both.

Done on 2026-11-19 while the user was away (asked to finish phase 2), **to review**: **v3-1 phase 2** (Q84–Q88 as recommended; ADR-0006; spec section "第二阶段"):
1. Claude Code: `claude-plugin/` (mod) + `cafe session-host` + `cafe claude install|uninstall`. Verified free with a real Claude Code TUI and a fake API (section 3).
2. Codex: `cafe barista start --dir <dir> --agent codex --tui [--thread <id>]`. Verified free with a real Codex TUI and a mock model.
3. Findings worth knowing: after Esc in the terminal, both Claude (mod prompts refused) and Codex (queue dispatch paused) take no cafe questions until the person sends a message; a Codex turn that has started cannot be interrupted from outside, so cancel only withdraws queued questions; the user's cmux `codex` wrapper forces the TUI's embedded app-server, which the design handles (no shared daemon needed).
4. Commits: `feat: running Claude Code sessions as Baristas …`, `feat: a running Codex session as a Barista …`, and this handoff.

Waiting on the user:
1. ~~Publish 0.1.3~~ — done (see above). Next release after the Web workbench / remaining backlog.
2. **Install the Claude Code plugin**: `cafe claude install --dry-run`, then `cafe claude install` (changes `~/.claude` plugin settings; the agent did not run it). Then open sessions need `/reload-plugins`, new ones join automatically. Note: this repo has a `.cafe`, so Claude Code sessions opened here will answer cafe questions (`/cafe off` to pause).
3. **Approve two paid real-model runs** (Q88): a running Claude Code session and a running Codex session (`cafe barista start --dir <dir> --agent codex --tui` next to a `codex` in that dir), each: answer, follow-up, cancel.
4. **Real two-machine test** (section 6), later.
5. Suggest `pi update` (local pi 1.5.0, extension targets 1.5.2). Reinstall autostart (`cafe daemon install`), `cafe mcp install` and `cafe claude install` after changing Node version or moving the repo (all register absolute node + cafe.js paths).

Done on 2026-11-19 in the dogfooding batch (Q89–Q97; user chose Q90 B, Q93 B, rest as recommended), **to review**:
- Correctness/UX: `.cafe` directories are skipped (no more `EISDIR` from `~/.cafe`), broken `.cafe` errors name the file/field and show a template; pi extension reports why it is unavailable; CLI does not repeat `EISDIR`; `config get` prints `(not set)` / fails unknown keys; thread summaries cut at word boundaries with `…` and follow the latest turn; skill text now has a mandatory `$cafe` workflow.
- First use: `cafe init`, corrected help with Quick start (unknown commands fail even with `--help`), `cafe extension install|status|uninstall`, `cafe doctor`, rewritten README.
- Routing: `initRouter` can switch model and clear to rules; unknown models roll back; timeout/single-candidate/concurrency; ResourceLoader reused; `cafe router models|set|status|apply`; `daemon status` shows the running model.
- Multi-machine: child addresses are probed before entering `knownDaemons`; `cafe connect`, `root test`, `daemon restart`, restart-required config reporting, clearer `unauthorized`.
- Identity (ADR-0007): `displayName`/`aliases` for Hosts and Agents, local and Root-relayed rename; internal ids/Addresses never change, so no history migration.
- Performance (targeted): debounced meta writes, tail-only follow-up history, recovery query, registry upsert, parallel `announceRoot`; web store single set, O(1) duplicate check, linear merge, memoized Feed/Conversation, coarser `useNow` in cards.
- No Web layout redesign yet: the artifact tool refused this session (authenticated with `ANTHROPIC_AUTH_TOKEN`), and UI changes still need an approved prototype (#18/#22/#23/#24/#30).

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
- Web workbench (dogfooding #18/#22/#23/#24/#26/#30): fixed-height nav, compact cards, right drawer, responsive widths, settings/admin actions. Needs an approved prototype.
- LLM routing eval harness with 50+ cases, repeat runs and latency (dogfooding #14); full router status/health details.
- Full event store (SQLite/FTS) and web virtualization (dogfooding #31/#33/#34) — only targeted fixes are in.
- Global `cafe tail` (#19), attachments (#20), self-update/rollback (#27), connector SDK (#28), slash commands (#11).
- Phase 2 follow-ups: the web UI could show "paused" for a Claude session (`/cafe off` currently just leaves the network); a Codex `--tui` Barista could prefer the shared app-server daemon's live events when the TUI uses it (today it always polls `thread/turns/list`, ~1 s).
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
- **Two `claude` binaries**: `/opt/homebrew/bin/claude` is an old 2.0.19 (no `plugin test`); the nvm one (`~/.nvm/versions/node/v22.23.4/bin/claude`, 2.1.328) is the real one. Use its absolute path in scripts when a command says `unknown command`.
- **Never write a cafe mod into the session's dev-mods folder** (`~/.claude/dev-mods/<session>/`): it hot-loads into the user's own session (making it a Barista). Develop in `claude-plugin/`, check with `claude plugin validate|test`, and run a real TUI only in tmux with an isolated `CLAUDE_CONFIG_DIR` (pre-seed `.claude.json`: `hasCompletedOnboarding`, `theme`, `customApiKeyResponses.approved` = last 20 chars of the fake key, `projects[<dir>].hasTrustDialogAccepted`; otherwise the API-key screen defaults to "No" and opens a browser login).
- Mod test kit: `$.http.fetch` hooks get `{url, init}`; every `$.ui.*` call needs a test hook (`{ value: undefined }`); `$` may only be passed to functions declared outside `register`.
- Codex seen from another process: a turn still running in the TUI reads `interrupted` with `completedAt: null`; `turn/interrupt` on a thread loaded elsewhere fails with `thread not found`; after an Esc interrupt the queue is not dispatched until the next completed turn (`ext/queue/src/service.rs` `on_thread_idle`).
- Tests that share JSON state files with a fake process must write atomically (temp file + rename), or the fake reads half a file and dies.
- `cafe daemon start` polls `/api/health` for only ~5 s. With an LLM router configured, `initRouter()` (ModelRuntime + ResourceLoader) can take ~1 min before the server listens, so the CLI may report "did not start" while launchd is still bringing it up. Check `cafe daemon status` / the log before treating it as a failure; widen the wait when autostart is installed.
- npm publish to a scoped package returns **E404** when unauthenticated (not E401); `npm whoami` first. A successful publish may return 202 "being processed" and take a few minutes to appear in `npm view`.
- Artifacts are unavailable when the session authenticates with `ANTHROPIC_AUTH_TOKEN`: every Artifact call is refused. UI prototypes need a claude.ai login; otherwise write a local HTML file.
- Tests that spawn a CLI with `spawnSync` while the daemon lives in the vitest process deadlock: the parent's event loop is blocked, so the daemon cannot answer. Use async `spawn` (see `tests/doctor.test.ts`).
- `config.yml` is YAML (not JSON): tests must use `yaml.parse`, not `JSON.parse`.
- Commander falls back to top-level help with exit 0 for an unknown command; `main.ts` checks the first positional itself before parsing.
- `Store.readEventsTail` is the follow-up history path; `recover()` uses `store.openThreads()` so finished Threads are not reread. Metadata writes are coalesced (150 ms) except `order.created` / `order.closed` and on `stop()`.
- Reference repos: `sourceget find pi codex oh-my-pi`; oh-my-pi at `/Users/biran/code/skills/agent/oh-my-pi`; Orca web at `/Users/biran/code/skills/orca/Orca/web`; ccloop at `/Users/biran/code/skills/orca/ccloop`. Research them with subagents.

## 9. Working with this user

- They write in Chinese; answer in Chinese. They decide quickly when given numbered questions with a recommended answer (last used number: **Q97**; nothing open).
- New feature areas: go through the decisions first; small fixes go straight ahead. When they are away, follow the recommendations, keep going on what does not need them, and list the review items at the end.
- Commit when asked (or at the end of an away batch they asked to hand off), with a stat or diff shown first; messages end with the Co-Authored-By line.
- Restart their daemon yourself after daemon / web changes (section 8). Publishing to npm and changing their Claude / Codex config stay with them.
- UI prototypes are Claude artifacts: v1 https://claude.ai/artifact/JQDywMh5YuYWsT7yaMXtSK, routing-history display https://claude.ai/artifact/JJit3GCxiQZUypYVWZFxFg (approved: Q51–Q53 as recommended), older threads + search https://claude.ai/artifact/ARjRg8XRAdsx44YSdYehvZ (approved: Q67–Q68 as recommended), versions https://claude.ai/artifact/SVLEJhirFrxq7ugMipjeiZ (Q71 A, implemented), agent kinds https://claude.ai/artifact/X3F3dx2PtBQf3R5HwsiRL5 (Q81–Q83 as recommended, implemented).
