# cafe — handoff

Read this document first if you are taking over cafe. It records what exists, why it is that way, how to run and test it, what is waiting on the user, and the traps already found. Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md). Architecture decisions are in [`docs/adr/`](../adr/). Feature specs are in [`docs/specs/`](../specs/). See §5 first for the newest batch. Usage is in [`README.md`](../../README.md) and [`skills/cafe/SKILL.md`](../../skills/cafe/SKILL.md).

> Start with the newest entry in §5 and the operational notes in §8. Run `git status --short --branch` and `git log --oneline -5` to establish the checkout and recent commits. Run `cafe daemon status` separately to check the process that is serving requests.

## 1. What cafe is

cafe is an agent network. A message (an **Order**) is routed to the agent or agents best placed to answer it (**Baristas**). The design borrows from DNS.

- Each machine (**Host**) runs one **Daemon**. One of them is the **Root Daemon**, shown as "中心节点 / Hub" in the UI.
- The Root holds the authoritative **Registry** of all agents and replicates it to every Daemon.
- The Daemon where an Order starts makes the **Routing Decision**:
  - When `router.model` is set, a pi-SDK LLM decides; otherwise keyword rules decide (CJK text is split into bigrams).
  - Recent declines are a **weak hint** (`router.learn`, default on): they only reorder Baristas that tie on the description. See `docs/specs/v2-1-routing-hints.md`.
  - With no clear owner, the rules and LLM routers ask at most **3 candidates (top-k)**, not everyone; a question with two separable owners is multicast. `cafe ask --broadcast` (Web "ask everyone", MCP `broadcast: true`) is the only path to a full broadcast. A multicast/broadcast Thread closes `graceMs` (default 2 s) after the first final answer and marks silent targets **skipped** (`order.declined` + `unavailable`). Rules stem English plurals and weight action/specific words (`README` → docs). See `docs/specs/v4-4-routing-accuracy.md`.
  - An explicit address skips routing (`--to`). A **Follow-up** goes to whoever already answered in that Thread.
- While the Root is online, every Order goes through it (ADR-0001), so the Root's web UI shows all traffic. **While the Root is offline, cross-host Orders go over a direct Daemon-to-Daemon link** and are backfilled to the Root when it returns (ADR-0004).
- On a LAN a Daemon without `root` finds the Root over mDNS. `cafe daemon install` gives autostart (launchd / systemd --user).
- Daemons exchange their cafe version in `initialize`: a different `PROTOCOL_VERSION` is refused with `protocol_mismatch` and an upgrade hint; a different cafe version on the same protocol only warns (`cafe daemon status`, Network page). Published as the npm package `@blrbiran/cafe` (command `cafe`).
- **Transport security (v4-6 #61).** `security.mode: tls` is the default. A Root generates a CA once (`~/.cafe/tls/ca.crt` + `ca.key` 0600) and each Daemon presents a leaf signed by it on `security.tls.port` (default **4778**); plaintext **4777** keeps serving the Web UI and loopback. Verification is fail-closed (no plaintext fallback); **exact SAN** and a separate **per-peer leaf pin** (`security.tls.pins`, TOFU on first Daemon link) are both checked; **`root:` is the Root's main address** — a child learns the TLS port from public `GET /api/tls`, does not dial the Root at all until it has joined (enrolment retries 5 s→5 min), and on a TLS network every Daemon address is `wss://<host>:<tls port>` (v4-6 §10.3); `caFingerprint` authenticates the trust anchor at enrolment (TOFU, `cafe connect --ca-fingerprint`). `cafe root show` prints the fingerprint; `cafe daemon renew-cert` reissues a leaf on demand, and a leaf is also renewed automatically before expiry (inside 21 days, checked every 5 min while running, which also reissues when a local address is missing from the SAN — #91).
- Ways to be a Barista: pi with the cafe extension (TUI or headless `pi --mode rpc`, supervised by the Daemon); the same extension inside **oh-my-pi** (`--agent omp`); **native Codex / Claude Code** (`cafe barista start --agent codex|claude`, a **Bridge** process supervised by the Daemon, read-only by default, follow-ups continue the same Codex thread / Claude session; ADR-0005); `cafe serve --exec/--preset claude|codex` for any prompt-in / answer-out command (no session); **a running Claude Code session** (the cafe Claude Code plugin, a mod, installed with `cafe claude install`; ADR-0006; the plugin's `/cafe-barista off|on` pauses/resumes, while `/cafe` is the Customer command) and **a running Codex session** (`cafe barista start --agent codex --tui`, Orders go into the session's queue; ADR-0006).
- Ways to be a Customer: any agent, **`cafe mcp`** (MCP stdio server: `cafe_agents`, `cafe_ask`, `cafe_wait`, `cafe_cancel`; `cafe mcp install` registers it with Claude Code / Codex), the `cafe` CLI plus skill, the web UI, or **`cafe connector`** (out-of-process platform connectors; the SDK, supervisor and a mock connector are implemented, Discord is the first real platform).
- First use: `cafe init` writes a commented `.cafe` (interactive or `--yes --name …`), `cafe extension install` puts the extension into pi's settings and links it with omp, `cafe doctor` checks daemon / identity / extension / skill / router / root and prints the next command. `cafe config get` prints `(not set)` for unset known keys and fails for unknown ones.
- Display names: `cafe host rename|alias`, `cafe agent rename|alias`, `cafe daemon rename` (Root). Internal `host` / `agentId` / Address never change; old names become aliases (ADR-0007). `knownDaemons` is written only after the Root can reach the child (prevents Docker-internal IPs).
- Routing control: `cafe router models|set|status|apply`; `router.model` can be switched and cleared on a running daemon, unknown models are rejected and rolled back. `router.timeoutMs` (10 s) and `router.concurrency` (2) bound the LLM. `cafe daemon restart` applies restart-required config; `cafe config set` says whether a change was applied or needs a restart.
- A Thread holds several turns. A Barista can decline ("不归我管"). Operational declines carry `unavailable` and do not count against a topic. Heartbeats renew the liveness lease. A unicast Order also has a 10-minute default deadline, which an explicit `deadlineMs` can override. See §5 for CLI wait and cancellation behavior.
- **Attachments (v4-1 phases 1 and 2)** support Orders and replies across Hosts. Blobs live under `CAFE_HOME/artifacts/<threadId>/`. Use `cafe ask --attach`, `cafe reply --attach`, `cafe thread --download`, the MCP tools, or the Web composer. Bridge/serve replies can declare files with `CAFE_ATTACH:`. Reply pulls can retry when the Customer comes back online. Limits are `attachments.maxMb|threadMaxMb|maxCount` (25/100/10). **Pass only local paths to a Barista.** See [`v4-1-attachments.md`](../specs/v4-1-attachments.md).
- **Provenance**: an Order records `origin: human | agent` and, for relays, `via: { id?, address, name? }`. Web sends `human`; MCP sends `agent`; the CLI defaults to `human` with `--origin agent [--via <address>]`; a registered Agent asking over RPC is `agent` automatically. The Thread title stays on the **first** question; `summaryTurn` no longer follows follow-ups. Threads created before this batch have no `origin`/`via` (the UI shows nothing).

## 2. Code map

npm workspaces, TypeScript run directly by Node ≥ 22.18 (type stripping, no build step except for the web UI).

| Path | What it does |
|---|---|
| `packages/protocol/src/index.ts` | zod wire types: Order (`origin`, `via` provenance, `attachments`), `Attachment` (metadata + origin `host`), ThreadEvent, ThreadMeta (`origin`, `via`, `summaryTurn`, `attachments`), AgentRecord (`displayName`, `aliases`), DaemonRecord (`hostId`, `displayName`, `aliases`), RoutingDecision (`demoted`, `llmError`), RoutingHint, ClientKind (`agent/daemon/ui/peer`), the method list (incl. `agent/session/get|set`, `agent/rename`, `host/identity`) |
| `packages/protocol/src/peer.ts` | Symmetric RPC over a socket (codex app-server style, no `jsonrpc` field) |
| `packages/protocol/src/version.ts` | Dependency-free `PROTOCOL_VERSION`, `DEFAULT_PORT`, `onlineVersions()` — the web UI imports only this (`@cafe/protocol/version`), never the zod index |
| `packages/protocol/src/client.ts` | `CafeClient`: register (resumes agentId), `onOrder` (delivered attachments carry the local `path`), `onCancel`, `ask`, `keepAlive`, `decline(reason, {unavailable})`, `getSession` / `setSession`, `recentEvents(threadId?)` (last 500 events, so a listener attached after a fast thread closed can still read it); reconnect handles `error` and `close`, waits at most 5 s for a local daemon, 30 s for a remote one |
| `packages/daemon/src/daemon.ts` | Core: Root/child modes, Registry replication, Order lifecycle, follow-ups, `recover()` (only unfinished threads), Root relay/fan-out, routing hints (record/compute/push), direct links + backfill, display names/aliases + remote rename + **name-conflict checks**, `knownDaemons` reachability probe, `testHost` / `reconnectHost` (Web Network actions), prune/search, **`summaryMeta()` (clips replies/declines for list/snapshot payloads), paged `thread()`**, **attachments (stage → commit to Thread → cross-host pull → download proxy), `runtimeConfig().pending`, `doctor()`** |
| `packages/daemon/src/hints.ts` | Tokenizer (CJK bigrams), order keywords, time-decayed decline topics, penalty (< 1) |
| `packages/daemon/src/router.ts` | `RulesRouter`, `LlmRouter` (weak hints, 10 s timeout, single-candidate short circuit, concurrency gate, `confidence`/`whyNot`/`fanout` observability), `piComplete()` (reuses one ResourceLoader, aborts on timeout), `listRouterModels()` |
| `packages/daemon/src/routing-stats.ts` | Pure aggregate over recent `ThreadMeta`: unicast/multicast/broadcast counts, average fan-out, first-reply and close latency; `formatRoutingStats()` for `cafe stats` |
| `packages/daemon/src/discovery.ts` | mDNS advertise (Root) / discover (`multicast-dns`) |
| `packages/daemon/src/store.ts` | SQLite: thread metadata, registry cache (upsert instead of delete+insert), `agent_events` (+ `identity`, `tokens`), `agent_sessions`, **`artifacts` (blob metadata; blob paths are derived)**, `kv`. `readEventsTail` / `openThreads` for long Threads and recovery. Thread contents are JSONL under `~/.cafe/sessions/<date>/` (ADR-0003) |
| `packages/daemon/src/tls/` | v4-6 TLS: `certs.ts` (forge CA + RSA leaf, SANs, fingerprint), `trust.ts` (TOFU/pin policy, `readTlsConfig`), `store.ts` (`CAFE_HOME/tls/` paths, `ensureCa/Leaf`, `readLeaf/writeLeaf`), `bootstrap.ts` (`bootstrapCa`, `fetchRootCa`, `fetchLeafFromRoot`, `trustCaForClient`) |
| `packages/daemon/src/summary.ts` | Faithful list titles: word/sentence-boundary truncation with `…` |
| `packages/daemon/src/server.ts` | Two listeners sharing one handler: plaintext **4777** (HTTP API, `/ws`, static web UI) and optional TLS **4778** (`security.mode: tls`, `SNICallback` hot renew). `/api/tls` (CA + fingerprint), `/api/tls/leaf` (Root issues a child leaf), `/api/tls/renew`. `?token=` is gone — Authorization: Bearer only. New: `/api/host`, `/api/hosts/rename`, **`/api/hosts/test`, `/api/hosts/reconnect`**, `/api/agents/rename`, `/api/router/models`, `POST /api/router`, `POST /api/baristas` (start), `GET /api/settings` (root + masked token), **`GET /api/config` (running config + `pending`, no token; for `cafe config diff`), `GET /api/doctor`**, **`POST /api/artifacts` (streaming upload) and `GET /api/artifacts/:id` (local file or origin proxy)**, `GET /api/events` (SSE with `id:` lines and `Last-Event-ID` replay from a 500-event ring), **`GET /api/events/history?after=` (JSON backfill for the WebSocket reconnect)**, structured `/api/reload` (`ok/router/model/error`), **`/api/snapshot` summary threads (replies/declines clipped) and `webStale`**, **paged `/api/threads/:id?limit=&before=` and SSE `?after=`** |
| `packages/daemon/src/events.ts` | Global event filters for `GET /api/events` / `cafe tail` (host, type, thread, heartbeats hidden by default); `replayAfter()` for SSE resume |
| `scripts/router-eval.ts` | `npm run routing:eval`: offline rules eval over 53 labelled cases (`tests/routing-fixtures.ts`); `--model provider/model [--repeat N] [--json] [--out file]` for a real-model sample (costs money, never in `npm test`) |
| `packages/daemon/src/supervisor.ts`, `proc/` | Headless workers under a guard that dies with the Daemon; per-Barista `bin` (pi / omp) or `agent` (codex / claude → `node <defaultCliBin()> barista run`), `access`, `model`, `tui` + `thread` (codex only; one worker whatever the concurrency) |
| `packages/daemon/src/index.ts` | `runDaemon()`, lock, discovery start/stop |
| `packages/cli/src/main.ts` | The `cafe` command. New: `init`, `doctor`, `extension install|status|uninstall`, `router models|set|status|apply`, `host rename|alias`, `agent rename|alias`, `daemon rename|restart`, `connect`, `root test`, `tail`, **`config diff|apply`**, **`commands status|install|uninstall`**, **`ask --attach`, `thread --download`**; help has a Quick start; unknown commands fail even with `--help` |
| `packages/cli/src/commands.ts` | Slash-command entry points: `cafe commands status` (pi/omp extension, Claude plugin + `/cafe-ask`, Codex `$cafe`), installs `~/.claude/commands/cafe-ask.md` with a marker, refuses to overwrite a person's file unless `--force`, uninstall only removes its own file |
| `packages/cli/src/init.ts`, `doctor.ts`, `extension.ts`, `errors.ts` | Guided `.cafe` creation; health checks; pi/omp extension install/status; daemon API error formatting |
| `packages/cli/src/service.ts` | launchd plist / systemd unit generation and (un)install; `servicePath()` drops temp and per-terminal shim dirs (cmux) from the service PATH; `startInstalledService()` |
| `scripts/build-release.mjs` | esbuild → `release/` (publishable package `@blrbiran/cafe`), see `docs/specs/v2-7-publishing.md` |
| `scripts/test-release.mjs` | `npm run test:release`: pack, install into a temp prefix, smoke-test the installed `cafe` (no model; includes `cafe mcp` and a supervised Codex Barista on the fake app-server). Run before every publish |
| `scripts/sim-hosts.sh` | Three local Daemons (Root + 2 children) running the section 6 failure cases without a model; run before a real multi-machine test |
| `packages/cli/src/serve.ts` | `cafe serve`; `buildPrompt` / `buildFollowup` / `DECLINE_MARKER` are shared with the Bridges |
| `packages/cli/src/connector.ts` | `cafe connector install|list|status|start|stop|restart|logs|config|remove`: manifest check, copy + SDK symlinks, detached process with `CAFE_CONNECTOR_*` env, log tail, pid/restart state, foreign-dir removal guard |
| `packages/connector/` | `@cafe/connector` SDK (`defineConnector`, HTTP/SSE client, atomic `threads.json` / `seen-events.json` / `outbox.json`, stdout heartbeat protocol) + `mock/` connector (stdin JSON lines or local HTTP `ingestPort`) |
| `packages/cli/src/bridge/` | v3-1 Bridges: `barista.ts` (register, queue one turn at a time, cancel, decline, session mapping via the Daemon; `tui` option), `codex.ts` (`AppServer` stdio client, `CodexEngine`, `refuseServerRequest()`), `codex-tui.ts` (`CodexTuiEngine`: `thread/list` → `thread/queue/add` → poll `thread/turns/list`; withdraw with `thread/queue/delete`), `claude.ts` (`claude -p` per turn, `claudeArgs()`), `engine.ts` (types), `session-host.ts` (`cafe session-host`, hidden: the network side of a running Claude Code session; JSON lines on stdout, HTTP over a Unix socket back). Run as `cafe barista run --agent …` |
| `packages/cli/src/claude-plugin.ts` | `cafe claude install|uninstall`: writes `CAFE_HOME/claude-marketplace` (plugin copy + `cafe.json` with absolute node + cafe.js) and runs `claude plugin marketplace add` + `claude plugin install cafe@cafe-local` |
| `claude-plugin/` | The cafe Claude Code plugin (not an npm workspace, not in the root tsconfig): `hooks/register.ts` (the mod: spawns `cafe session-host`, `$.prompt.submit`, matches `turn.start` by `[cafe order <id>]`, answers from `turn.complete`, `$.turn.abort`, `/cafe on|off`), `tests/register.test.ts` (`npm run test:claude-plugin`). Shipped in the release package |
| `packages/cli/src/mcp.ts` | `cafe mcp`: hand-written JSON-RPC 2.0 over stdio (no MCP SDK); `mcpInstallCommands()`; `cafe_ask` accepts local file paths in `attachments` and uploads them itself |
| `packages/pi-extension/src/index.ts` | pi extension; also runs under oh-my-pi (`isOmp()`), see below; registers the `/cafe agents|ask|status|thread|help` command (a user-owned `/cafe` wins; tools and skill still work) |
| `packages/web/` | React 19 + Vite 6 + Tailwind v4; zh/en; single store with `useSyncExternalStore`; fixed Shell, compact feed with whole-card click and 2-column list at ≥1800 (drawer closed), right detail drawer / three-pane at ≥1600, info rail at ≥1920, nav Agents sublist (open by default on desktop, remembered; agent rows open the rename/alias menu on right-click or Shift+F10 — no per-row ⋯ button, which used to fall onto a second grid line; menus close on outside click/Esc); Agent cards show the working directory and a separate 负责范围/scope row; Settings drawer (machines + remote rename, start/stop Baristas, routing, connection root/token hint, **pending config + health checks**), Live page, drawer open/close animation and click-outside close; feed has "load older" and full-text search; cards show `你`/`代问` provenance and **📎 attachment count**; **displayName shown in Network/Agents/Live/Shell; Network cards can test/reconnect/rename/copy CLI**; a banner appears when the built Web UI on disk is newer than the daemon's in-memory copy; long Threads load older events; Live backfills events after a WebSocket reconnect; snapshot 200-thread payload is clipped; **composer uploads 0–N files, Thread shows/downloads attachments** |
| `skills/cafe/SKILL.md` | Skill for Claude Code / Codex / pi; `cafe skill install` symlinks it |
| `tests/` | vitest, **471 tests** (+5 mod tests via `npm run test:claude-plugin`): **TLS transport (`tls-certs|trust|server|client|child|bootstrap|renew|cli|untrusted|lifecycle|renewal-predicate|runtime-renewal|san-coverage|peer-pin`, `security-token`)**, **per-target sub-questions (`per-target-questions`)**, **web tab icon (`web-icon`), resizable sidebar (`web-nav-width`)**, **scratch configs stay off 4778 (`scratch-configs`)**, identity/display names/aliases, legacy names and removal (`identity.test.ts`), provenance (`provenance.test.ts`), **attachments (`attachments.test.ts`: local, cross-host pull/proxy, limits, CLI upload/download)**, **daemon health endpoint (`doctor-api.test.ts`)**, **health metrics and search stats (`metrics.test.ts`)**, **heartbeat lease regression (`heartbeat.test.ts`)**, **routing observability and `/api/routing/stats` (`routing-observability.test.ts`), routing aggregates (`routing-stats.test.ts`)**, connector SDK/mock/CLI/idempotency/crash-restart (`connector.test.ts`, restart wait deflaked), Discord connector core + fake-platform end-to-end (`discord-connector.test.ts`), FTS search + prune index cleanup (`retention.test.ts`), bounded caches (`cache-bounds.test.ts`), claude install exit code + commands status (`commands.test.ts`), `knownDaemons` reachability (`known-daemons.test.ts`), router control/timeout/concurrency (`router-control.test.ts`), rules eval + hints (`routing-eval.test.ts` over `routing-fixtures.ts`, 53 strict + `EXTRA_CASES` overlap/morphology/multicast/top-k/variants/stability), rules decisions (`routing-rules.test.ts`), fan-out grace (`routing-grace.test.ts`), follow-up race (`until-closed.test.ts`), bounded metadata (`bounded.test.ts`), reply entry (`reply-entry.test.ts`), controlled update + drain (`update.test.ts`), global event filters, SSE resume and the WebSocket backfill endpoint (`events.test.ts`), config contract incl. pending and the write API (`config-contract.test.ts`), thread paging, limit validation, unknown-stream 404 and snapshot summaries (`thread-paging.test.ts`), client event buffer (`client-recent.test.ts`), CLI init/help/config/redaction/status/aliases (`cli-init.test.ts`, `cli.test.ts`), extension/doctor (`extension.test.ts`, `doctor.test.ts`), thread summaries (`thread-summary.test.ts`), `.cafe` discovery (`cafe-file.test.ts`), store tail/recovery (`store.test.ts`), service retarget (`service.test.ts`), plus session host, Codex TUI, e2e (incl. the slow-ack heartbeat regression), follow-up/recovery, pi extension (incl. `/cafe`), serve (incl. preset safety), supervisor, routing hints, direct links, discovery, retention/search, client reconnect, versions, Bridges, MCP |

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
npm test                   # vitest; all 531 must pass (the #6 heartbeat regression and the identity/legacy tests are part of it)
npm run routing:eval       # offline rules eval: 67 scored cases, 3 blocked team cases, no model cost
npm run check --workspace @cafe/web && npm run build:web
npm run test:claude-plugin # claude plugin validate + claude plugin test (needs Claude Code ≥ 2.1.3xx on PATH, see traps)
npm run test:release       # only when packaging/paths changed; ~1 min, no model
node packages/cli/bin/cafe.js daemon start --root     # or `npm link --workspace @cafe/cli` then `cafe ...`
open http://127.0.0.1:4777/
```

The same gate runs in CI (`.github/workflows/ci.yml`) on every push/PR: typecheck, the full test
suite, `routing:eval` (rules only), web check + build, and `test:release`. The Claude plugin test is a
separate job that is skipped when `claude` is not on the runner.

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
- Web UI: conversation-first, plain language, no protocol jargon, internals collapsed, zh/en; **prototype and get approval before UI changes** (the 2026-11-19 night batch's drawer/nav changes were requested directly by the user).
- **A Thread is titled by its first question.** Follow-ups no longer overwrite `summary`/`summaryTurn`; the card shows `N 轮` instead. Do not reintroduce "title follows the latest turn".
- **Provenance is recorded, not inferred**: `origin` (human/agent) and `via` (relaying Agent) come from the caller (Web/MCP/CLI flag/registered peer). Do not try to guess it from the text.
- Routing LLM: routing only; the Order text passes through unmodified; rules fallback must work without an LLM. **Per-target variants (#39) only customise the delivered prompt text** — they never change routing, the recorded `body`, or history.
- **TLS is fail-closed (v4-6).** Never add a plaintext fallback on a handshake error, never disable certificate verification to "make it connect", and keep the CA fingerprint (trust anchor) distinct from the per-peer leaf pin. `security.mode: plaintext` is only ever chosen explicitly by a person.
- Data safety: nothing is deleted automatically unless the user sets `retention.days`; `cafe prune` is a dry run unless `--yes`.
- **TLS fail-closed holds on the accepting side too (#89).** With TLS on, a `daemon`/`peer` `initialize` on the plaintext port is refused (`tls_required`); never relax this for "compatibility". The CLI never probes the Root over `http://` with the token while TLS is on.
- **Discord: one channel = one Thread, until** the channel is quiet for `newThreadAfterHours` (default 6, from the Thread's `lastActivityAt`) or the person sends `/new` (user decision 2026-11-24). Conversation cards show the latest activity time; the title stays the first question.

## 5. Waiting on the user (start the next session here)

### 2026-11-25 (newest) — 测试者第九轮的 #91–#94（TLS 部署），两批均已提交

- **一句话**：台账第九轮新开的 4 条在代码里都成立，用户裁定 Q116–Q120：两批都做（批 1 #91 #92，批 2 #93 #94），
  #91 每 5 分钟比对地址，#92 Test 用「经上行链路在线 + 直连地址不通」，#93 只做按时间降级、不加清除命令，Web
  上「哪段加密」的标注推迟到和 #61 尾巴一起出原型。
- **#91**：叶子证书只含 `lanAddress()` 的第一个地址，VPN 后的子节点握手失败而 doctor 报 ok。现在 SAN = host +
  advertise + **所有**非 internal IPv4（`localAddresses()`）+ `security.tls.sans`；daemon 每 5 分钟
  （`leafCheckIntervalMs`，原 6h）检查到期和缺失地址并原地重签（保留密钥）；doctor 点名缺失地址；
  `cafe daemon renew-cert --san <名字>` 记进配置、运行中免重启，子节点也能用（`/api/tls/renew` 不再限 Root，
  子节点向 Root 申请）。本机重启后叶子含 `192.168.3.129` 和 `198.18.0.1` 两个地址。
- **#92**：TLS 网络里 pin 不再显示成 `ws://`（解析出 TLS 端点后显示 `wss://`，`knownDaemons` 也存 `wss://`）；
  `ws://` 的历史 `knownDaemons` 视为过期，不再广播给子节点；清除 pin 回到子节点握手时自报的地址；Test 在直连失败
  但上行链路能往返（`uplinkAlive()` 真发一次请求，不看 `children` 表）时返回 `online, via: "uplink", address,
  error`，Web 显示黄色「在线（它连到中心节点的链路正常）· 但中心节点直连它的地址 x 不通」。旧测试
  `host-address.test.ts` #83 的期望随之改为 `online: true, via: "uplink"`。
- **验证（批 1）**：typecheck；**520 tests ×2**；`routing:eval` 67/67；web check + `build:web`；`test:release` 17/17；
  `test:claude-plugin` 5/5。本机 Root 已重启，doctor 全绿。
- **#93**：被拒的明文连接按时间老化（`timing.refusedRecentMs` 10 min / `refusedForgetMs` 24 h）：还在反复尝试 →
  doctor `fail`（文案改为 "refusing plaintext links from …"）；停止尝试 → `warn` + 「N m ago」，`doctor.ok` 不受影响；
  24 h 后删除，连同仅由拒绝产生的 Network 记录。`/api/health.tls.refused[]` 多了 `recent`。`cafe daemon status` 的
  tls 行（抽到 `packages/cli/src/tls-line.ts`）与 doctor 同口径。按用户裁定不加清除命令。
- **#94**：`CONFIG_KEYS` 递归到叶子（`security.tls.port|ca|caFingerprint|pins|sans`）；`isConfigKey()` 也接受 map
  条目（`security.tls.pins.<host:port>`，`configKeyPath()` 让带点的条目名保持一段）；`config get` 与 `config set`
  用同一校验，拼错给 did-you-mean，`set` 不再「保存成功但什么都没写」。`cafe root show` 在子节点尚未入网（无 ca.crt）
  时打印 `security.tls.caFingerprint`（expected）。
- **文档**：两份 README + SKILL：多地址 SAN / `--san` / 5 分钟检查、Test 的「经上行链路在线」、拒绝老化、重启后
  `router: loading`（0.1.5 原来缺的那一条）；spec v4-6 SAN 段。
- **验证（批 2）**：typecheck；**531 tests ×2**；`routing:eval` 67/67；web check + `build:web`；`test:release` 17/17；
  `test:claude-plugin` 5/5。本机 Root 已重启，doctor 全绿，`cafe config get security.tls.port` → 4778，三个会话已重连。
- **改了旧测试的两处期望**（行为按用户裁定改变，不是放松）：`host-address.test.ts`（#83 用例，上行链路在时 Test 为
  `online: true, via: "uplink"` 且仍带 `ECONNREFUSED`）、`doctor.test.ts`（"refusing plaintext links from"）。
- **仍需你本人**：推送与发版（建议 0.1.5 带上 #91–#94）；Discord 实测（附件私信、`/new`、6h 新 thread、稳态重启去重、
  回答途中重启）；ssh1 现场复核 #91/#92（Root 叶子已含所有本机地址；在 Root Network 页点 ssh1 的 Test 应显示黄色
  「在线（链路正常）· 直连 x 不通」）。
- **下一步候选（先 brainstorm/spec，没动）**：#18 只读 token（spec）；#27 Root 主动推送升级通知（Network 页的版本落后
  标注**已经有了**：横幅 + 警告色）；#71–#73；Web 标注「哪段加密」与局域网 https 一起出原型（Q120）；「移除一台离线
  机器」（Q119 B，未做）。

- **给测试者的复核清单**（纯文本，可直接转发）：

```
cafe 台账复核建议（2026-11-25，#91–#94）

1. #91：Root 重启后 openssl x509 -in ~/.cafe/tls/<host>.crt -noout -ext subjectAltName 应含本机所有 IPv4（en0 + utun）。
   不重启验证：cafe daemon renew-cert --san <名字>（会写进 security.tls.sans）；doctor 在缺地址时点名报 warn。
   回归测试：tests/tls-multi-address.test.ts。注意：你手工热换发时补的 SAN 不在配置里，以后的自动续期以「本机地址 +
   security.tls.sans」为准，VPN 地址只要在 utun 上就会自动带上。
2. #92：/api/daemons 里 TLS 子节点为 wss://；ws:// 的历史 knownDaemons 不再广播；清除 pin 回到子节点自报地址；
   Root 上 Test 一台「上行在、直连不通」的机器返回 online:true, via:"uplink", address, code。tests/tls-addresses.test.ts。
3. #93：明文探针一次后：10 分钟内 doctor fail，之后 warn「refused … Nm ago」且 doctor.ok 为 true，24 小时后消失；
   cafe daemon status 的 tls 行同口径。持续重试的明文 child 一直 fail。按 owner 裁定不加清除命令。tests/tls-refused-age.test.ts。
4. #94：cafe config get security.tls.port / caFingerprint / pins 可读；拼错给 did-you-mean；config set 用同一套 key；
   未入网的子节点 cafe root show 打印 expected 指纹。tests/config-keys.test.ts。
5. #27：Network 页的「版本落后」标注早已存在（横幅 + 警告色），剩余是 Root 主动推送升级通知，建议收窄。
```

### 2026-11-25 — 台账复核后三批：#90 乱码、#31 关、端口/后台会话、#33 Web 空转、#18 收窄、daemon 启动

- **一句话**：按 `../cafe_dogfooding/issue-20261119.md` 重新核对开放项（以代码为准），用户裁定「先修 #90、发版时机
  他定；#31 按同步写关闭；#18 去掉 Web 改 token；做批 1–3」。全部做完并提交，**未推送、未发版**（`git log
  origin/main..main` 查看）。上一轮的提交在本轮开始时已经在 origin 上。
- **#90（P1 数据损坏）**：`store.ts: scanBackward` 先把 64 KiB 块解码成字符串再拼半行，跨边界的中文/emoji 变
  `U+FFFD`。**比台账写的更早更广**：`f327922`（11-20）起 `readEventsPage` 就是这样读，所以 Web/CLI 详情首页、SSE 首页、
  追问的 history（交给 agent 的上下文）都受影响；`c607bd1` 又把它带到回填（**会把乱码写进 Root**）、recover、
  closingEvent。修法：携带原始字节、按 `0x0A` 切、整行解码。测试覆盖 64 个相位 × 四条读路径（修前 256 处损坏）。
  100k 中文事件 `readEventsPage(50)` 0.51ms。本机 `~/.cafe` 只有 2 个小 Thread，没触发。
- **#31**：补了判据 2 的回归测试：100 events/s 时 meta 每秒最多约 7 次（150ms 合并），变异检查（每事件写 meta）165 次被抓到。
  同步 append 按用户裁定不改 → 台账可关。
- **端口冲突**：`EADDRINUSE` 变成「TLS port 4778 is already in use … `cafe config set security.tls.port`」；
  `cafe daemon start` 不再等满 5s 只说 see log，而是立刻打印 daemon 的原因。
- **后台会话**：session-host 检测祖先进程 `claude[.exe] --bg-pty-host`，注册 `background: true`（可选字段，旧
  daemon 会丢掉）。Agents 页显示「后台会话（没有打开的终端）」+ 下线办法，`cafe agents` 显示 `claude·bg`。实测本机
  后台 orca 会话判为 true、前台为 false；**已在跑的 session-host 要等会话重载后才带上这个标记**。
- **#33（Web 空转）**：用 CDP 实测空闲页的主线程耗时。最大头是「进行中」小圆点用 `box-shadow` 动画，每帧重绘：
  Feed 174 → ~6 ms/s，活跃 Thread 207 → ~10 ms/s，Live 2.6 → 1.4。改成 `::after` + transform/opacity；
  Conversation 只让「已处理 X 秒」那段每秒刷新（`OutcomeText`），Live 的「X 秒前同步」独立刷新，搜索结果 30s。
  测试 `web-pulse` 保证无限动画只用 transform/opacity。虚拟列表没做（DOM 规模目前不是瓶颈）。
- **#18 收窄**：Web 不改 token。Root 的设置抽屉新增「加入另一台机器」（`cafe connect <主地址> --token <token>
  --ca-fingerprint sha256:…` + 复制），`cafe root show` 在 Root 上打印同一条命令；token 从不出现在 API。顺带修了
  `tokenHint`：≤4 字符的 token 原样显示，现在 12 位以下全遮。截图 `output/playwright/settings-join-1440.png` /
  `-390.png`（**待审**，这次没先出原型）。
- **daemon 启动（本轮实测发现）**：pi 模型运行时加载偶尔要 26–47s（平时 <1s），期间 daemon 不开端口 → Web/Agents/CLI
  全断。现在先开端口，router 后台加载，加载中到达的 Order 等它（路由结果不变）；`/api/health.routerLoading`、
  `cafe status`/`router status` 显示 loading，doctor 为 warn；加载中切换模型以新的为准。CLI：spawn 出的 daemon
  还活着就继续等（最多 60s，`CAFE_DAEMON_START_WAIT_MS`）；锁被另一个活进程持有（还在启动，或 session-host 抢先
  自动启动）就等它，不再报「did not start / already running」。实测 stop+start 连续两次都成功。
- **验证**：typecheck；**506 tests ×2**；`routing:eval` 67/67；web check + `build:web`；`test:release` 17/17；
  `test:claude-plugin` 5/5。本机 Root 已重启到新代码，doctor 全绿，三个会话都已重连。
- **仍需你本人**：审 `settings-join-*.png`；推送与发版（建议 0.1.5，说明见下）；Discord 实测（附件私信、`/new`、
  6h 新 thread、稳态重启去重、回答途中重启）；ssh1 升级后 `security.mode: tls` 并重启。
- **发布说明要点（0.1.5）**：#90 修复（中文/emoji 长对话的乱码，含跨机回填）；TLS Root 会拒绝明文连接的子节点；
  端口占用/daemon 启动的报错与等待；后台会话标记；Web 空闲 CPU 大降；Root 设置页「加入另一台机器」。
- **需要讨论 / brainstorm（没动代码）**：Web 局域网用 `http://…?token=` 仍是明文（#61 尾巴；https 要处理浏览器信任
  CA）；#27 全网升级提示（Network 页标出版本落后的机器）；#18 只读 token（需 spec）；#71–#73。
- **给测试者的清单**（纯文本，可直接转发）见本节末尾的代码块。

```
cafe 台账更新建议（2026-11-25）

一、请落状态
1. #16 → 已修。判据：按软约束接受（owner 5 次付费回归 5/5 首个工具调用是 cafe 命令）。
2. #84 → 已修。判据放宽为「白底 + 深棕线在 Chrome 深色标签栏下可辨」；圆角导致四角透明属于设计取舍。
3. #39 → 观察。domain guard 和 multicast 子任务暂不做，有误投实例时再记录。
4. #31 → 决定不改（写侧）/ 关闭。读侧判据已达成；判据 2 由 tests/metrics.test.ts「metadata writes under an event burst」覆盖（100 events/s 时 meta ≤ ~7 次/秒）；appendFileSync 同步写是有意的取舍。
5. #90 → 请按判据复核后关闭。修复提交 "fix(store): backward reads keep multi-byte text intact"。

二、#90 复核要点
1. 本条比原文更广：f327922（11-20）起 readEventsPage 就按块解码，Web/CLI 详情首页、SSE 首页、追问 history 都受影响，不只是 c607bd1 的三条路径。
2. 判据 1/2/3：tests/store.test.ts「keeps CJK and emoji text intact whatever byte the read boundary falls on」覆盖 64 个相位 × readEventsSince / readEventsPage / readOrderEvents / findLastEvent，修前 256 处损坏，修后 0。也请用你的 /tmp/utf8-real2.ts 复跑。
3. 判据 4：100k 中文事件 readEventsPage(50) 实测 0.51ms。
4. 你的机器上若已有被回填污染的 Thread（Root 上），请只读扫一遍：grep -rl $'\xef\xbf\xbd' ~/.cafe/sessions/ （正文本来就含 U+FFFD 的会误报）。

三、#18 请按收窄后的范围复核
1. Web 不再计划改 token（改 token 会让所有子节点同时掉线）。
2. Root 的设置抽屉有「加入另一台机器」：cafe connect <主地址> --token <token> --ca-fingerprint sha256:…，带复制按钮；cafe root show 在 Root 上打印同一条命令。
3. GET /api/settings 不含 token；tokenHint 对 12 位以下的 token 全遮（原来 ≤4 位的 token 会原样显示）。
4. 剩余：只读 token（需要 spec）。

四、#33 请实测后收窄
1. 空闲 CPU：用 CDP Performance.getMetrics 量空闲 10 秒的 TaskDuration。owner 实测 Feed 174 → ~6 ms/s，活跃 Thread 207 → ~10 ms/s，Live 2.6 → 1.4。主因是「进行中」圆点的 box-shadow 动画每帧重绘。
2. 已做：事件合并 set、无全量排序、ThreadCard memo、按需 tick（活跃 1s / 其余 30s）、Conversation 只刷新耗时文本。
3. 未做：虚拟列表（判据 5）。

五、#34 请按判据实测后关闭或收窄
已落地：announceRoot 并发 8 路 / 1.5s 超时；registry 增量写；snapshot 用精简 meta；Web 能分页加载更早的对话。

六、#61 请收窄为两项
1. perf:tls 基准（判据 5）。
2. 局域网 http://…?token= 打开 Web 仍是明文（服务端只认 Bearer，判据 7 的服务端部分已满足）。

七、新的可复核行为（不在台账里，测试时顺手看）
1. 同机第二个 daemon 的 TLS 端口冲突：cafe daemon start 立刻报「TLS port 4778 is already in use … cafe config set security.tls.port」。
2. cafe agents 里后台 Claude Code 会话显示 claude·bg，Agents 页显示「后台会话」。
3. 重启后 daemon 先开端口；cafe status 在 router 加载完前显示 router: loading；cafe daemon stop 后立刻 start 不再报 already running。
```

### 2026-11-24 — Discord 两个问题 + #89 + #31 冷路径（三批，均已提交）

- **一句话**：用户裁定 Q1=A、Q2=C(6h)、Q3/Q4 同意、Q5 按批 1→2→3，三批都做完，都是先 RED 再修。
  三个提交：`fix: Discord attachments and conversations …`、`fix(tls): a TLS Daemon refuses plaintext …`、
  `perf(store): recovery, backfill and closing reads …`（以 `git log --oneline -5` 为准）。**都没推送**。
- **批 1**：(1) `session-host.ts` 组 prompt 时漏了 `h.attachments`，Claude Code 会话收不到附件路径（Bridge/
  Codex TUI/pi 都有）；(2) `ThreadMeta.attachments` 现在收集每一轮的附件（按 id 去重，上限 50）；(3) 卡片时间
  改为 `lastActivityAt`（`format.ts: cardTime`）。**更正上一轮**：根本没有 `updatedAt` 字段，`lastActivityAt`
  一直有刷新，所以「追问不刷新」是查错了字段；真正的原因是卡片显示创建时间，加上 Discord 一个频道永远对应
  一个 Thread。(4) Discord：频道空闲 `newThreadAfterHours`（默认 6）后开新 Thread，`/new` 手动开新，`/new <问题>`
  直接提问（`discord-core.ts: newCommand/currentThread`，空闲时间取 daemon 上的 `lastActivityAt`）。
- **批 2（#89）**：`server.ts` 把 `req.socket.encrypted` 传给 `Daemon.accept()`；TLS 开启时，明文端口上的
  `daemon`/`peer` 握手一律拒绝，返回 `tls_required`（文案含 TLS 端口和修复步骤），`ui` 和 Agent 不受影响。
  Root 记录被拒的机器：`DaemonRecord.refused`、`/api/health.tls.refused`、doctor `tls-links`(fail)；同一台
  机器之后用 TLS 加入就会清掉。CLI `cafe doctor` 在 TLS 下不再明文带 token 探测 Root，改用 daemon 自己的
  视角。Network 页显示「未加密，已拒绝」和修复步骤；「在线」加了说明，「测试连接」改为「本机能连到它」（#83 第 4 点）。
  spec `v4-6-tls.md` §10.4；README / README_zh / SKILL 已同步。隔离实测（TLS Root 4851/4861 + 明文子节点
  4852）：拒绝、日志、doctor、Web 都正确；子节点切到 TLS 并重启后以 `wss://…:4862` 加入，拒绝标记清掉。
  截图 `output/playwright/network-refused-1440.png`、`network-refused-390.png`（**待你审核 UI**）。
- **批 3（#31）**：`Store.scanBackward()` 统一反向读；`readOrderEvents`（recover）、`readEventsSince`
  （回填窗口和 Root 端去重）、`findLastEvent`（closingEvent）读到需要的就停。子节点记录 `backfillSince`
  （旧键 `backfill` 照写，回退到旧版本不会崩），只发断线后的窗口（留 10 分钟时钟偏差余量），每批 500 条。
  10 万事件：全量读 197ms，新读法 0.08–0.17ms。**仍是全量读、决定不改**：短查询（少于 3 字）的搜索回退、
  一次性的搜索索引回填。`appendEvent` 同步写入维持不改（异步有丢数据风险）。
- **验证**：typecheck；**490 tests ×2**（471 → 490）；`routing:eval` 67/67；web check + `build:web`；
  `test:release` 17/17。本机 Root 已重启到新代码，doctor 全绿（`tls-links` ok）；Discord connector 已单独
  `cafe connector restart discord`（**connector 不会随 daemon 重启**，之前一直跑着批 1 之前的旧代码）。
- **用户同步问到的 orca#1**：不是残留记录。pid 43364 是一个**后台** Claude Code 会话
  （父进程 `claude --bg-pty-host /tmp/cc-daemon-501/…`，21:57 启动，cwd `~/code/skills/orca/Orca`），它的
  `cafe session-host`（pid 44276）也活着。要它下线：接回这个后台会话后退出，或在会话里 `/cafe off`。我没有动它。
  候选改进：Agents 页显示 pid 或「后台会话」。
- **台账口径（台账在仓库外，没改）**：#89 可以按判据复核；#31 可以收窄到「同步 append（决定不改）+ 短查询
  回退」；用户已同意 #16 关闭、#84 放宽判据后关闭、#39 改为观察，请测试者在台账里落状态。
- **仍需你本人**：审 Network 页两张截图；推送本地提交（`git log origin/main..main`）并决定是否发版；**ssh1 升级后必须
  `security.mode: tls` 并重启**，否则会显示「未加密，已拒绝」（发布说明加一句「TLS Root 会拒绝明文子节点」）；
  Discord 实测：附件私信（Claude Code 会话应能看到路径）、`/new`、隔 6h 的新 Thread、稳态重启去重、回答途中重启。
- **下一候选**：同机第二个 daemon 的 TLS 端口冲突只报 `EADDRINUSE 0.0.0.0:4778`，提示可以更友好（指向
  `security.tls.port`）；Agents 页标出后台会话；Web 通过 LAN `http://…?token=` 仍是明文（单独议题）；#33/#34
  虚拟列表与 snapshot 分页；#18 只读 token（需 spec）；#27、#71–#73（需 brainstorm）；TLS phase 2。

### 2026-11-24 (latest) — 台账复核后的两批修复：A 批 7 项 + B 批 TLS 入网（#79 #80 #81A）+ #16 回归

- **一句话**：按 `../cafe_dogfooding/issue-20261119.md` 复核开放项（以代码为准），用户批准「按推荐」后
  做完 A、B 两批，加上 #16 的付费行为回归（本 session 获准）。三个提交在本轮 handoff 提交之前：
  `fix: dogfooding batch A …`、`fix(tls): join by the Root's main address …`、`fix(cli): do not start a
  second daemon …`（以 `git log --oneline -5` 为准）。**都没有推送**。
- **A 批（全部先 RED 再修）**：
  - **#88** `daemon stop/restart/start` 先确认 daemon 属于当前 `CAFE_HOME`：`/api/health` 新增
    `homeId`（home 路径的哈希），旧 daemon 退回比较 host；空 home（没有 `config.yml`）直接拒绝。
    `loadConfig(home, { persist })`：只有 daemon（`runDaemon`）和 `config set` 才会生成 `config.yml`。
    测试 `tests/daemon-ownership.test.ts`（用假 HTTP 服务冒充别人的 daemon，绝不碰 4777）。
  - **#85** peer 断开时一并删掉订阅表里的空 key；metrics 新增 `subscribedThreads`。`tests/subscribers.test.ts`。
  - **#83** 新模块 `daemon/src/net-errors.ts` 的 `describeFetchError()` 读 `err.cause`。测试连接、
    保存地址都返回 `code` + 可读原因；保存时带 `verified`。Web 端 `web/src/hostReason.ts` 加 i18n
    `hostReasons` 翻成人话；不可达时不再显示「地址已保存」。截图
    `output/playwright/network-test-refused-1440.png`、`network-save-unverified-1440.png`（待你审核）。
    本机 DNS 是 fake-IP（任何名字都能解析），所以 ENOTFOUND 只用构造的错误测。
  - **#82** `barista start --agent codex --tui` 在 CLI 侧先做 probe；所有 `barista start` 都会等到
    注册成功，或者一启动就失败时报出 worker 自己的报错和日志路径并清理掉（等待上限
    `CAFE_BARISTA_START_WAIT_MS`，默认 15 s）。supervisor 连续 3 次快速失败（30 s 内退出）后停止重试，
    `WorkerInfo` 新增 `state/lastError/log`，并写进 `daemon.log`；再 start 一次会替换 failed 的 worker。
    `cafe doctor` 也会报 failed 的 Barista。
  - **#87** 顶层命令拼错给 Did-you-mean；`--json` 下所有错误都在 stdout 输出 JSON
    `{error,message,suggestions?}`，退出码 1（Commander 用 `exitOverride`）。
  - **#84** favicon 加了白色圆角底板（rx=5）。**偏差**：16px 下四个角像素是透明的，这是圆角造成的，
    不满足台账「四角 alpha 255」那条判据；深色标签栏下已清晰。要直角请说一声。
  - **#86** `/api/health` 新增 `startedAt`，metrics 新增 `*SinceStart` / `*Total` / `last*`；旧字段名保留一个版本（已获批）。
- **B 批（spec `docs/specs/v4-6-tls.md` §10.3，已获批「按推荐」）**：`root:` 永远填主地址；公开的
  `GET /api/tls` 返回 `tlsPort`，`bootstrap.ts` 的 `discoverTls()` 先走明文、失败再试 HTTPS（兼容
  `root:` 已经写 TLS 端口的旧配置）。未入网的子节点**完全不拨 Root**（`connectRoot` fail-closed），
  enrolment 按 5 s→5 min 退避（`timing.enrolRetryBaseMs/MaxMs`）。入网后 `url()` 是
  `wss://<advertise>:<tlsPort>`。`resolveDaemonUrl()` 统一处理上行、直连和 Root 的探测：明文地址
  会先查 TLS 端口再升级，绝不按明文拨号。探测通过 `daemonFetch()` 显式带上网络 CA（进程级信任库
  只装得下一个额外 CA）。doctor 新增 `tls` 检查；`/api/health.tls`；`cafe status` / `daemon status`
  多一行 `tls:`。测试 `tests/tls-join.test.ts`（7 个）和 `doctor.test.ts`。**行为变化**：直连 pin 的 key 从
  `<hostname>:<port>` 改成实际拨号的 `<address>:<tlsPort>`，旧 key 会重新 TOFU 一次。
- **#16 回归（付费，本 session 获准）**：在 cafe 仓库用 `codex exec --json -s read-only` 跑固定的 `$cafe`
  问题 5 次，**5/5 第一个工具调用都是 cafe 命令**（1 次 `cafe ask`、4 次 `cafe agents`）。建议把 #16
  按「软约束已按设计工作」关闭。顺带发现：Codex 沙箱会屏蔽 localhost，CLI 误以为没有 daemon，去启动
  第二个，报出误导性的 `EPERM daemon.stdout.log`。已修：只有 ECONNREFUSED 才自动启动，其他情况明确
  说连不上并提示沙箱。在真实沙箱里 Codex 仍然问不通 cafe，要么给 Codex 打开网络，要么让它走 `cafe mcp`。
- **验证**：typecheck；**471 tests ×2**（428 → 471）；`routing:eval` 67/67；web check + `build:web`；
  `test:release` 17/17。本机 Root 已 stop/start 到新代码：`tls: on :4778 (daemon links use wss)`，doctor
  全绿，cafe#1、orca#1 和 Discord connector 都重新连上了。
- **台账结论（台账在仓库外，没有改）**：#88 #85 #83 #82 #87 #86 #79 #80 #81A 可以按判据复核；#84 见上面的偏差；
  #81B 不是缺陷（npmjs 已有 1.4.4，CI `npm ci` 绿）；#16 建议关闭；#39 建议改成「观察」。
- **仍需你本人**：审 #83 的两张截图、#84 圆角；推送三个提交并决定是否发版（发布说明要写「pin 改为
  公钥指纹」和「`root:` 填主地址；未入网的子节点不再明文连接」）；**ssh1 子节点**要升级到新版本，
  并确认容器能出站访问 Root 的 4778，否则升级后会显示「还没加入网络」；真实 Discord 附件和重启去重
  （测试步骤见上一轮对话：附件私信、稳态重启、回答途中重启）。
- **用户审核结果（同日）**：#83 两张截图、#84 圆角、侧栏 240–420 都「当前没问题」，不改。
- **用户实测 Discord 附件私信，发现两个问题（下个 session 修，先 RED 再修）**：
  1. **Claude Code 会话 Barista 收到的问题里没有附件的本地路径**。Discord 图片随 follow-up 传过来，
     blob 已落在 `~/.cafe/artifacts/01M84JS89850YKJJYNJF0NB7Q7/01M86ZP905DBZ03VZWP84DKGVE-image.png`，
     但注入 Claude Code 的 `[cafe order …]` 提示里没有它，我是自己翻目录找到的。先查
     `packages/cli/src/bridge/session-host.ts` 和 `claude-plugin/hooks/register.ts` 组 prompt 时有没有用
     `order.attachments[].path`（pi 扩展和 Bridge 是怎么做的，可以对照 `buildPrompt`）。
  2. **Conversations 页「没看到这轮对话」，但数据其实在**：`GET /api/threads/01M84JS89850YKJJYNJF0NB7Q7`
     有 2 轮，两次 `order.replied` 都在。线索：(a) 卡片按设计用第一个问题当标题（「cafe 项目是做什么用的？」），
     追问不会生成新卡片；(b) snapshot 里这个 thread 的 `updatedAt` 是 `None`，所以追问没有把卡片顶到前面，
     还显示「10 小时前」；(c) `meta.attachments` 是 0，卡片没有 📎。先确认用户看的是哪个页面、哪张卡，
     再修 (b)(c)：追问应该刷新 `updatedAt`，追问里的附件也要进 thread 的 meta。
  - 稳态重启去重和「回答途中重启」还没测。
- **发布说明草稿（发版时用）**：
  - TLS 的对端 pin 由「证书指纹」改为「公钥指纹」：证书自动续期时公钥不变，所以 pin 不会再失效；旧的证书 pin
    会在第一次连接时自动升级，不需要手动处理。
  - `root:` 填 Root 的主地址（例如 `192.168.1.10:4777`）。子节点从主地址取得 CA 和 TLS 端口后走 `wss`；
    还没加入网络的子节点不再走明文连接，`cafe doctor` / `cafe daemon status` 会显示原因。子节点要和 Root
    一起升级，并且要能访问 Root 的 TLS 端口（默认 4778）。
  - `cafe daemon stop/restart` 只操作当前 `CAFE_HOME` 的 daemon；`barista start` 会等到注册成功，失败时直接报原因；
    `/api/health` 的 metrics 新增带口径的字段名（旧名保留一个版本）。
- **下一候选**：Network 页把「在线（它连着我）」和「地址可达（我连得到它）」分开显示（#83 第 4 点，没做）；
  CLI `cafe doctor` 的 root 探测仍用明文带 token（应改为读 daemon 自己的状态）；#71/#72 brainstorm；
  TLS phase 2；snapshot 分页 / Web 虚拟列表。

### 2026-11-24 (late) — TLS：续期 × pin × SAN 互相打架的 7 个缺陷已修；#62 侧栏可调宽；CI

- **一句话**：昨夜 #61 的「自动续期 + 每 peer 叶子 pin + 精确 SAN」三项彼此冲突，只有在真实滚动网络里
  才会暴露；连同三条救援路径一共修了 **7 个真实缺陷**，每个都先用一次性实验确认、再写会失败的测试。
- **为什么修。** 全部先做一次性实验确认、再写会失败的测试（RED），最后修复：
  1. **自定义 `checkServerIdentity` 关掉了 SAN 校验。** Node 只要收到这个选项就**替换**默认身份校验，
     不会叠加。于是 pin 检查让每条 Daemon↔Daemon `wss://` 都跳过了 SAN：实测「签给
     `somewhere.invalid` 的叶子拨 `127.0.0.1` 被接受」。`trust.ts` 新增 `pinnedIdentityCheck`：先跑
     Node 的 `tls.checkServerIdentity`，再比 pin。测试 `tests/tls-pinned-san.test.ts`（并把旧行为作为
     回归基线钉住）。
  2. **续期会换密钥 → 轮换当天全网被 pin 拒绝。** `issueLeaf` 每次都新生成 RSA 密钥，而 pin 钉整张证书；
     任何一次续期（启动窗口 / 6h tick / `renew-cert`）都会让已 pin 的 peer 全体拒绝，fail-closed 下没有
     明文救援。现在 `issueLeaf(ca, sans, days, key?)` **复用原密钥重签**（child 可只发 SPKI 公钥回来），
     `ensureLeaf` / `renew` / `POST /api/tls/leaf` / `cafe daemon renew-cert` 全链路传递。测试
     `tls-key-continuity`、`tls-renewal-keeps-key`、`tls-peer-pin` 的「真续期后不断连」用例。
  3. **pin 改钉公钥（SPKI）而非整张证书。** 证书指纹每次续期都变、公钥不变。旧证书 pin 在其叶子未变时
     仍被接受，并在该次连接里**就地升级**为公钥 pin（`checkPeerPin` 返回 `upgrade`），升级不会锁死已有
     网络。`certs.ts`: `keyFingerprintOf`。
  4. **`POST /api/tls/renew` 只换内存不落盘。** 重启后又回到旧（可能将过期的）叶子。现在走
     `tlsContext.renew`，写穿透到磁盘，返回的仍是证书指纹。
  5. **`ensureLeaf` 不检查签发者。** 只要 SAN 与有效期合适就保留叶子，哪怕它是另一个 CA 签的。子节点
     在临时本地 CA 上启动、之后入网真实 CA，就会永远带着一张没人接受的叶子，重启也修不好。现在
     `issuedBy()`（`certs.ts`）不匹配就重签（保留密钥）。
  6. **文档里的 enrolment 重试根本不存在。** `bootstrap.ts` 写着「Root 不可达时用临时本地 CA，下次拨号
     前重试 enrolment」，但没有任何重试：先于 Root 启动的子节点永远停在临时 CA（`network` 恒 false），
     永远连不上。现在 `daemon.startEnrolmentRetry()`：立即试一次，之后按叶子检查 tick 重试；
     `tlsContext.enrol` 取真实 CA、用原密钥重签叶子、翻转 `network`、重连 Root。
  7. **`cafe daemon renew-cert` 在 daemon 停着时会换密钥**（同样打掉 pin），现在复用磁盘上的密钥。
- **新增命令 `cafe host pin [host:port] [--clear]`。** 旧拒绝信息让人跑 `cafe connect --reset-pin`，这参数
  根本不存在（全仓只有这一句文案）。现在真正能清除 pin：运行中的 daemon 走 `POST /api/tls/pins`
  （热生效），同时改写 `config.yml`。`tests/tls-cli.test.ts`。
- **验证。** typecheck；**428 tests ×2**（407 → 428，新增 4 个测试文件 + 21 个用例）；`routing:eval` 67/67；web
  check + `build:web`；`npm run test:release` 全绿。用户 Root 已重启在新代码上（4777 + 4778，
  `:4778/api/health` 返回 200），叶子与重启前**逐字节相同**（89.6 天），本机 `pins: {}` 为空。
- **真实模型基线（本轮已获准付费，`magpie/group/smart`，67 题 × 2 次）**：两次采样分别
  **133/134 = 99.3%**（p50 3718ms，p95 5546ms，1 个不稳定用例）与 **134/134 = 100%**（p50 3802ms，
  p95 5983ms，3 个不稳定用例）；两次都 0 fallback。波动全部落在无明确 owner 的短句上
  （`what is the meaning of life`、`帮我随便看看`、`hello`），top-k 在 docs/db/search/mobile 间摇摆。
  提交的 `docs/eval/routing-2026-11-24.json` 是第二次；#39 per-target 变体落地后的新基线，
  旧的 2026-11-21 基线（124/126）仅作历史对照。
- **spec / 文档。** `docs/specs/v4-6-tls.md` 新增 §10.1 与 §10.2（as-built 记录全部 7 项）；README /
  README_zh / SKILL 的 TLS 段改为「续期保留密钥、公钥 pin、`cafe host pin --clear`」。
- **#62 侧栏可调宽（用户早先要求「加 1/4」）。** 宽度收成单一来源 `--nav-width`（默认 300px，
  240–420 可拖）；`Shell.tsx` 用 `w-[var(--nav-width)]`，宽屏 drawer 的
  `calc(100vw - var(--nav-width) - 680px)` 自动跟随。拖拽手柄在侧栏右边界（`role="separator"`，
  方向键 ±16px、Home/双击复位），宽度存 `localStorage["cafe.nav.width"]`，`max-md` 下隐藏手柄。
  侧栏窄于 290px 时用容器查询隐藏 kind tag，让 Agent 名先显示。测试 `tests/web-nav-width.test.ts`
  锁住「不许再出现第二处 `240px`」。浏览器实测：1440/1920 拖拽与复位、刷新保持、390 移动端无手柄、
  drawer 几何 `1920-420-680=820px` 正确。截图 `output/playwright/nav-1440-360.png`、
  `nav-1920-360.png`、`nav-390.png`（供你复核样式）。
- **CI（新增）。** `.github/workflows/ci.yml`：typecheck、全量测试、`routing:eval`、web check/build、
  `test:release`；Claude plugin 测试单列一个 job，runner 上没有 `claude` 时跳过而不是红。
- **仍需你本人**（与上一批相同）：真实 Discord attachment DM + 重启去重；付费模型运行逐个批准；推送 +
  发版。CI 第一次运行要等你推送后才会触发。
- **下一候选**：snapshot 分页（`/api/threads?before=` 已有，Web「加载更早」可用）；`appendEvent`
  异步化（有丢数据风险，我倾向不做）；#71/#72 团队与编排（需 brainstorming + spec）；TLS phase 2
  （mTLS、ECDSA）；#18 token 写入。

### 2026-11-24 (night) — TLS hardening, Web小修, 测试去抖, 打包/ sim 修复

- **Current checkout.** `git status --short --branch`、`git log --oneline -6`
  到达时先看；本轮在 `0eec58a` 之后新增 4 个提交（`fix(web): crisp cup favicon…`、
  `fix(tls): renew leaves before expiry…`、`fix: keep scratch daemons off the TLS port…`、
  `fix(tls): require an exact SAN match…`）。**已全部推送到 origin/main 与否以 `git log origin/main..main` 为准**；本轮没有推送（用户自己推）。工作树干净。
- **TLS 修了三个真实问题（都有 TDD 测试，每个都先看 RED）**：
  1. **叶子到期炸弹**：叶子 90 天，唯一续期手段是手动 `cafe daemon renew-cert`；
     `ensureLeaf` 只在 SAN 变化时重签，重启也不会续。现在：启动时若叶子进入
     **21 天窗口**就重签；运行中的 Daemon 每 **6 小时**检查一次（`timing.leafCheckIntervalMs`，
     测试可调），续期后通过 `setSecureContext` 热换并**写回磁盘**；无 CA key 的子节点
     向 Root 请求，Root 不可达则下次 tick 重试。文件：`tls/store.ts`（`leafNeedsRenewal`）、
     `daemon.ts`（`startLeafRenewalCheck` / `tlsContext.renew`）、`index.ts`。
     测试：`tests/tls-lifecycle.test.ts`、`tls-renewal-predicate.test.ts`、`tls-runtime-renewal.test.ts`。
  2. **per-peer 叶子 pin 从未被调用**：`security.tls.pins` 只有纯函数 `checkPeerPin` 和单元测试，
     没有生产调用者。现在 daemon-to-daemon 的 `wss://` 连接传 `checkServerIdentity`：首次见到叶子
     按 `host:port` 记录（TOFU，落盘 config），之后叶子不同即拒绝并打印双方指纹。
     文件：`daemon.ts` `linkOptions(peerAddr)` / `recordPeerPin`；测试：`tests/tls-peer-pin.test.ts`。
  3. **SAN「覆盖」判断是子串匹配**：`IP Address:127.0.0.1` 会命中 `127.0.0.10`，`DNS:desk` 命中
     `desk.example`，改地址后保留旧叶子、连接被 ALTNAME 拒绝（正是 SAN 要防的）。现在 `sanCovers()`
     做整项精确匹配；`advertise` 同时剥 IPv6 方括号。文件：`tls/certs.ts`、`tls/store.ts`；
     测试：`tests/tls-san-coverage.test.ts`。
- **Web 小修（用户当场批准）**：#74 favicon 从内联 ☕ emoji 换成 `packages/web/public/icon.svg`
  （与侧栏同一只杯子，线描，无 `<text>`）；#63 omp 标签从 `oh-my-pi` 改为 `omp`（中英两处）；
  #64 ≥1920px 时隐藏正文的「状态/参与/轮次/路由」摘要格（`.thread-summary`），右侧 rail 只留
  状态与参与——thread id（header 已有）和投递日志（正文 Disclosure 已有）不再重复。
  测试：`tests/web-icon.test.ts`；浏览器实测：1440 显示摘要格无 rail，1920 反之，标签显示 `omp`。
- **打包/脚本回归（TLS 批次引入）**：`scripts/test-release.mjs` 与 `scripts/sim-hosts.sh` 写的临时
  config 没有 `security` 块，落在默认 `tls` + 固定 4778；只要本机跑着真实 Root，`npm run test:release`
  就在 `daemon start` 挂 `EADDRINUSE 0.0.0.0:4778`，sim-hosts 三个 daemon 也会互抢。两处都改为
  `security.mode: plaintext`；`tests/scratch-configs.test.ts` 锁住。
- **测试去抖 #78**：connector 崩溃重启用例在 `restarts: 1` 出现的瞬间读日志，与重启子进程的首个
  heartbeat 写入竞态（约 1/25）。改为等日志里真有 heartbeat；fixture 故意把首次心跳延后 1.2 s，
  让竞态每次必现而不是偶发。
- **验证**：`npm run typecheck`；**407 Vitest 测试**（77 文件）；`npm run routing:eval` **67/67**；
  web `check` + `build:web`；`npm run test:release` **17/17**。用户 Root 已重启在新代码上
  （4777 + 4778，pid 142），真实叶子 89.7 天，CA 约 10 年。
- **仍需本人（本 session 没做）**：真实 Discord attachment DM + 重启去重；每个付费模型运行单独批准；
  推送 + 发版仍是用户自己。
- **本轮没动**：`appendEvent` 仍同步 `appendFileSync`（异步化有丢数据风险，属性能项，见 §7）；
  snapshot 仍固定 200（`/api/threads?before=` 已分页，Web「加载更早」可用）；Web 列表虚拟化；
  #71/#72 团队编排；TLS phase 2（mTLS、ECDSA 叶子——`node-forge` 无 EC keygen）。
- **Dogfooding ledger is stale.** `../cafe_dogfooding/issue-20261119.md` still lists #61 (TLS), #77
  (stale pin on clear — fixed in `538014e`, `tests/host-address.test.ts` covers it) and #78 (connector
  restart wait — fixed this batch) as 未决, and #63/#74/#64 as 未决. That file lives outside this repo
  and was not edited; trust the code and this handoff over the ledger for those rows.
- **Suggested skills**：`superpowers:test-driven-development`（本轮全部如此）、`playwright`（UI 实测）、
  `cafe`（网络诊断）。

### 2026-11-24 (later) — per-target questions (#39) and TLS (#61) implemented

- **Current checkout.** `git status --short --branch` and `git log --oneline -5`
  on arrival; the latest subjects are `feat: per-target sub-questions (#39) and
  TLS transport (#61)` and `fix: pass the Discord dedupe nonce in the single
  options object`. The Discord-status branch was fast-forwarded into `main`
  first, so `main` carries everything. Nothing is pushed.
- **#39 implemented** (spec `v4-7-per-target-questions.md`, now marked
  implemented). `Order.variants` / `RoutingDecision.variants` are optional maps
  keyed by agentId. `dispatch()` sends each target only its own text and strips
  the map; history and the recorded Order keep the shared `body`. The rules
  router splits only an explicit two-clause structure, verbatim, and only when
  the clauses point at different Agents; otherwise a shared-body multicast. The
  LLM router keeps model variants for real multicast targets only. Tests:
  `tests/per-target-questions.test.ts`, `tests/router-control.test.ts`, plus an
  eval case in `tests/routing-fixtures.ts`. Rules baseline **67/67**.
- **#61 implemented, phase 1** (spec `v4-6-tls.md`, now marked implemented with
  honest boundaries). New `packages/daemon/src/tls/` (`certs.ts`, `trust.ts`,
  `store.ts`, `bootstrap.ts`). A second `https` listener on
  `security.tls.port` (default 4778) shares the handlers with plaintext 4777.
  Fail-closed, SAN + a separate per-peer pin, TOFU-with-fingerprint enrolment,
  hot renewal via `SNICallback` + `setSecureContext` (`cafe daemon renew-cert`).
  `?token=` removed. `cafe root show` prints the CA fingerprint;
  `cafe connect --ca-fingerprint` validates before writing. Node floor is now
  **≥ 22.19**. Tests: `tests/tls-*.test.ts` (certs, trust, server, client, child,
  bootstrap, renew, cli, untrusted, security-token).
- **Leaf keys are RSA-2048, not ECDSA.** `node-forge` 1.x has no EC key
  generation. Documented in the spec; moving to ECDSA is a later change.
- **Discord nonce fixed and verified in the adapter.** `discordjs.ts` now sends
  one options object; `tests/discord-connector.test.ts` drives the real send path
  with a fake client and a fake module. The local connector was restarted and
  reports `connected`; the installed `@cafe/connector` is a symlink to this repo,
  so it runs the fixed adapter.
- **Live state.** The user's Root was restarted on this code: listening on 4777
  (plaintext, Web UI + loopback) and 4778 (TLS), `~/.cafe/tls/` has `ca.crt`,
  `ca.key`, `<host>.crt`, `<host>.key`, and `cafe root show` prints the
  fingerprint. The Discord connector was restarted and is `connected`.
- **Still needs a person.** Real Discord **attachment** DM and a real
  **restart/replay** deduplication check (the code path is unit-tested; a live
  bot round trip needs the owner). Any **paid real-model** run (routing sample or
  TUI Bridge) still needs its own approval.
- **Verification.** Typecheck, web check + `build:web`, **391 Vitest tests ×3**,
  routing eval **67/67**, packed release smoke **17/17**. Three team cases stay
  blocked and unscored. The Claude plugin was unchanged.
- **Suggested skills.** `cafe` for live status, `playwright` for Web checks,
  `superpowers:test-driven-development` for follow-ups. TLS phase 2 (mutual TLS,
  ECDSA leaves) is the natural next design step if the owner wants it.

### 2026-11-24 — Discord live test and Connectors in Agents

- **Current checkout and runtime.** Check `git status --short --branch` and
  `git log --oneline -5` on arrival. The follow-up batch groups Discord install,
  status and UI fixes with the approved spec decisions. The local Root and Discord
  connector were restarted after the changes. A read-only handoff check returned
  Root `0.1.4` healthy and Discord `connected`.
- **Real Discord verification.** A private text DM went through the local
  connector, reached a Barista, and got a reply. The owner confirmed the round
  trip. DMs and attachments are enabled locally with a single-user allowlist.
  A real attachment DM and restart/replay deduplication remain to be tested.
- **Where to look.** The Agents page and expanded Agents sidebar share one poller.
  Both show connectors on the daemon serving the page and label Discord as
  `Discord Connector`. The separate Network panel was removed. Browser checks
  covered both placements and recovery from a failed status refresh. For the
  status contract see `packages/daemon/src/connector-status.ts` and
  `tests/connector-status-api.test.ts`. For install, attachments and Discord
  readiness tests see `tests/connector.test.ts` and `tests/discord-connector.test.ts`.
- **Adapter follow-up.** `packages/connector/src/discordjs.ts` still passes the
  nonce as a second argument to `send`. The installed discord.js takes one options
  object. Correct that call and verify real replay deduplication before relying on
  it. Connection state already tracks gateway reconnect, resume and disconnect.
- **Approved designs.** [TLS #61](../specs/v4-6-tls.md) and
  [per-target questions #39](../specs/v4-7-per-target-questions.md) are approved
  and awaiting implementation. Start from the recorded decisions. For TLS, keep
  CA trust bootstrap and per-peer identity pinning distinct and preserve SAN
  verification. Agent teams #71/#72 and Orca integration #73 are separate work.

- **Verification.** Root and Web typechecks, Web build, 342 Vitest tests, 65/65
  offline routing cases, and 17 packed release checks passed. Three team cases
  remain blocked and unscored. The Claude plugin was unchanged in this batch.
- **Suggested skills.** Use `cafe` for live status, `playwright` for Web checks,
  `superpowers:systematic-debugging` and `superpowers:test-driven-development`
  for the nonce follow-up, and `superpowers:writing-plans` for the approved specs.

### 2026-11-23 — Discord connection status in Web

- Network → External connections lists connectors on the current node. Discord
  readiness comes from the current connector process. The read-only
  `/api/connectors` response contains names and status only.
- The local daemon and Discord connector were restarted. A real browser showed
  Discord as connected. The fake Discord DM test verified that the resulting
  Thread enters the Web snapshot with Discord provenance. Real DM delivery is
  left for the owner to test.
- Typecheck, Web check and build, and 342 Vitest tests passed.
- The Web panel keeps the last successful status during refresh failures and
  marks it as stale. It pauses polling in hidden tabs and announces state
  changes to screen readers. Browser verification covered an authorization
  error followed by recovery. The local daemon was restarted after the change.

### 2026-11-23 — design decisions and private Discord attachment checks

- The owner approved all decisions in the TLS and per-target question specs,
  including SAN validation plus fingerprint pinning. Both are pending implementation.
- The owner's existing Discord bot is used in DMs. The local Cafe connector list
  was empty and its Discord config did not exist. The bot's host or integration is
  needed to enable attachments on the intended instance.
- The Discord adapter now rejects redirects during attachment downloads. An
  attachment-only DM uses a short Order body and keeps file bytes in the attachment.
  Verified with a fake Discord platform and a loopback Cafe daemon. Typecheck, the
  full Vitest suite (340 tests), and offline release smoke (17 checks) passed.
- The local Discord connector is now installed. `allowDMs` and `allowAttachments`
  are enabled. A bot token is configured and the connector is stopped while the
  owner supplies the Discord user ID for `allowUsers`.
- Install the Discord dependency before linking the Cafe SDK, since npm prunes
  those links. Resolve `discord.js` from the installed connector directory. The
  local install loads the entry and the real adapter without a Discord login.
  Typecheck, 341 Vitest tests, and 17 release smoke checks passed.
- Real login and reply delivery remain unverified. Follow-ups in the adapter are
  reporting pre-ready login rejection and passing the nonce in the single
  message options object accepted by discord.js.

### 2026-11-23 (later) — release-review fixes, Discord attachments/nonce, two specs

**Current state of this batch.** The review fixes, Discord changes, and specs were
committed separately. The local Root was restarted after this batch.

**Implemented.**

1. **#65 Origin is now same-origin, not same-hostname.** `originAllowed()` compares
   the Origin's scheme + host + port against the `Host` header the request arrived
   on, and still requires the host to be one this machine answers to. A different
   port or scheme on a trusted name is refused. Two new cases in
   `tests/security.test.ts`.
2. **#75/#76 address handling.** `cafe connect` and `cafe root set` validate with
   `assertDaemonAddress()` **before** writing config. `setHostAddress(…, null)`
   falls back to the verified address instead of keeping the stale pin, and a pin is
   broadcast only after the reachability probe records it in `knownDaemons`
   (`verifiedAddress()` now requires `knownDaemons[host] === pin`). mDNS and
   `url()` share one formatter (`advertisedAddress()`), so `advertise: host:port` can
   no longer produce `host:port:port`. Tests in `tests/host-address.test.ts`,
   `tests/cli.test.ts`, `tests/address.test.ts`.
3. **#60/#31 follow-up and cancellation.** `daemon.closingEvent()` reads a turn's
   `order.closed` from the Thread file, and `stream()` replays it when the bounded
   200-event page did not contain it — so `cafe wait` on an old turn finishes. A
   failed cancel is reported as `could not cancel it (…)` instead of claiming the
   question was cancelled. Tests in `tests/events.test.ts`, `tests/cli.test.ts`.
4. **#69 cache correctness.** Vite now emits content-hashed asset names, and the
   server marks a file `immutable` for a year **only** when its name carries a
   hash; everything else is `no-cache`. Tests in `tests/static-assets.test.ts`.
   `packages/web/dist` was rebuilt, so `web/index.html` now points at hashed files.
5. **Discord attachments + outbound nonce (#28 leftovers).** `allowAttachments`
   (default off), `attachmentHosts` (default `cdn.discordapp.com`,
   `media.discordapp.net`, exact match, https only) and `attachmentMaxMb` (default
   25) in `readConfig()`/`useReason()`; an attachment-only message is accepted when
   enabled. On the inbound path the connector downloads via
   `DiscordPlatform.download()`, uploads through `CafeHttpClient.uploadAttachment()`
   and sends metadata only — file bytes never enter the Order body. Outbound chunks
   carry a stable `sha256(eventId:index)` nonce and the discord.js adapter passes
   `enforceNonce`, so a crash-recovery resend cannot double-post. Tests in
   `tests/discord-connector.test.ts` (fake platform, 11 cases).
6. **Two specs, decisions complete, no code:** [`v4-6-tls.md`](../specs/v4-6-tls.md)
   (#61: two ports, Root CA, TOFU + fingerprint pin, fail-closed, hot renewal;
   Q1–Q5 with recommendations) and
   [`v4-7-per-target-questions.md`](../specs/v4-7-per-target-questions.md) (#39:
   optional `Order.variants` map keyed by agentId, shared `body` fallback, history
   records the shared body; Q1–Q4).
7. **Test helper fix.** `waitFor()` treats a throwing predicate as "not yet" (the
   supervisor runtime file is written after the predicate first runs); the whole
   suite had one flaky failure from this, now three consecutive green runs.

**Verification.** Typecheck, web `check` + `build:web`, **338 tests ×3**, rules
eval **65/65**, packed release smoke **17/17**. Local Root restarted on this code.

**Decision status.** The owner approved both specs after this batch. The decisions
are recorded in each spec. Implementation is pending.

**Still open.** Real Discord end-to-end (needs the bot token + Message Content
intent; attachment download needs the connector restarted with the new config);
Web virtualization, snapshot paging, #27 network-wide announcements, #18 token
management, Q88/#16 paid runs (each needs its own approval). #62/#63/#64/#74 Web
changes still need an approved prototype.

### 2026-11-23 — Wave 1+2 dogfooding batch

**Current state.** The batch is in two local commits. Find them by the subjects `fix: close the browser-facing auth hole, bad daemon addresses, and unicast hangs` and `fix: refuse unknown /api/baristas fields instead of ignoring them`. The local Root was restarted after the follow-up fix and still reports `0.1.4`. A read-only health check during this handoff confirmed it is serving and exposes the new listener, connection, and hint metrics. The restart mentioned in the previous batch is no longer pending.

**Implemented.** #65 adds a Host check for loopback requests and Origin checks for HTTP writes and WebSocket upgrades. Loopback still skips tokens. The follow-up commit rejects unknown Barista start fields before reaching the supervisor. #75/#76 add Root-side address overrides in the CLI and Network page, filter child addresses sent to peers, and keep a malformed saved Root address from crashing the Daemon. #60 adds the unicast deadline, `ask --timeout`, interrupt cancellation, and `--replace`. Wave 2 covers connector exit handling and test synchronization, CLI diagnostics, capped daemon logs, FTS and hint costs, static assets, connection metrics, and bounded Thread reads (#31, #56–59, #66–70). See the commit diffs and the sibling ledger `../cafe_dogfooding/issue-20261119.md` for details.

**Verification from the batch.** Typecheck, web check/build, 320 Vitest tests, rules eval 65/65, packed release smoke 17/17, and Claude plugin tests 5/5 passed. The final Barista validation fix was followed by a full 320-test run and a live check confirming rejection with no new worker. The initial live probe had started the default pi worker because unknown fields were silently dropped. That worker was stopped. `perf:store` added zero FTS rows for 1,000 heartbeats and measured the grouped hints query at 51.5 ms versus 458.6 ms for the old row-fetch path in the same synthetic 200k-row run.

**Review before the next release.** The following are from a source check during handoff. Keep new regression checks in isolated `CAFE_HOME` instances.

- **#65.** Review full Origin matching, including scheme and port. The current comparison uses the origin hostname. Existing tests and live checks covered the original cases. See `packages/daemon/src/server.ts` and `tests/security.test.ts`.
- **#75/#76.** Verify `--clear` restores the advertised or learned address and propagates the change across multiple Hosts. The current clear branch leaves the previous URL in the in-memory record. A manually pinned address can be shared without a reachability probe. `cafe root set` writes config before the live API validates it, and mDNS still formats `advertise` separately. See `packages/daemon/src/daemon.ts`, `packages/daemon/src/index.ts`, and `packages/cli/src/main.ts`.
- **#60/#31.** CLI cancellation is best-effort and can report success after a failed cancel request. Test that an SSE subscriber following an older Order can finish when its terminal event is outside the 200-event replay window. Synchronous event appends remain. See `packages/cli/src/main.ts` and `packages/daemon/src/server.ts`.
- **#69.** The built JS/CSS paths are stable and the server marks them `immutable` for one year. Verify an upgrade with an already-warm browser cache and align the cache policy with the filenames. See `packages/web/vite.config.ts` and `packages/daemon/src/server.ts`.

**Agreed next work.** #61 TLS gets its own design and rollout round. #72 is a draft and offline eval coverage only. Three team cases are blocked and excluded from the 65-case score. Review the proposed collect, parallel sub-Order and direct-leader clarification semantics before implementing them. #71 team/channel design and #73 Orca integration are separate efforts. See [`v4-5-agent-teams.md`](../specs/v4-5-agent-teams.md).

**Still open.** #62/#63/#64/#74 Web changes need an approved prototype. Web virtualization, snapshot paging, #39 per-target questions, #27 network-wide announcements, and #18 token management remain on the backlog. Real Discord end-to-end needs a supervised test in an allowlisted channel with Message Content intent. Use a fresh bot token via secure local configuration. Q88/#16 real-model runs still need separate approval per paid run.

**Done on 2026-11-23 in the dogfooding + Discord batch** (the user asked to work the `cafe_dogfooding/issue-20261119.md` ledger by priority against the current code, decide fixes on their own judgement, skip anything needing a person, and hand off; they went to rest):

1. **#55 (claude install lies)** — `cafe claude install` now sets exit 1 when any `claude plugin ...` command fails and prints "the plugin is not registered"; `cafe commands status` asks `claude plugin list` (`claudePluginState()`) instead of trusting the `CAFE_HOME/claude-marketplace` folder, so a failed install reads `missing`/`unavailable`, never `installed`. Tests: `tests/commands.test.ts` (fake `claude` on PATH, marketplace-without-registration, broken binary → exit 137).
2. **#6 (test flake)** — the remaining `bridge.test.ts > a cancel …` failure was a real fixture race: the fake Codex app-server dropped `turn/interrupt` when it arrived before the SLOW turn registered its waiter, so the turn never completed. Fixed in `tests/fixtures/fake-codex.mjs` with an early-interrupt set. **11 consecutive `tests/bridge.test.ts` runs green, and the full suite green 3× at 276 tests (plus 4× at the 271-test state before the Discord tests)**.
3. **#28 Discord (real platform)** — `packages/connector/src/discord-core.ts` (platform-independent core: allowlist filter, `requireMention`, `allowDMs`, `@everyone` rejection, chunking to 2000 chars, idempotent event → Order → SSE follow → reply) + `discordjs.ts` (real adapter, `discord.js` imported lazily, never Node's global WebSocket) + `packages/connector/discord/` manifest. **Unit + end-to-end tests with a fake platform** (`tests/discord-connector.test.ts`). `cafe connector install` installs `discord.js` into the connector's own dir (`CAFE_CONNECTOR_SKIP_RUNTIME=1` for offline). **A real Discord run is left for a supervised session** (needs the bot token + Message Content intent).
4. **#28 connector supervision + packaging (the known issue the user asked about)** — connectors now run under a foreground `cafe connector supervise <name>`: unexpected exit → backoff restart; >5 exits/60 s → status `crashed` (no infinite loop); stop signals the whole process group. `run.json` carries the supervisor pid + `childPid`. The `@cafe/connector` SDK **ships in the release package** (`connector/`, JS bundles + the Discord connector), so `cafe connector install` resolves it from a published cafe; `linkSdkPackages` finds the bundled copy. Tests: crash-then-recover, crash-loop give-up; release smoke installs the packaged Discord connector.
5. **#34/#31 scale** — FTS5 **trigram** search index (`search_index`) maintained on `recordEvent`, backfilled at startup for Threads that predate it; `search()` uses the index for 3+ char queries and falls back to the JSONL scan for shorter ones. `saveRegistry` only rewrites changed rows (a version bump alone skips row writes). `staleThreads` filters status in SQL; `deleteThreads` is one transaction. In-memory `metas`/`knownOrders` are **LRU-bounded** (`CAFE_META_CACHE_MAX` 2000, `CAFE_KNOWN_ORDERS_MAX` 10000; 0 disables). Benchmark (`npm run perf:store`, 2000×20 index): index build 320 ms, **FTS query 0.3–0.6 ms vs ~90–105 ms scan**; `tests/cache-bounds.test.ts`, search tests in `tests/retention.test.ts`.
6. **#33 web store** — `appendEvent` now batches a burst into one `set()` + one array copy (was `[...events, env]` per event), dedupes by id. Web `check` + `build:web` pass.
7. **`cafe skill install --dry-run / --force`** — repoints a stale link to another checkout instead of "remove it to relink" (from the ledger's "confirmed not a defect" note).
8. **Verification**: typecheck; web check + `build:web`; **276 tests ×3 (plus two more full-equivalent runs, 11× bridge alone)**; `routing:eval` 63/63; `test:release` **17/17** (packaged Discord connector installs, SDK links). `npm run perf:store` numbers above.
9. **Remaining from that batch**: real Discord end-to-end, the paid Q88/#16 TUI Bridge runs, #39 per-target sub-questions (needs a wire spec), Web virtualization (#33), and snapshot paging (#34). The feature commit is `feat: Discord connector, connector supervisor and packaging, FTS search, honest claude install`. The connector is opt-in and needs local bot configuration. The restart deferred at that handoff was completed in the later Wave 1+2 batch above.

**Done on 2026-11-21 in the UI / reliability batch** (the user reviewed the web UI and the dogfooding ledger, chose to finish the agreed plan, asked for parallel subagents, and went to rest; Q2 was revised to "one intuitive `/cafe` across Claude/pi/omp, rename the inconsistent group"; Q3 = observability only, no per-target sub-question wire change):

1. **Web UI (user-requested)**: sidebar Agent rows no longer render a `⋯` button (it fell onto an implicit second grid row). Right-click, or Shift+F10 / the Menu key on the focused row, opens the same Rename / Add alias / Copy address menu; menus close on an outside click or Esc via the shared `packages/web/src/ui/useDismiss.ts` (also used by the Agents card menu). Agents cards now show the real working directory in 目录 and the `.cafe` scope in a separate 负责范围/Covers row — previously the 目录 row showed `scope[0] ?? cwd`, so `.`/`src` appeared instead of the directory. Verified in a real browser.
2. **#6 closed**: `keepAlive()` reads `CAFE_HEARTBEAT_INTERVAL_MS` (test hook); `vitest.config.ts` sets 200 ms so a Bridge survives the FAST 600 ms lease. `tests/heartbeat.test.ts` acks, waits 900 ms, replies. Three consecutive full runs were green; one later full run had an unrelated `supervisor.test.ts` flake that passed in isolation and on rerun.
3. **Dogfooding probes**: `GET /api/health` now returns `metrics` (threads, events, appendBytes, metaWrites, metaBytes, snapshotMs, searchMs, eventLoopLagMs); `store.appendEvent`/`putThread` return byte counts so the counters do not re-serialize. `GET /api/search?stats=1` returns `{results, scanned, elapsedMs, truncated}` (default array shape unchanged; 1 s budget). `tests/metrics.test.ts`.
4. **#27 service-managed first update**: `retargetInstalledService()` rewrites an installed launchd/systemd unit to `current/bin/cafe.js` (or kickstarts it when already pointed there) before the health check, preserving the installed node/PATH; `apply` and `rollback` start through it. `tests/service.test.ts`; the v4-2 caveat is updated.
5. **Claude slash commands (Q2)**: `/cafe` is now the Customer command in Claude Code (`~/.claude/commands/cafe.md` with `agents|ask|status|thread|help`, same as pi/omp); the plugin's pause/resume is `/cafe-barista` and the plugin never claims `/cafe`. `cafe commands install` removes a legacy `/cafe-ask.md` only when the cafe marker is present. Doctor, README, README_zh, skill and `cafe commands status` were updated; the plugin tests are 5/5.
6. **#39 observability (no wire sub-question)**: `RoutingDecision` gained `confidence`, `whyNot` and `fanout`; the rules router fills a margin-based confidence and runner-up reasons, the LLM router a mode-based confidence and fallback reasons. `routingStats()` + `GET /api/routing/stats` + a `cafe stats` line report the recent unicast/multicast/broadcast mix, average fan-out and first-reply/close latency from ThreadMeta (no JSONL scan). Per-target sub-questions remain deferred to a one-page spec.
7. **#28 mock connector**: `@cafe/connector` SDK (HTTP/SSE client, `threads.json` mapping, `seen-events.json` dedupe, `outbox.json` state machine, atomic writes, stdout heartbeat/error protocol), a mock connector (stdin JSON lines, allowlists, or local HTTP ingest via `config.ingestPort`), `cafe connector install|list|status|start|stop|restart|logs|config|remove` (detached process, log under `CAFE_HOME/logs`, pid/restart state, remove refuses foreign dirs unless `--force`), and `POST /api/orders` `idempotencyKey` (10 min / 1000 entries, concurrent duplicates await the first). `tests/connector.test.ts` covers the round trip, duplicate event ids, restart mapping, allowlists, HTTP ingest, the CLI lifecycle and idempotency. Real Discord is next; the demo recipe is in `docs/specs/v4-3-connector-sdk.md`.
8. **Verification**: `npm run typecheck`; web `check` + `build:web`; **258 tests**; `npm run routing:eval` 63/63; `npm run test:release` (13/13); `npm run perf:store`; real-browser checks of the sidebar menu and Agents cards. The launchd daemon was restarted on this code (0.1.4); `/api/health` returns `metrics` and `/api/routing/stats` responds.
9. **Commit**: the batch is one commit at handoff time (see `git log`; the handoff update is in it).

**Still waiting / next session (from this batch):**

1. **Claude commands migration**: run `cafe claude install` (the plugin copy in `CAFE_HOME/claude-marketplace` keeps the old `/cafe` pause/resume until it is rerun) and `cafe commands install --agent claude` (writes `~/.claude/commands/cafe.md`; removes a cafe-owned legacy `cafe-ask.md`). Running sessions need `/reload-plugins` or a restart.
2. **Real Discord**: the user supplied a bot token in chat (never write it to the repo). Enable **Message Content** in the Discord Developer Portal, install a Discord connector, test in an allowlisted guild channel, then rotate the token. Follow the openclaw notes: durable ingress keyed by event id, one fixed preflight filter chain, `nonce` + `enforce_nonce` for outbound dedup, fatal-vs-transient close codes, 2000-character chunking, and a CDN allowlist for attachments.
3. **#27 leftovers**: network-wide announce/canary/batches, signatures; Web-triggered upgrades stay CLI-only by decision.
4. **#39 leftovers**: per-target sub-questions (needs a one-page wire spec), cross-daemon decision cache, richer model-provided confidence/why_not.
5. **Scale**: FTS/virtual lists; sync `appendFileSync`; unbounded `metas`/`knownOrders`; snapshot paging.
6. **Paid runs**: Q88 two TUI Bridge runs + the #16 `$cafe` regression (supervised tmux, isolated configs); every paid run needs its own approval.
7. **#18**: token write / read-only token deferred; model-id pre-validation still open.

**Done on 2026-11-21 in the routing / attachments batch** (the user chose small fixes + #39 + #20 phase 2, answered the three #39 questions as: bounded **top-k** default with an explicit broadcast path, multicast decline/silence is **skipped**, and **no `domain` in the wire**; they also approved the #31 subset: tail-read paging + bounded metadata + a benchmark script):

1. **#54 (SSE)**: `stream()` guards `writableEnded/destroyed`, calls an idempotent `done()` before `res.end()`, registers close handlers before replay, and the ping uses `CAFE_SSE_PING_MS` for tests. `tests/events.test.ts` reproduces `ERR_STREAM_WRITE_AFTER_END` via an earlier-turn replay.
2. **#6 (tests)**: `untilClosed(c, threadId, orderId?, timeoutMs?)` anchors on the current Order; passing an old third number still means timeout. All test call sites were updated; `tests/until-closed.test.ts` covers the race.
3. **#40**: `cafe barista start --agent codex --tui` probes for a Codex session in the directory and refuses before registering (`CodexTuiEngine.probe()`), with a `next:` command. Model-id pre-validation is still deferred (provider metadata is needed).
4. **#46**: `renameHost(host, displayName, { aliases, removeAliases })`; `host/identity` handles `removeAliases` both ways; `POST /api/hosts/rename` accepts alias edits; Settings has remote Host alias chips. Covered by `tests/identity.test.ts`.
5. **#45**: nav Agent rows now have the same Rename / Add alias / Copy address menu as the Agents page, opened by `⋯` or right-click.
6. **#31 subset**: `Store.readEventsPage` reads backwards from the end (chunk carry, `hasMore`); `daemon.thread` uses it; `ThreadMeta.replies/declines` are bounded at 50 per turn (the JSONL is still the full history). `npm run perf:store` shows the 5000-write benchmark dropping from ~6.8 s / 1.4 MB metadata to ~0.9 s / 15 KB.
7. **#39**: rules now stem English plurals, weight longer/action tokens, multicast separable questions, and fan out to at most `TOP_K=3` when nobody matches; broadcast only with `cafe ask --broadcast`, MCP `broadcast: true`, or the Web composer checkbox. LLM: rewritten policy prompt, output de-dup/order/cap, unrequested broadcast downgraded, bounded decision cache. Fan-out closes `graceMs` (2 s) after the first final reply and marks silent targets `skipped` (an `order.declined` with `unavailable: true`). `routing:eval` is **63/63**, `--repeat` reports unstable cases, `--min-accuracy` / `--max-unstable` gate.
8. **#20 phase 2**: `OrderHandle.reply(text, final, attachments?)`; the daemon commits staged blobs into the Thread before `order.replied`; pi/omp `cafe_reply` accepts local paths and uploads first; receiving daemons register remote metadata so downloads proxy to the Barista's host; Web reply entries already render the link.
9. **Verification**: typecheck, web `check` + `build:web`, **229 tests**, `routing:eval` 63/63 (×2 stable), `perf:store`, `test:release` all pass. The launchd daemon was restarted on this code.
10. Commits: `fix: SSE close guards, follow-up test race, and remote host aliases`; `perf: tail-read Thread pages and bound metadata summaries`; `feat: routing accuracy — stemming, bounded fan-out, stable LLM output`; `feat: Barista reply attachments and cross-host download proxy`.

**Done on 2026-11-21 in the autonomous continuation batch** (the user went to rest, approved paid model runs, and asked to finish #27 and the #20 leftovers; anything that must wait for a person is recorded below):

1. **#20 leftovers**: `cafe reply <threadId> --agent <address> [--attach file] "text"`, MCP `cafe_reply`, and `POST /api/threads/:id/reply` let an external process reply as a target Barista (the daemon checks the agent is a target of the open Order). Bridge / `cafe serve` replies parse `CAFE_ATTACH: <path>` lines (shared `packages/cli/src/artifacts.ts`). A Customer's daemon queues remote attachments and retries every 30 s (persisted in kv `pendingPulls`), so downloads work after the origin returns. Orphan staged uploads older than 24 h are cleaned daily. The Web composer shows per-file upload progress (XHR). Tests: `tests/reply-entry.test.ts`, plus serve/attachments cases.
2. **#27 MVP**: `cafe update status|check|apply|rollback`, `cafe daemon drain`, `cafe protocol-version`. The independent updater (`packages/cli/src/update.ts`) stages `releases/<version>`, validates name/version/files/optional sha256/protocol, drains → stops → atomically switches the `current` symlink → starts → health-checks, and auto-rolls-back to last-known-good on failure. State lives in `update.json` with a concurrency lock; `GET /api/update` and a Settings section show it read-only. `cafe daemon install` prefers `current/bin/cafe.js` once a release exists. `tests/update.test.ts` drives a fake release CLI through success, failed-health rollback, manual rollback, and package/checksum/protocol rejection, plus drain semantics. Spec v4-2 marked implemented (with a service-managed first-update caveat).
3. **Orca**: added `/Users/biran/code/skills/orca/Orca/.cafe` (barista identity) and `.cafe` to that repo's `.gitignore` (user request, outside this repo).
4. **Paid routing sample (approved, run once)**: `npm run routing:eval -- --model magpie/group/smart --repeat 2 --out docs/eval/routing-2026-11-21.json` → **124/126 (98.4%)**, p50 3222 ms, p95 5896 ms, 0 fallbacks. One unstable case (`hello`, the top-k fallback varies its 2–3 targets) and two misses (both `search suggestions are empty` → multicast web+search instead of unicast search). The new prompt/policy holds up on the real model; the JSON is committed.
5. **Verification**: typecheck, web `check` + `build:web`, **240 tests**, `test:release` (13/13), rules `routing:eval` 63/63. The launchd daemon was restarted on this code (pid 97474); `/api/health` now reports `draining` and `/api/update` responds.
6. Commits: `feat: reply entry points, pull-later queue, staging cleanup, upload progress`; `feat: controlled update and rollback MVP (#27, v4-2)`.

**Still waiting / next session:**
1. **Q88 + #16 paid TUI runs (approved in principle, not executed)**: the running-Claude-Code and running-Codex `--tui` Bridge runs (answer/follow-up/cancel each) and the `$cafe` behaviour regression. They need an interactive tmux session with isolated `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and real credentials; staging them blind risks the user's real agent config, so they are left for a supervised session. Recipes: `docs/specs/v3-1-native-codex-claude.md` "第二阶段". The headless Bridge paid runs were already done on 2026-11-19.
2. **#28 connector SDK**: still spec-only (`docs/specs/v4-3-connector-sdk.md`, Discord first). A mock connector can be built without the user; a real Discord run needs their bot token.
3. **#39 follow-ups**: multicast sends the same text to every target (no per-target sub-question field); `confidence`/`whyNot`/fanout observability; cross-daemon decision cache.
4. **#27 follow-ups**: network-wide announce/canary, signatures, Web-triggered upgrades (deliberately CLI-only); on a service-managed machine, point the service at `current` before the first `apply` (see spec caveat).
5. **Scale leftovers**: search now uses an FTS5 trigram index (3+ char queries; shorter ones scan JSONL), `metas`/`knownOrders` are LRU-bounded, registry saves only changed rows, prune filters in SQL. Still open: Web virtual lists, snapshot is a fixed 200 (no `since`/paging), `prune`'s dry-run still stats every stale file. Baseline: `npm run perf:store`.
6. **Residuals**: model-id pre-validation; Network inline rename only edits the display name (aliases are in Settings); #18 token writing / read-only token (deferred by the user).

**Done on 2026-11-20 in the dogfooding batch** (`cafe_dogfooding/issue-20261119.md`; the user asked to fix as much as possible, chose alias-first display, and chose eval+spec only for #39). No npm version bump; the daemon was restarted on this code and still reports 0.1.3.

1. **#37 / #6 (queue heartbeat)**: `bridge/barista.ts`, `serve.ts` and `bridge/session-host.ts` now start `keepAlive` when an Order is acked and stop it when the turn starts / the queued Order is cancelled. `tests/helpers.ts`'s `barista()` keeps a scripted Order alive at `FAST.heartbeatIntervalMs`; a regression test acks, waits 900 ms (> the 600 ms FAST lease) and still replies.
2. **#48 (limits)**: `/api/threads`, `/api/search` and `/api/threads/:id` validate `limit` (integer, 0 allowed only for search), `status` and `before`; `store.listThreads` also clamps so `LIMIT -1`/NaN cannot reach SQLite. Negative/non-numeric values return 400 `bad_request`.
3. **#49 (token)**: `cafe config get` redacts the token; `cafe config get token` and `cafe config get --reveal` still show it.
4. **#50 (wait)**: `/api/threads/:id/stream` returns 404 for an unknown Thread (before writing SSE headers), so `cafe wait <typo>` exits instead of hanging.
5. **#51 (Node)**: `packages/cli/bin/node-check.mjs` checks Node ≥ 22.18 before importing `src/main.ts`; `scripts/build-release.mjs` copies it and uses the same check in the packed CLI.
6. **#52 (doctor token)**: doctor uses `CAFE_TOKEN` then `loadConfig().token`, and distinguishes no token / mismatch / unreachable.
7. **#53 (omp status)**: omp failures are summarised to one actionable line (`summarizeProcessError`), not a stack trace.
8. **#41 / #42**: `cafe barista ls` is an alias of `list`; when no supervised workers exist it says so and points at `cafe agents` with the registered-barista count.
9. **#44**: clicking "All Agents" no longer collapses the nav sublist (and sets `aria-current`).
10. **#43 / #45 / #46 / #47 (identity)**: `AgentRecord`/`DaemonRecord` gained `legacyAliases`; renames move the old name there instead of into user `aliases`. Display precedence is **explicit alias → displayName → stable name** (`packages/web/src/display.ts`, CLI `displayAddress`). Web alias chips persist immediately; user aliases can be removed (host and agent, local and Root-relayed), while automatic legacy names stay routable and cannot be removed. Agents cards have a `⋯` menu (Rename / Add alias / Copy address). Settings shows alias chips for hosts and agents.
11. **#40 (native safety)**: `cafe serve --preset codex|claude` pins the read-only bridge defaults (`codex exec -s read-only`, `claude --permission-mode dontAsk --tools Read,Grep,Glob …`); `--write` widens them. `cafe doctor` now checks `codex --version` and `claude --version`.
12. **#21**: top-level `cafe status` shows daemon/version/router/root/traffic/pending config/webStale and the next command.
13. **#18 (partial)**: `POST /api/config` accepts `advertise` and `retentionDays` (whitelist, restart-required) and the Web Settings has fields for both. Token editing and a real read-only token remain out of scope.
14. **#38 (docs)**: both READMEs and `skills/cafe/SKILL.md` now document `config set` apply-vs-restart, `config diff|apply`, host-entry table, Customer-vs-Barista, `/cafe` per host, alias/legacy semantics, `cafe status`, and an "upgrade an existing source install" section.
15. **#39 (eval + spec only)**: `tests/routing-fixtures.ts` has `EXTRA_CASES` (overlap, plurals, multicast sub-tasks, `no_owner`, repeated input); `scripts/router-eval.ts` runs both sets. `docs/specs/v4-4-routing-accuracy.md` records the decisions; **no routing behaviour changed**. The current rules baseline is 58/63 with those extra cases (misses are printed).
16. Verification: `npm run typecheck`, web `check` + `build:web`, **207 tests**, `npm run routing:eval`, and `npm run test:release` all pass. The launchd daemon was restarted; `/api/health` reports 0.1.3 with `llm magpie/group/smart`, `/api/doctor` and `/api/config` respond, and `cafe status` / `cafe doctor` / `cafe barista ls` were checked by hand.

**Still waiting / next session:**
1. **Paid runs (approved but not executed)**: the two Q88 TUI Bridge runs (a running Claude Code session and a running Codex `--tui` session; answer/follow-up/cancel each) and the #16 `$cafe` behaviour regression. They need a staged tmux + isolated config setup and a real model; every new paid run still needs its own approval.
2. **#39 implementation** after the owner confirms the open questions in `docs/specs/v4-4-routing-accuracy.md` (`no_owner` default, whether `domain` is a wire field, multicast `skipped`). Then: prompt rewrite, target stabilisation, `graceMs`/first-final-wins, rules stemming, stability/fanout in the eval script.
3. **#27 update/rollback and #28 connector SDK** are decided (`docs/specs/v4-2-update-rollback.md`, `docs/specs/v4-3-connector-sdk.md`) but not implemented. Start with `superpowers:writing-plans`; #27 MVP is the independent updater + `releases/current` + drain + health + rollback; #28 is `cafe connector` + manifest + idempotent Thread mapping, Discord first (mock connector first; real Discord needs the user's bot token).
4. **#20 phase 2**: Barista reply attachments (reply-with-file entry for CLI/MCP/Bridges), upload progress, orphan staging cleanup, and the "customer offline → pull later" queue.
5. **Scale #31/#33/#34** (historical; see the 2026-11-23 batch for what closed): search now uses FTS5, caches are bounded, registry saves changed rows, web appends batch. Remaining: Web virtual lists and snapshot paging.
6. **Residuals from this batch**: the sidebar Agent rows still have no right-click/`⋯` menu (#45 only covers the Agents page); remote Host alias editing in the Web is not exposed (#46 covers this machine); `barista start --tui` still registers before a Codex session exists (only a warning, no preflight); model ids are not pre-validated; `#18` token editing / read-only token; optional `cafe commands` docs page.
7. Optional: a real-model routing sample after the #39 changes (`npm run routing:eval -- --model … --repeat 2 --out docs/eval/…`), with approval.


**Done on 2026-11-20 in the autonomous night batch (user approved #20 Q1–Q4, #27 Q1–Q5, #28 Q1–Q4 with **Discord** as the first platform, accepted a brief stop for upgrades, and deferred read-only tokens):**

1. **#20 attachments, phase 1 (Customer → Barista)** — implemented end to end: `Attachment` protocol type, `Order.attachments`, `ThreadMeta.attachments`, `POST/GET /api/artifacts` (streaming upload, sha256, 25MB/100MB/10 limits, filename checks), staging → Thread move, cross-host **pull before delivery** (ack paused while pulling), local-daemon download proxy, prune removes blob dirs, CLI `ask --attach` + `thread --download`, MCP `cafe_ask attachments: [path]`, Web composer + download links + 📎 count, and pi/bridge/serve prompts list **local paths only**. Tests in `tests/attachments.test.ts`. Spec decisions folded into `docs/specs/v4-1-attachments.md`. Reply attachments are protocol-ready but have no producer yet.
2. **#18 Web admin, second pass**: `GET /api/doctor` (daemon/router/root/config/web/machines, with the next command) is shown in Settings; Network cards can copy the equivalent CLI command. Advertise/retention editing and a real read-only token were deliberately left out (the token is all-or-nothing).
3. **#21 pending config**: `runtimeConfig()` now returns `pending` (saved vs running), `cafe daemon status` prints it with the next command, and Settings has a "Pending configuration" section. `port: 0` is treated as ephemeral, not a pending change.
4. **#11 commands**: `cafe commands status|install|uninstall --agent claude` installs `~/.claude/commands/cafe-ask.md` (the plugin keeps `/cafe`); it refuses to overwrite a person's file without `--force`; `cafe doctor` reports it. pi/omp get `/cafe` from the extension; Codex keeps `$cafe`.
5. **#6 test flake**: 10 consecutive full runs under four CPU hogs were green (192/192). The tester's failures did not reproduce on this code; no test timing was changed.
6. **Specs**: v4-2 and v4-3 have their decisions recorded (brief stop + drain; `--file` first; optional checksum; CLI only; auto rollback. `cafe connector`, out-of-process sidecar, Discord first, optional `idempotencyKey`). Neither is implemented.
7. **Verification**: typecheck, web `check` + `build:web`, 192 tests (10× under load), `test:release` (packed tarball smoke test), and `test:claude-plugin` (5/5) all pass. The user's launchd daemon was restarted with this code; `/api/doctor` and `/api/config` respond; status is 0.1.3 with `llm magpie/group/smart`.

**Done on 2026-11-19 in the dogfooding-fix batch (the user approved batch 1+2, direct UI changes, specs-only for #27/#28, and the paid routing sample, then went to rest):**
1. **#10 name display + conflicts**: displayName is now used in Network cards, Agents cards/group headers, Live host filters and the Shell machine label (internal `host` stays as a secondary line). Rename/alias now rejects collisions: Host names/aliases must be unique network-wide; Agent names/aliases must be unique within one Host; `@`/`#` are rejected because they break Address parsing. Old names remain aliases; internal ids/Addresses never change. Tests in `tests/identity.test.ts` (local, remote, cross-host, conflict, own-alias).
2. **#21 config contract**: `configApplyMode()` marks `router.*` and `root` hot, everything else restart-required; `cafe config diff` compares `config.yml` with `GET /api/config` (running values, no token) and labels each change; `cafe config apply` reloads hot keys and lists what still needs `cafe daemon restart`. `/api/snapshot` sets `webStale` when `web/index.html` on disk is newer than the daemon's in-memory copy; the Web Shell shows a restart banner. Tests in `tests/config-contract.test.ts` and `tests/cli.test.ts`.
3. **#19 Live reconnect**: the daemon exposes `GET /api/events/history?after=<eventId>` over the same 500-event ring; the Web store tracks the newest event id and backfills on every reconnect (a too-old id returns `gap: true` and the snapshot resync takes over). Test in `tests/events.test.ts`.
4. **#18 Network actions**: each Network card can test reachability (`POST /api/hosts/test`, latency/version/error), the Root can ask an offline known Host to dial back (`POST /api/hosts/reconnect`), and local/Root cards can rename inline. “Read-only token” from the issue is not a real concept (loopback is token-free, remote token is full access), so no fake read-only mode was added.
5. **#11 pi/omp commands**: the pi extension registers `/cafe agents|ask <question>|status|thread <id>|help`; a user-owned `/cafe` wins and the tools/skill still work. Codex keeps `$cafe`; Claude Code keeps its plugin `/cafe`. Test in `tests/pi-extension.test.ts`.
6. **#31/#34 focused performance**: `/api/snapshot` and `/api/threads` now clip reply texts to 160 chars and keep at most 3 replies/declines (old metadata without arrays is tolerated); `GET /api/threads/:id?limit=&before=` returns the newest page plus `hasMore`, and SSE accepts `?after=`; the Web Conversation has “load older” for long Threads. The hot path still writes JSONL per event and searches scan JSONL; full FTS/virtualization remain open.
7. **#6 flake**: `CafeClient` now keeps the last 500 events (`recentEvents(threadId?)`); `untilClosed` seeds from the latest `order.created` turn, so a very fast Barista that closes the Thread before the test subscribes no longer loses `order.replied`. `tests/client-recent.test.ts` reproduces the race. `npm test` ran **5× green (179/179 each)**.
8. **#20 attachments**: the independent review is written into `docs/specs/v4-1-attachments.md` (Q1–Q4 recommendations + six blocking gaps: origin host, staging before threadId, local proxy for downloads, pull/ack timing, old-daemon field stripping, Barista file access).
9. **#27/#28 specs**: `docs/specs/v4-2-update-rollback.md` (independent updater + releases/current symlink + drain/health/rollback) and `docs/specs/v4-3-connector-sdk.md` (out-of-process `cafe connector` + manifest + idempotent Thread mapping). **Specs only — no implementation**; their questions were answered on 2026-11-20 (see the batch at the top).
10. **Real-model routing sample (approved, run once)**: `npm run routing:eval -- --model magpie/group/smart --repeat 2` → accuracy 105/106 (99.1%), p50 3220ms, p95 5940ms, 0 fallbacks; one miss (“search suggestions are empty” chose multicast search+web). Result committed as `docs/eval/routing-2026-11-19.json`.
11. Verification: `npm run typecheck`, web `check` + `build:web`, **179 tests ×5**, `npm run test:release` (packed tarball smoke test) all pass; the user's launchd daemon was restarted and reports 0.1.3 with `llm magpie/group/smart`.

**Still waiting / next session:**
1. **Q88 two paid TUI Bridge runs were not executed** (running Claude Code session and running Codex `--tui` session; answer/follow-up/cancel each). They need a carefully staged tmux + isolated config setup and real models; recipes are in the phase-2 section of `docs/specs/v3-1-native-codex-claude.md`. Every new paid run still needs its own approval. **#16** (does the model actually call `cafe agents` first under `$cafe`?) also needs one approved paid run.
2. **#27 update/rollback and #28 connector SDK are decided but not implemented.** Start with `superpowers:brainstorming`/`writing-plans`; #27 MVP is an independent updater + `releases/current` + drain + health + rollback; #28 is `cafe connector` supervisor + manifest + idempotent Thread mapping, **Discord first** (mock connector first; real Discord needs the user's bot token). OpenClaw / hermes-agent plugin code is authorized for reference via `sourceget find openclaw hermes-agent`.
3. **#20 phase 2**: Barista reply attachments (needs a reply-with-file entry for CLI/MCP/Bridges), upload progress, orphan staging cleanup, and the "customer offline → pull later" queue for cross-host replies.
4. **#18 leftovers**: advertise/retention editing from Web (needs a config write API and a confirmation model), and the optional read-only token (needs a real ACL, not button greying).
5. Remaining scale work: SQLite FTS for search, Web list virtualization, bounded `metas`/`knownOrders`, the O(n) `detail.events` copy, paged `thread()` reading the JSONL from the tail, snapshot `since`/paging (#31/#33/#34 leftovers).
6. Optional UI follow-ups: Settings "copy next command" links, a routing-quality view built on `routing:eval`, and the `cafe commands` docs page.

**Done on 2026-11-19 in the night batch (Q108 A, Q109 "full provenance, no migration", Q110 "start Barista + machines", Q111 "#20 spec first"), committed as `feat: order provenance, settings admin, SSE resume, and wide-screen UI`:**
1. Web polish (user-requested): drawer closes on blank-page click in both overlay and docked modes; 180ms slide-in / 150ms slide-out with `prefers-reduced-motion` honoured; Agents sublist open by default on desktop and remembered; "All Agents" is a quiet nav row instead of a blue link; the drawer header shows the Thread's first question instead of the nav name.
2. #36 provenance: `Order.origin` / `Order.via` + `ThreadMeta` copies; Web = human, MCP = agent, CLI `--origin agent [--via addr]`, registered Agents over RPC = agent automatically. Web shows `你` for web questions and `代问` for relays. Thread titles now stay on the **first** question (`summaryTurn` stays 1); old Threads are not migrated.
3. #10/#18: Settings drawer has "Machines" (Root can rename remote Hosts through the existing API), "Start a Barista" (directory + pi/omp/codex/claude, write toggle for native), and a Connection section (`/api/settings`: Root + masked token + restart hint).
4. #19: `GET /api/events` now writes `id:` lines and replays from a 500-event ring on `Last-Event-ID`; `cafe tail` reconnects with the last id. `replayAfter()` is unit-tested; no full-CLI reconnect test yet.
5. #30: info rail moved from ≥2200px to ≥1920px (`minmax(0,1fr) 260px`); Feed is two columns at ≥1800px while the drawer is closed. Verified with screenshots at 1440/1920 (`output/playwright/`).
6. #6: `untilClosed` timeout raised 5s → 12s; `npm test` ran **5× green** (160/160 each) and `npm run test:claude-plugin` passed (5/5). Combined with the earlier fixes this closes the observed flake; watch it if it returns.
7. #14: `npm run routing:eval` + `tests/routing-fixtures.ts` (53 labelled cases, 8 Baristas). Rules baseline is 53/53. `--model <provider/model> --repeat N --json --out <file>` runs a real sample and reports accuracy / p50 / p95 / fallbacks / misses; it is **not** in `npm test`. **No real-model sample has been run yet — needs its own approval.**
8. #20: spec drafted at `docs/specs/v4-1-attachments.md` with Q1–Q4 waiting for the user.
9. Verification: `npm run typecheck`, web `check` + `build:web`, 160 tests (5 consecutive runs green), 5 mod tests, and `npm run test:release` (packed tarball smoke test) all pass; the user's launchd daemon was restarted and serves the new UI. Committed as one batch; review it with `git show`.

**Not done in this batch (candidates for next):** real-model routing-eval sample (needs approval); pi/omp `/cafe` command (#11); #31/#34 server-scale pass (snapshot summary DTO, thread pagination, recover index, FTS); #21 config diff/apply and stale-web-build banner; #16 cross-model behaviour regression; #27/#28 specs.

Done and approved earlier: v2 defaults; Q60–Q70; omp real Q&A; `cafe daemon install` on the Mac; web load-older + search; **Q71 A (Network page versions) approved**; the user restarted their daemon. The user published 0.1.0 and 0.1.1 themselves. Q72–Q79 answered as recommended; Q80 = C (no side work, focus on v3-1).

Done on 2026-11-19 with the user: v3-1 reviewed (the extra `cafe_cancel` MCP tool approved); both paid Bridge runs done and passed (section 3); `cafe mcp install` run by the user and checked. **v3-2** (`docs/specs/v3-2-agent-kind.md`, Q81–Q83, prototype https://claude.ai/artifact/X3F3dx2PtBQf3R5HwsiRL5): kind tags on Agent cards and in conversations, `cafe agents` shows `codex·rw`, `claude·tui`, …; fixes the old "后台 pi" label. The user published **0.1.2** (`latest` on npm; commit + tag `v0.1.2`). The daemon was restarted by the agent and reports 0.1.2. The dogfooding batch below was reviewed and the user published **0.1.3** (commit + tag `v0.1.3`); the daemon reports 0.1.3. README is now English with a Chinese `README_zh.md`, linked from both; the release package ships both.

Done on 2026-11-19 while the user was away (asked to finish phase 2), **reviewed and shipped in 0.1.3**: **v3-1 phase 2** (Q84–Q88 as recommended; ADR-0006; spec section "第二阶段"):
1. Claude Code: `claude-plugin/` (mod) + `cafe session-host` + `cafe claude install|uninstall`. Verified free with a real Claude Code TUI and a fake API (section 3). The user has run `cafe claude install`.
2. Codex: `cafe barista start --dir <dir> --agent codex --tui [--thread <id>]`. Verified free with a real Codex TUI and a mock model.
3. Findings worth knowing: after Esc in the terminal, both Claude (mod prompts refused) and Codex (queue dispatch paused) take no cafe questions until the person sends a message; a Codex turn that has started cannot be interrupted from outside, so cancel only withdraws queued questions; the user's cmux `codex` wrapper forces the TUI's embedded app-server, which the design handles (no shared daemon needed).
4. Commits: `feat: running Claude Code sessions as Baristas …`, `feat: a running Codex session as a Barista …`, and the handoff.

Waiting on the user / next session:
1. **Run the two approved paid real-model runs** (Q88, approved but not yet executed): a running Claude Code session and a running Codex session (`cafe barista start --dir <dir> --agent codex --tui` next to a `codex` in that dir), each: answer, follow-up, cancel. Every new paid run still needs its own approval. Same for a real-model routing sample: `npm run routing:eval -- --model <provider/model> --repeat 2 --out routing-eval.json`.
2. Optionally run `cafe extension install` on the user's machine (pi/omp currently have no persistent cafe extension; `cafe extension status` shows both missing). It writes `~/.pi/agent/settings.json` and links omp — ask first.
3. `pi update` (local pi 1.5.0, extension targets 1.5.2). Reinstall autostart (`cafe daemon install`), `cafe mcp install` and `cafe claude install` after changing Node version or moving the repo (all register absolute node + cafe.js paths). The user reran `cafe claude install` after the v3-3 plugin fix.
4. Nothing is pushed; the user pushes when they want. Publishing to npm stays with the user.
5. Next backlog: #14 offline LLM eval harness (Q107 A), #20 attachments / #28 connector SDK / #27 update-rollback (need specs), full #31/#34 server-scale work, #11 pi/omp slash commands. The v3-3 Web workbench is done and committed.

Done on 2026-11-19 in the dogfooding batch (Q89–Q97; user chose Q90 B, Q93 B, rest as recommended), **reviewed, committed and shipped in 0.1.3** (four commits: daemon/protocol, CLI onboarding, web perf, docs; then a bilingual-README commit):
- Correctness/UX: `.cafe` directories are skipped (no more `EISDIR` from `~/.cafe`), broken `.cafe` errors name the file/field and show a template; pi extension reports why it is unavailable; CLI does not repeat `EISDIR`; `config get` prints `(not set)` / fails unknown keys; thread summaries cut at word boundaries with `…` and follow the latest turn; skill text now has a mandatory `$cafe` workflow.
- First use: `cafe init`, corrected help with Quick start (unknown commands fail even with `--help`), `cafe extension install|status|uninstall`, `cafe doctor`, rewritten README.
- Routing: `initRouter` can switch model and clear to rules; unknown models roll back; timeout/single-candidate/concurrency; ResourceLoader reused; `cafe router models|set|status|apply`; `daemon status` shows the running model.
- Multi-machine: child addresses are probed before entering `knownDaemons`; `cafe connect`, `root test`, `daemon restart`, restart-required config reporting, clearer `unauthorized`.
- Identity (ADR-0007): `displayName`/`aliases` for Hosts and Agents, local and Root-relayed rename; internal ids/Addresses never change, so no history migration.
- Performance (targeted): debounced meta writes, tail-only follow-up history, recovery query, registry upsert, parallel `announceRoot`; web store single set, O(1) duplicate check, linear merge, memoized Feed/Conversation, coarser `useNow` in cards.
- No Web layout redesign yet at that point: the artifact tool refused that session (authenticated with `ANTHROPIC_AUTH_TOKEN`), and UI changes still needed an approved prototype (#18/#22/#23/#24/#30). Superseded by the v3-3 batch below.

Done on 2026-11-19 in the **v3-3 Web workbench** batch (Q101–Q107; Q101 A, Q102 A, Q103 A, Q104 A, Q105 A, Q106 B, Q107 A), **committed** (see `git log`: `feat: Web workbench, settings drawer, live tail, and Claude plugin /cafe fallback`):
- Web: fixed full-height Shell with independent scrolling; compact Feed cards (whole card clickable, 2-line title, one-line answer, status + timing, no "Open conversation" link); thread detail as a right drawer at 900–1599 and a docked three-pane at ≥1600; a 280px info rail at ≥2200; nav Agents expands into a registered-agent sublist; Settings drawer (host/agent rename + aliases, routing model with live state, supervised Barista list/stop); Live page; `useNow` only ticks fast for active turns. Prototype: `docs/prototypes/web-workbench-2026-11-19.html`; screenshots in `output/playwright/` (390 / 1440 / 1920 / 3440, light, settings, live).
- Daemon/CLI: `GET /api/router/models` (60s cache), `POST /api/router` (set/clear with config rollback), `GET /api/events` SSE with host/type/thread filters and heartbeats hidden; `cafe tail` (human + `--json`, same filters).
- Claude Code plugin: a user-owned `/cafe` no longer aborts `session.start`; registration falls back to `/cafe-barista` and the session-host still starts. Added a mod test for it. The user reran `cafe claude install`; the installed marketplace copy was verified to contain the fix. New sessions get it; already-running sessions need a restart.
- Verification: typecheck, web check + build, 155 tests ×5, 5 mod tests. The user's launchd daemon was restarted and serves the new UI (`cafe daemon status`: 0.1.3, llm `magpie/group/smart`). The #6 flake did not reproduce in 5 full runs.
- Not done this batch: #14 offline LLM eval harness (Q107 A), full #31/#34 server-scale work, #20/#28 specs, #27 update/rollback, #11 pi/omp slash commands.

## 6. Two-machine test (the user runs this)

A real two-machine run already happened on 2026-11-19 (Mac Root + ssh1 Docker child); it produced dogfooding #25/#29, both fixed in 0.1.3. Re-run this checklist after the fixes when convenient.

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
6. Logs under `CAFE_HOME` (`~/.cafe` by default): `daemon.log` is timestamped and capped, `daemon.log.1` holds the prior rotation, and `logs/barista-*.log` holds worker output. New service definitions send raw startup output to `daemon.stdout.log`. An existing service definition may still point at `daemon.log`.

## 7. Backlog after v2

- Multi-level Daemon hierarchy (codex `parent`/AgentPath idea) — not started; only two levels exist.
- **Attachments (#20)**: phases 1 and 2 are implemented (Order and Barista reply attachments, cross-host pull/proxy). Remaining: `cafe reply` for arbitrary external processes, a Bridge/serve file producer, a pull-later queue for offline Customers, upload progress, orphan staging cleanup. Spec is `docs/specs/v4-1-attachments.md`.
- LLM routing: rules are 67/67 offline and the LLM has policy/stability/caching (`docs/specs/v4-4-routing-accuracy.md`). The current real-model baseline is `docs/eval/routing-2026-11-24.json` — **134/134 = 100%** in the committed run (a second run of the same model: 133/134), p50 ~3.7–3.8 s, 0 fallbacks, and 1–3 unstable no-owner cases (`what is the meaning of life`, `帮我随便看看`, `hello`) — taken after the #39 per-target variants landed. (`routing-2026-11-21.json`, 124/126, is historical.) `confidence`/`whyNot`/fanout are still not exposed in the UI.
- Full event store and web virtualization (dogfooding #31/#33/#34) — tail-read Thread paging, bounded metadata, snapshot summaries, Thread pagination, an **FTS5 trigram search index**, **LRU-bounded `metas`/`knownOrders`**, incremental registry saves and store batched deletes are in. Still open: **Web list virtualization** (Feed/Conversation), snapshot `since`/paging (the snapshot is still a fixed 200; `/api/threads?before=` pages older ones and the Web "load older" uses it), a `cafe prune` dry-run that does not stat every stale file, and **`appendEvent` is still a synchronous `appendFileSync`** on the hot path (making it async risks losing events on a crash; it is a deliberate perf item, not a bug). Baseline: `npm run perf:store`.
- pi/omp `/cafe` slash commands are in (#11); `cafe commands` installs the Claude `/cafe-ask` file; `$cafe` stays for Codex. Config diff/apply, pending config, the stale-web-build banner and Web doctor are in (#21/#18).
- **Update/rollback (#27)** has a decided spec at `docs/specs/v4-2-update-rollback.md`; the MVP is implemented (service-aware `apply`/`rollback`, drain, health, auto-rollback). **Connector SDK (#28)** is implemented through the **Discord** platform (`docs/specs/v4-3-connector-sdk.md`): `cafe connector install|list|status|start|stop|restart|logs|config|remove`, the `@cafe/connector` SDK (thread map / seen events / outbox, atomic writes, stdout heartbeat protocol), a mock connector, a **Discord connector** (`discord-core.ts` core + `discordjs.ts` adapter; allowlists, `requireMention`, `allowDMs`, @everyone rejection, 2000-char chunking, idempotent event → Order → SSE follow), the optional `POST /api/orders` `idempotencyKey`, a **crash-restart supervisor** (`cafe connector supervise`, backoff + crash-loop give-up), and the SDK **packaged in the release** (`connector/`). Still open: a **real Discord end-to-end run** (needs the user's bot token + the Message Content intent), attachment support, and nonce/`enforce_nonce` outbound dedup for Discord.
- Phase 2 follow-ups: the web UI could show "paused" for a Claude session (`/cafe off` currently just leaves the network); a Codex `--tui` Barista could prefer the shared app-server daemon's live events when the TUI uses it (today it always polls `thread/turns/list`, ~1 s).
- CI (GitHub Actions: typecheck, test, build:web, test:release, `routing:eval`) — suggested, not started.
- LAN security: **TLS is implemented and hardened** (v4-6 #61, see §1/§5): CA + leaf, dual port, fail-closed, TOFU CA fingerprint, **per-peer leaf pin enforced on Daemon links**, **leaf renewal (start + every 6 h while running)**, **exact SAN coverage**. Remaining is phase 2: mutual TLS (a client certificate per peer) and ECDSA leaves (`node-forge` 1.x has no EC keygen); the token still travels inside TLS rather than replacing it.
- `search` uses the FTS5 trigram index (`search_index`) for 3+ char queries and falls back to the JSONL scan below that; `threadsNeedingIndex()` + `backfillSearchIndex()` index Threads that predate the index. A short/symbol-only query returns [] from the index path rather than erroring.
- Web: maybe a routing-quality view (eval numbers are only in `tests/routing-eval.test.ts` and `cafe stats`).

## 8. Traps already found
- **Backward reads must split bytes, not strings (#90)**: a fixed-size chunk boundary can cut a UTF-8 character; decoding a chunk before joining the carried half line turns it into U+FFFD while the JSON stays valid, so counts and ids look fine. Any test of a reader must use CJK/emoji text and assert the text, not only ids.
- **A just-stopped child is still in `children` for a moment**: anything that says "online because its uplink is up" must prove it with a round-trip (`uplinkAlive()` sends one request; any reply, even `unknown_method`, counts), or a stopped Host reads as online (`tests/identity.test.ts` caught this).
- **Addresses on a TLS network (#92)**: never build `ws://${addr}` for another Daemon. A pin is shown as its learned `wss://` endpoint (`tlsEndpoints`, filled by `resolveDaemonUrl`) or bare `host:port`; `ws://` entries in `knownDaemons` are stale once TLS is on. The leaf SAN comes from `daemon.desiredSans()` (all local IPv4 + `security.tls.sans`), checked every `leafCheckIntervalMs` (5 min).
- **Several processes start the daemon at once**: Claude Code session-hosts auto-start it when it goes away, so `cafe daemon stop && cafe daemon start` races them; losers exit with "already running" (see `daemon.stdout.log`). The CLI now waits for the lock holder. Loading pi's model runtime has taken 26–47 s; the ports open first and Orders wait for the router.
- **Infinite CSS animations must stay on transform/opacity**: a `box-shadow` pulse cost ~170 ms/s of main-thread work on an idle page (`tests/web-pulse.test.ts`). Measure idle pages with CDP `Performance.getMetrics` (TaskDuration over 10 s) against a scratch daemon, not the user's.
- **FTS trigram index**: `search_index` is FTS5 with `tokenize='trigram'` (case-insensitive substring). Altering its columns needs a rebuild (drop + recreate + backfill); `search_indexed` tracks indexed event ids. `search()` trusts results for 3+ chars only.

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
- A user-owned `/cafe` command makes `$.command.register` throw; `session.start` used to abort before starting the session-host. It now catches the refusal, logs it, tries `/cafe-barista`, and always starts the host. Re-run `cafe claude install` after changing the plugin; it copies the plugin into `CAFE_HOME/claude-marketplace`, so the repo edit alone does not reach a running host.
- Mod test kit: `$.http.fetch` hooks get `{url, init}`; every `$.ui.*` call needs a test hook (`{ value: undefined }`); `$` may only be passed to functions declared outside `register`.
- Codex seen from another process: a turn still running in the TUI reads `interrupted` with `completedAt: null`; `turn/interrupt` on a thread loaded elsewhere fails with `thread not found`; after an Esc interrupt the queue is not dispatched until the next completed turn (`ext/queue/src/service.rs` `on_thread_idle`).
- Tests that share JSON state files with a fake process must write atomically (temp file + rename), or the fake reads half a file and dies.
- `tests/helpers.untilClosed` now waits 12 s (was 5 s): a full parallel run can start fake Codex/Claude slowly. Five consecutive `npm test` runs were green after the change.
- `GET /api/events` resumes from an in-memory 500-event ring. An id older than the ring gets no replay by design (the Web UI re-syncs with `/api/snapshot`); `cafe tail` reconnects with the last id it saw.
- `npm run routing:eval` is free without flags. `--model` calls the real model per case per repeat and costs money; never put it in `npm test`.
- `cafe daemon start` polls `/api/health` for only ~5 s. With an LLM router configured, `initRouter()` (ModelRuntime + ResourceLoader) can take ~1 min before the server listens, so the CLI may report "did not start" while launchd is still bringing it up. Check `cafe daemon status` / the log before treating it as a failure; widen the wait when autostart is installed.
- npm publish to a scoped package returns **E404** when unauthenticated (not E401); `npm whoami` first. A successful publish may return 202 "being processed" and take a few minutes to appear in `npm view`.
- Artifacts are unavailable when the session authenticates with `ANTHROPIC_AUTH_TOKEN`: every Artifact call is refused. UI prototypes need a claude.ai login; otherwise write a local HTML file.
- Tests that spawn a CLI with `spawnSync` while the daemon lives in the vitest process deadlock: the parent's event loop is blocked, so the daemon cannot answer. Use async `spawn` (see `tests/doctor.test.ts`).
- `config.yml` is YAML (not JSON): tests must use `yaml.parse`, not `JSON.parse`.
- Commander falls back to top-level help with exit 0 for an unknown command; `main.ts` checks the first positional itself before parsing.
- `Store.readEventsTail` is the follow-up history path; `recover()` uses `store.openThreads()` so finished Threads are not reread. Metadata writes are coalesced (150 ms) except `order.created` / `order.closed` and on `stop()`.
- Snapshot/thread-list summaries clip reply text to 160 chars and keep at most 3 replies/declines. Old `ThreadMeta` rows can lack those arrays entirely: always `meta.replies ?? []` before slicing (a real crash was fixed this way).
- `GET /api/events/history?after=` returns `{events, gap}`: `gap: true` means the id is older than the 500-event ring; the Web store keeps the snapshot resync, not an attempt to rebuild the gap.
- `CafeClient.recentEvents()` keeps the last 500 events (it is not filtered by thread). `untilClosed` seeds from the latest `order.created` so follow-ups do not resolve on the previous turn's `order.closed`.
- Host display names/aliases are alternate Host ids and must be unique network-wide; Agent names/aliases are unique per Host. `@`/`#` are rejected because `parseAddress()` only accepts `[a-zA-Z0-9_.-]+`.
- The Web socket reconnect calls `refresh()` (snapshot + open Thread + event backfill); do not replace it with “reconnect and hope no event was missed”.
- Attachments: the wire carries metadata only; the blob path is **derived** from `CAFE_HOME/artifacts/<threadId|_staging>/<id>-<safeName>`. `Attachment.host` is the origin; a remote daemon pulls before `order/deliver` and pauses the ack timer while doing it. Web/CLI always talk to their local daemon, which proxies unknown hosts. Empty uploads and names with `/`, `\`, `..` or control chars are rejected. `port: 0` in config.yml is ephemeral and must not show up as a pending change.
- **Never put attachment contents into an agent prompt**: the daemon sends only local absolute paths (`attachmentPaths`), and the pi/bridge/serve prompt builders list them. A large log must not land in the model's context automatically.
- `cafe commands install --agent claude` writes `/cafe-ask`, not `/cafe`: the Claude plugin already owns `/cafe` (pause/resume). A person's own `cafe-ask.md` is never overwritten without `--force`; uninstall only removes a file carrying the cafe marker.
- **Alias vs legacy name**: `aliases` are user-added names and are the **first** display candidate; automatic old names live in `legacyAliases` and only route. Do not put an old name back into `aliases` on rename (that makes the UI show the old id again), and do not let `removeAgentAlias`/`removeHostAlias` delete a legacy name. The display helpers are `packages/web/src/display.ts` and `displayAddress()` in `packages/cli/src/main.ts`.
- **`POST /api/config`** only accepts `advertise` and `retentionDays` (whitelist) and always reports `restartRequired`. The running daemon keeps the old values; `runtimeConfig().pending` is what the Web/CLI show.
- `packages/cli/bin/node-check.mjs` must stay plain ESM and must be copied by `scripts/build-release.mjs` (the packed `bin/cafe.js` imports it before `dist/cli.js`). Changing the minimum Node version means changing this file, the root `engines`, and both READMEs.
- `cafe serve --preset codex|claude` pins read-only defaults; `--write` is the only way to widen them. Keep the preset strings and the Bridge's `claudeArgs`/`threadParams` in sync.
- `GET /api/threads/:id/stream` returns 404 before SSE headers for an unknown Thread; do not move that check after `writeHead(200)` or `cafe wait` hangs again.

- Reference repos: `sourceget find pi codex oh-my-pi`; oh-my-pi at `/Users/biran/code/skills/agent/oh-my-pi`; Orca web at `/Users/biran/code/skills/orca/Orca/web`; ccloop at `/Users/biran/code/skills/orca/ccloop`; `sourceget find openclaw hermes-agent` for #28. Research them with subagents.
- **`CAFE_HEARTBEAT_INTERVAL_MS` is the test hook for #6**: `keepAlive()` reads it; `vitest.config.ts` sets 200 ms so a Bridge survives the FAST 600 ms lease. Production keeps 30 s. Do not set it outside tests.
- **`/api/health` carries `metrics`** (threads, events, appendBytes, metaWrites, metaBytes, snapshotMs, searchMs, eventLoopLagMs) from the dogfooding probes. `store.appendEvent`/`putThread` return byte counts — don't re-serialize in the daemon to count.
- **`cafe update apply` retargets an installed service**: `retargetInstalledService()` rewrites the launchd/systemd unit to `current/bin/cafe.js` (or kickstarts it when already pointed there) before the health check. This closes the first-update rollback loop (#27); keep `tests/service.test.ts` and the spec caveat in sync if the unit paths change.
- **Claude slash commands are split by role**: `/cafe` is the Customer command file (`~/.claude/commands/cafe.md`, same `agents|ask|status|thread|help` as pi/omp); `/cafe-barista` is the Claude plugin's pause/resume. The plugin must never claim `/cafe` (it would collide with the command file). `cafe commands install` removes a legacy `cafe-ask.md` only when it carries the cafe marker.
- Agent rows in the nav are focusable divs (`tabIndex=0`) and open the menu with Shift+F10 / the Menu key. Do not re-add a per-row `⋯` button: the row is a 3-column grid and the button lands on a second line.
- `tests/supervisor.test.ts` flaked once during a full parallel run on 2026-11-21 (passed in isolation and on rerun). Watch it if it recurs; not confirmed as a product regression.
- **Connector state and resolution**: `cafe connector install` copies the directory to `CAFE_HOME/connectors/<name>/`, writes `.cafe-installed.json`, and symlinks `@cafe/connector` / `@cafe/protocol` into its `node_modules`. The release package **ships the SDK** as `connector/` (JS bundles incl. the Discord connector), and `packageRoot()` looks there first, so a connector installed from a published cafe resolves `@cafe/connector`. Connector data lives in `CAFE_HOME/connector-data/<name>/` (config, state, run.json), logs in `CAFE_HOME/logs/connector-<name>.log`. `cafe connector start` spawns `cafe connector supervise <name>` detached: the supervisor restarts a crashed child with backoff and gives up (status `crashed`) after 5 exits/60 s; `stopConnector` signals the process **group** (`-pid`); `run.json.pid` is the supervisor, `childPid` the connector. Knobs: `CAFE_CONNECTOR_MAX_RESTARTS` / `CAFE_CONNECTOR_WINDOW_MS` / `CAFE_CONNECTOR_BACKOFF_MS`. Installing `discord` runs `npm install discord.js` in its dir (skip with `CAFE_CONNECTOR_SKIP_RUNTIME=1`); `discord.js` is not a cafe dependency and is imported lazily.
- **`idempotencyKey`** is a Daemon-side, in-memory 10-minute / 1000-entry dedupe: a repeated key returns the first Order/Thread, including while the first is still routing. It is not persisted across Daemon restarts; connector-side `seen-events` + `outbox` are the durable layer.
- The mock connector writes replies to stdout (the supervisor redirects stdout to the log). With `config.ingestPort` it also serves `POST /` and `GET /healthz`; without it, stdin is the event source (tests use an async input).
- On 2026-11-21 a smoke test briefly installed the mock connector in the real `~/.cafe` by mistake and removed it with `cafe connector remove mock`. `~/.cafe/connectors` and `~/.cafe/connector-data` are now empty leftovers (safe to `rmdir`); config.yml, `cafe.db` and sessions were not changed.

- **TLS (v4-6) traps.** `tests/helpers.startDaemon` defaults to `security: { mode: "plaintext" }` because production defaults to TLS and the fixed 4778 port would collide across dozens of parallel test daemons; a TLS suite opts in with an explicit `security` block. **Any script that writes its own scratch `config.yml` must also declare `security.mode: plaintext`** — the release smoke and `scripts/sim-hosts.sh` did not and died on `EADDRINUSE 0.0.0.0:4778` whenever a real Root was running (`tests/scratch-configs.test.ts` now guards both). `setDefaultCACertificates`/`applyCa` are **process-wide and additive** — a same-file test that trusts a CA makes a later "untrusted peer" test pass for the wrong reason, so the fail-closed check lives in its own file (`tests/tls-untrusted.test.ts`) and the child-link test in `tests/tls-child.test.ts`. Daemon-to-daemon links use `wss://` only when `tlsContext.network` is true (a real network CA is enrolled, not the temporary local CA a child falls back to when its Root is unreachable). `createTlsServer` reads the leaf through `tls.current()` and swaps it via `setSecureContext` on `onRenew`; a keep-alive client reuses the old socket, so renewal tests use `keepAlive: false`. `node-forge` 1.x has **no EC keygen** — leaves are RSA-2048. A `POST /api/tls/leaf` is the only way a child gets a leaf; it is Root-only and token-authed over TLS.
- **Leaf lifecycle (v4-6 §5 B).** A leaf is valid 90 days; `ensureLeaf` reissues when it is inside `LEAF_RENEW_BEFORE_MS` (21 days) **or** the SAN set changed, and a running Daemon checks every `timing.leafCheckIntervalMs` (6 h prod, tunable in tests) and renews in place (write-through to disk + `setSecureContext`). A child with no CA key renews by asking the Root; if the Root is unreachable the tick retries and the not-yet-expired leaf keeps serving. Do not shorten validity or remove the renewal path — fail-closed means an expired fleet has no rescue.
- **SAN coverage is exact.** `sanCovers()` compares whole `subjectAltName` entries. A substring test let `127.0.0.1` "cover" `127.0.0.10` and `desk` cover `desk.example`, which kept a stale leaf and made the new name fail closed with `ERR_TLS_CERT_ALTNAME_INVALID`.
- **Per-peer leaf-key pin.** `security.tls.pins[host:port]` is enforced via `checkServerIdentity` on Daemon-to-Daemon `wss://` (TOFU on first contact, persisted to config); it is separate from the CA fingerprint and must never be compared to it. The CA pin authenticates the trust anchor; the pin catches an unexpected leaf issued under that CA. **The pin names the leaf's public key (SPKI), not its certificate** — a certificate fingerprint changes on every renewal and would reject a Host that merely rotated. Old certificate pins are accepted while that leaf is unchanged and upgraded in place. Clear one with `cafe host pin <host:port> --clear` (hot, `POST /api/tls/pins`).
- **A custom `checkServerIdentity` disables Node's SAN check.** Node *replaces* the default identity check when the option is supplied; it does not add to it. `trust.ts`'s `pinnedIdentityCheck` runs `tls.checkServerIdentity` first and the pin second — never pass a pin-only function here, or every `wss://` link stops checking SANs (`tests/tls-pinned-san.test.ts` pins the old bug down).
- **Renewal must keep the leaf key.** `issueLeaf(ca, sans, days, key?)` re-signs the existing key (or an SPKI a child sends in `POST /api/tls/leaf`); `ensureLeaf`, `tlsContext.renew`, and `cafe daemon renew-cert` all pass it. `POST /api/tls/renew` goes through `renew` so the leaf is written through; do not swap only the in-memory leaf.
- **Connectors survive a daemon restart.** They are detached processes; after changing `packages/connector/**` run `cafe connector restart <name>` too (Discord ran stale code for hours on 2026-11-24).
- **A second local TLS daemon collides on 4778.** An isolated test daemon on the same machine as the real Root must set `security.tls.port` (only `EADDRINUSE` is printed otherwise).
- **playwright-cli `goto` to the same URL with a new hash does not reload** the page: after a rebuild, `reload` before taking screenshots.
- **`Order.variants` (#39)**: delivery-only. `dispatch()` sends `body = variants[agentId] ?? body` with `variants` stripped; do not write per-variant text into `history()` or `order.created`, and do not attach variants to a unicast. The rules split is deliberately narrow (explicit two-clause punctuation only).

## 9. Working with this user

- They write in Chinese; answer in Chinese. They decide quickly when given numbered questions with a recommended answer (last used number: **Q120**). On 2026-11-24 night they approved the Web small fixes (#63/#74/#64) directly and asked that the session finish every non-blocking task, report review items at the end, and hand off; do not wait on them for anything that does not need a person. On 2026-11-20 they approved #20 Q1–Q4, #27 Q1–Q5 and #28 Q1–Q4 (Discord), accepted a brief stop for upgrades, deferred read-only tokens, and required that **large attachment contents never be put into an agent's context automatically**. On 2026-11-21 they asked for **one intuitive `/cafe` entry across Claude/pi/omp** and for the inconsistent group to be renamed: the Customer command is `/cafe` everywhere; the Claude plugin's session pause/resume moved to `/cafe-barista`.
- New feature areas: go through the decisions first; small fixes go straight ahead. When they are away, follow the recommendations, keep going on what does not need them, and list the review items at the end.
- Commit when asked (or at the end of an away batch they asked to hand off), with a stat or diff shown first; messages end with the Co-Authored-By line.
- Restart their daemon yourself after daemon / web changes (section 8). Publishing to npm and changing their Claude / Codex config stay with them.
- UI prototypes are Claude artifacts: v1 https://claude.ai/artifact/JQDywMh5YuYWsT7yaMXtSK, routing-history display https://claude.ai/artifact/JJit3GCxiQZUypYVWZFxFg (approved: Q51–Q53 as recommended), older threads + search https://claude.ai/artifact/ARjRg8XRAdsx44YSdYehvZ (approved: Q67–Q68 as recommended), versions https://claude.ai/artifact/SVLEJhirFrxq7ugMipjeiZ (Q71 A, implemented), agent kinds https://claude.ai/artifact/X3F3dx2PtBQf3R5HwsiRL5 (Q81–Q83 as recommended, implemented). Artifacts are unavailable under `ANTHROPIC_AUTH_TOKEN`; the v3-3 workbench used a local prototype instead: [`docs/prototypes/web-workbench-2026-11-19.html`](../prototypes/web-workbench-2026-11-19.html) (Q101–Q107, implemented).

**Suggested skills for the next agent** (call via Skill): TLS (#61) and per-target questions (#39) are implemented; use `superpowers:brainstorming` for #71 team/channel design and TLS phase 2, `superpowers:writing-plans` once a spec is approved, and `superpowers:systematic-debugging` plus `superpowers:test-driven-development` for the regressions listed in §5. Use `cafe` for live network diagnosis and `playwright` for browser regressions. For UI design, use `artifact-design` when the artifact tool is available. A local HTML prototype works when it is unavailable.
