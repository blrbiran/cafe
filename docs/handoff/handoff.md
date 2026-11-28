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
| `packages/daemon/src/server.ts` | Two listeners sharing one handler: plaintext **4777** (HTTP API, `/ws`, static web UI) and optional TLS **4778** (`security.mode: tls`, `SNICallback` hot renew). `/api/tls` (CA + fingerprint + `web` encrypted addresses, public), **`/ca.crt` (installable CA, v4-9)**, `/api/tls/leaf` (Root issues a child leaf), `/api/tls/renew`. `?token=` is gone — Authorization: Bearer only. New: `/api/host`, `/api/hosts/rename`, **`/api/hosts/test`, `/api/hosts/reconnect`**, `/api/agents/rename`, `/api/router/models`, `POST /api/router`, `POST /api/baristas` (start), `GET /api/settings` (root + masked token), **`GET /api/config` (running config + `pending`, no token; for `cafe config diff`), `GET /api/doctor`**, **`POST /api/artifacts` (streaming upload) and `GET /api/artifacts/:id` (local file or origin proxy)**, `GET /api/events` (SSE with `id:` lines and `Last-Event-ID` replay from a 500-event ring), **`GET /api/events/history?after=` (JSON backfill for the WebSocket reconnect)**, structured `/api/reload` (`ok/router/model/error`), **`/api/snapshot` summary threads (replies/declines clipped) and `webStale`**, **paged `/api/threads/:id?limit=&before=` and SSE `?after=`** |
| `packages/daemon/src/events.ts` | Global event filters for `GET /api/events` / `cafe tail` (host, type, thread, heartbeats hidden by default); `replayAfter()` for SSE resume |
| `scripts/router-eval.ts` | `npm run routing:eval`: offline rules eval over 53 labelled cases (`tests/routing-fixtures.ts`); `--model provider/model [--repeat N] [--json] [--out file]` for a real-model sample (costs money, never in `npm test`) |
| `packages/daemon/src/supervisor.ts`, `proc/` | Headless workers under a guard that dies with the Daemon; per-Barista `bin` (pi / omp) or `agent` (codex / claude → `node <defaultCliBin()> barista run`), `access`, `model`, `tui` + `thread` (codex only; one worker whatever the concurrency) |
| `packages/daemon/src/index.ts` | `runDaemon()`, lock, discovery start/stop |
| `packages/cli/src/main.ts` | The `cafe` command. New: `init`, `doctor`, `extension install|status|uninstall`, `router models|set|status|apply`, `host rename|alias`, `agent rename|alias`, `daemon rename|restart`, `connect`, `root test`, `tail`, **`config diff|apply`**, **`commands status|install|uninstall`**, **`ask --attach`, `thread --download`**; help has a Quick start; unknown commands fail even with `--help` |
| `packages/cli/src/commands.ts` | Slash-command entry points: `cafe commands status` (pi/omp extension, Claude plugin + `/cafe-ask`, Codex `$cafe`), installs `~/.claude/commands/cafe-ask.md` with a marker, refuses to overwrite a person's file unless `--force`, uninstall only removes its own file |
| `packages/cli/src/init.ts`, `doctor.ts`, `extension.ts`, `errors.ts` | Guided `.cafe` creation; health checks; pi/omp extension install/status; daemon API error formatting |
| `packages/cli/src/service.ts` | launchd plist / systemd unit generation and (un)install; `servicePath()` drops temp and per-terminal shim dirs (cmux) from the service PATH; `startInstalledService()` |
| `scripts/perf-tls.ts` | `npm run perf:tls`: TLS vs plaintext round trip / new connection on one scratch Root (report, not a gate; #61) |
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
| `packages/web/` | React 19 + Vite 6 + Tailwind v4; zh/en; single store with `useSyncExternalStore`; fixed Shell, compact feed with whole-card click and 2-column list at ≥1800 (drawer closed), right detail drawer / three-pane at ≥1600, info rail at ≥1920, nav Agents sublist (open by default on desktop, remembered; agent rows open the rename/alias menu on right-click or Shift+F10 — no per-row ⋯ button, which used to fall onto a second grid line; menus close on outside click/Esc); Agent cards show the working directory and a separate 负责范围/scope row; Settings drawer (machines + remote rename, start/stop Baristas, routing, connection root/token hint, **pending config + health checks**), Live page, drawer open/close animation and click-outside close; feed has "load older" and full-text search; cards show `你`/`代问` provenance and **📎 attachment count**; **displayName shown in Network/Agents/Live/Shell; Network cards can test/reconnect/rename/copy CLI**; a banner appears when the built Web UI on disk is newer than the daemon's in-memory copy; long Threads load older events; Live backfills events after a WebSocket reconnect; snapshot 200-thread payload is clipped; **composer uploads 0–N files, Thread shows/downloads attachments**; **token from another device: `auth.ts` + `ui/TokenGate.tsx` (#97); encrypted access: `security.ts` + `ui/Security.tsx` (banner, Settings section, v4-9)** |
| `skills/cafe/SKILL.md` | Skill for Claude Code / Codex / pi; `cafe skill install` symlinks it |
| `tests/` | vitest, **693 tests** (2026-11-26) (+5 mod tests via `npm run test:claude-plugin`): **TLS transport (`tls-certs|trust|server|client|child|bootstrap|renew|cli|untrusted|lifecycle|renewal-predicate|runtime-renewal|san-coverage|peer-pin`, `security-token`)**, **per-target sub-questions (`per-target-questions`)**, **web tab icon (`web-icon`), resizable sidebar (`web-nav-width`)**, **scratch configs stay off 4778 (`scratch-configs`)**, identity/display names/aliases, legacy names and removal (`identity.test.ts`), provenance (`provenance.test.ts`), **attachments (`attachments.test.ts`: local, cross-host pull/proxy, limits, CLI upload/download)**, **daemon health endpoint (`doctor-api.test.ts`)**, **health metrics and search stats (`metrics.test.ts`)**, **heartbeat lease regression (`heartbeat.test.ts`)**, **routing observability and `/api/routing/stats` (`routing-observability.test.ts`), routing aggregates (`routing-stats.test.ts`)**, connector SDK/mock/CLI/idempotency/crash-restart (`connector.test.ts`, restart wait deflaked), Discord connector core + fake-platform end-to-end (`discord-connector.test.ts`), FTS search + prune index cleanup (`retention.test.ts`), bounded caches (`cache-bounds.test.ts`), claude install exit code + commands status (`commands.test.ts`), `knownDaemons` reachability (`known-daemons.test.ts`), router control/timeout/concurrency (`router-control.test.ts`), rules eval + hints (`routing-eval.test.ts` over `routing-fixtures.ts`, 53 strict + `EXTRA_CASES` overlap/morphology/multicast/top-k/variants/stability), rules decisions (`routing-rules.test.ts`), fan-out grace (`routing-grace.test.ts`), follow-up race (`until-closed.test.ts`), bounded metadata (`bounded.test.ts`), reply entry (`reply-entry.test.ts`), controlled update + drain (`update.test.ts`), global event filters, SSE resume and the WebSocket backfill endpoint (`events.test.ts`), config contract incl. pending and the write API (`config-contract.test.ts`), thread paging, limit validation, unknown-stream 404 and snapshot summaries (`thread-paging.test.ts`), client event buffer (`client-recent.test.ts`), CLI init/help/config/redaction/status/aliases (`cli-init.test.ts`, `cli.test.ts`), extension/doctor (`extension.test.ts`, `doctor.test.ts`), thread summaries (`thread-summary.test.ts`), `.cafe` discovery (`cafe-file.test.ts`), store tail/recovery (`store.test.ts`), service retarget (`service.test.ts`), plus session host, Codex TUI, e2e (incl. the slow-ack heartbeat regression), follow-up/recovery, pi extension (incl. `/cafe`), serve (incl. preset safety), supervisor, routing hints, direct links, discovery, retention/search, client reconnect, versions, Bridges, MCP |

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
npm test                   # vitest; current baseline 693 tests (count changes as tests are added)
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
- **Forgetting a Host is not a ban (v4-8).** `forgetHost` only removes what the network remembers; a machine with the token rejoins. Do not make it block reconnects without a per-Host credential (TLS phase 2). Online Hosts are refused (`host_online`).
- **Discord: one channel = one Thread, until** the channel is quiet for `newThreadAfterHours` (default 6, from the Thread's `lastActivityAt`) or the person sends `/new` (user decision 2026-11-24). Conversation cards show the latest activity time; the title stays the first question.
- **Daemon-link liveness is transport-level and scoped (v4-10 #99).** Only `kind: daemon|peer` sockets send ping/pong; never agent or UI sockets. The watcher starts on `open` (pinging while CONNECTING throws and would kill a slow dial), stops on `close`, and `Daemon.stop()` clears every watcher.
- **`config.root` belongs to the person (v4-10 #104).** Failover rotates `config.root` → `lastRoot` (kv) → `root/moved` candidates and never rewrites the file; a learned candidate that answers as a different Root is refused, only a person-set address may change which Root a Host belongs to. mDNS re-discovery backs off (30 s → 5 min, 6 tries).
- **An address pin is proven before it is saved (v4-10 #103).** `setHostAddress` probes first; a failed probe is not written to `config.yml` and never hides the address of a Host that is online. An offline Host may still pre-set one (it is never broadcast while unverified).
- **`barista --tui` never guesses a session (v4-10 #100).** One session in the directory is used and named; several → list them and require `--thread <id>`; a session with a running turn is skipped when choosing between several.
- **A grace skip is not a decline (v4-10 #101).** `order.declined` may carry `skipped: true`; it stays in the log for audit but is not booked in outcomes or `meta.declines`.
- **A sub-order is a sub-Thread (v4-11).** `escalate: true` (with `parentOrderId`) creates a NEW Thread linked by `parentThreadId`; never a second open Order in the parent Thread (`ThreadMeta` is a one-Order aggregate). `parentOrderId` alone keeps its legacy provenance meaning and must not be re-read as escalation. Explicit `to:` bypasses the chain (bounded by `MAX_ORDER_DEPTH`); an escalation never falls back to the router or an implicit broadcast.
- **Channels are scopes, not permissions (v4-11).** `eligible()` filters by `channels` and excludes observers; an explicit `to:` may cross channels. A registered agent's fresh Order defaults to its home channel (`channels[0]`). One `.cafe` = one team; rosters replicate to the Root with a revision and persist in `teams.json`.
- **`collect: all` has no grace (v4-11).** Deadline silences are `order.declined {skipped: true, reason: "deadline"}`, never declines; `ThreadMeta.targetStates` is the display truth.
- **Observers are never routed to (v4-11).** They receive one digest per interval per channel; a child digest is `partial` while the Root is offline. A digest wakes one turn, queued behind an in-flight Order.
- **A team has exactly one orchestrator (v4-13).** A `.cafe` team with 0 or >1 orchestrators is a hard error; the orchestrator is the team's front door. `to: <team>` and a fresh message in the team channel with no `to:` reach **only** the orchestrator; reaching everyone requires an explicit `broadcast: true`. A team with no orchestrator cannot be addressed as a team (`no_orchestrator`).
- **A follow-up never falls back to the router (v4-13).** Targets are the previous turn's final responders, then that turn's `targetStates` targets, then `responders_offline`. An explicit `to:` or `broadcast: true` overrides. Do not reintroduce a rules/LLM fallback for follow-ups.
- **An authoritative `.cafe` roster owns membership (v4-13).** `publishRoster` publishes the full roster and sets `authoritative`; `teams()` never grows an authoritative roster from live registrations; a member removed from `.cafe` is not eligible even while its process runs. `contentHash` makes an identical re-publish a no-op.
- **Removal is a tombstone, not a delete (v4-13).** `removed: true` with a newer revision stays in `teams.json`; a delayed `team/upsert` loses; only `cafe team start`/`team sync` (a person action) clears it.
- **`team-sessions` is a separate feature flag (v4-13).** `teams` (v4-11) is not enough: a v4-12 daemon would multicast `to: <team>`. A new client refuses channel/escalate/`collect: all`/team identity/team target on a daemon that does not advertise the capability, **before** the Order exists; a warning is not a downgrade.
- **Root owns the complete digest while online (v4-13 #109).** The Root publishes for every observer in its registry; a child publishes `partial` only while the Root is offline. `digestId` is `host:seq`; the client dedupes by id and `(publisher, channel, since)`.

## 5. Waiting on the user (start the next session here)

**Dogfooding issue handoff.** At the end of each session, include recommendations for the external dogfooding ledger in this handoff and in the user-facing summary. For each issue, give its ID, the suggested status or revised acceptance criteria, and the evidence from the current code, tests, or reproduction. Name any acceptance checks still pending. The user forwards these recommendations to the tester, who can verify them and update the ledger. Treat the external ledger as read-only unless the user separately requests an edit.

### 2026-11-28 — Authorization, worker and dogfooding checkpoint

- **Resume here.** The local feature branch was fast-forwarded into `main`. Continue on local `main`, which includes the authorization and worker checkpoint commits. Use `git status --short --branch`, `git log --oneline -8`, and `git rev-list --left-right --count main...origin/main` to verify. The user approved a commit per phase and a push after the planned work clears its release checks.
- **Assignment and results.** Owner-specific payloads and routing variants live in owner-local SQLite, while the shared journal carries assignment metadata and a digest. Live TLS forwarding preserves canonical creation and assignment evidence. The receiving Host persists the assignment before delivery. Missing assignment, delivery and reply evidence stages durably and replays when evidence arrives and at startup. Agent final replies on authenticated assignment paths require an owner-authored final acceptance. The Root and owner converge in the test where the operator commits first and an Agent reply reaches Root first. Secure human clarification answers include the human actor and the exact parent assignment attestation. Keep the Host/Agent assignment capabilities and `caller-auth-v1` reserved pending mixed-version and recovery validation. Read the [Task 4 gap plan](../superpowers/plans/2026-11-28-host-auth-task4-gap-closure.md), [assignment privacy plan](../superpowers/plans/2026-11-28-private-assignment-payload.md), and [owner arbitration plan](../superpowers/plans/2026-11-28-owner-final-result-arbitration.md).
- **Caller transport and state transitions.** CLI/MCP use same-host endpoint discovery and pin the Root CA and Host ID per remote HTTPS connection. Remote cancellation still requires its reserved capability. An `order.replaced` append commits the old closure and the new Order. Recovery repairs lagging metadata and retries an undelivered committed replacement. Tests cover a new target on a previously uninvolved TLS Host. Operator results use `order.overridden`. Conversation shows later replies separately and credits the actual override targets. Further rollout work includes capability checks on every relay hop, bounded assignment inbox retention and complete compatibility checks for projections and old journals.
- **Agent resume and queue.** Managed Pi/OMP and native bridges receive a protected local state path from the supervisor scoped to the worker. A fresh client can reuse the exact Agent ID, report on an earlier Order, and resume a queued assignment after the first receipt response is lost. The recipient confirms assignment status with the owner before returning a receipt and `order.delivered` reflects durable acceptance for the managed path. The queue persists a claim before running a handler. Verify real cross-process recovery and receipt behavior under multi-Host outage, retention and mixed-version scenarios. Local tests model a fresh client and real disk state.
- **Worker scopes and roster.** The supervisor retains configured writer scopes across partial starts, persists process-group retirement scopes, checks identity before signalling, and migrates saved local rosters at startup. TUI registration checks the committed launch configuration and canonical cwd. A stale terminal directory keeps its own reservation until `cafe team release-tui <id> --closed`. `team revoke-path` persists revocation, disconnects relevant registered sessions and requests managed worker shutdown. `team sync` stops workers removed from the roster or no longer authorized and waits before publishing. Work remains on complete worker reconciliation and restart intent, path revalidation during runtime, safe relocation and acknowledged Root roster CAS. Keep `team-roster-ack-v1` reserved. Real Pi 1.6.0 and OMP 19.0.1 tool isolation did not meet the reviewed probe requirements. Keep their production read-only launch paths fail-closed.
- **User-facing dogfooding changes.** `cafe team status <team>` and `--all` read published teams without a local roster directory. `--host` and `--channel` narrow same-name matches. Legacy child certificates retain local service and `cafe doctor` gives both steps for invited enrollment. The bilingual README files cover the new commands and migration. Feed creation-time pagination uses `(createdAt, threadId)` across the snapshot and subsequent pages. `/api/threads?before=<timestamp>` retains its timestamp-only semantics. Child listing still has its separate pagination gap.
- **Running tests in Claude Code.** The user approved `Bash(npm test)` in the ignored Cafe-local `.claude/settings.local.json`. `npm test` calls the installed Vitest using a fresh scratch `CAFE_HOME`, unreachable loopback default, discovery off, no inherited Cafe token and a scratch attachments directory. `npm test -- <filters>` can trigger a separate Auto Mode decision. The RTK hook rewrites direct `npx vitest` invocations. The dedicated entry point was used for full suite verification and leaves the scratch directory available for troubleshooting.
- **Ledger recommendations for the tester.** The external ledger has 84 open entries and was reviewed read-only. Recheck #158, #203, #210, #211 and #213 for closure of the original symptoms. Recheck #217 for closure with the CLI test for named, offline, missing and same-name teams. Recheck the activity window in #185 and the Feed cursor case in #134 for closure. Keep #134 child paging as a separate open item. Split the fixed zero-target follow-up case from broader #212 result consistency. #215 now has an automated old-certificate migration and Doctor test. Retain the real old-child upgrade acceptance check. #183 and #184 have targeted TUI binding and sync-stop coverage. Keep full runtime and reconciliation acceptance visible. #208 can narrow to tested and supported managed-worker restart scope. Retain #197 for the complete user-result reporting journey and #216 for operator-key recovery.
- **Verification and remaining access.** Final isolated `npm test` exited zero. The recorded run before the last receipt and Feed regressions covered 145 files and 909 tests. Core and Web type checks passed. Rules routing passed 67/67. Offline package smoke and the embedded Web build passed in scratch after the managed-receipt implementation. Auto Mode denied the package-smoke rerun after the last receipt changes because `test:release` is outside the exact permission for `npm test`. The plugin suite was left for the release check.
- **Release checks.** Before integration, inspect the plan checkboxes against current behavior. Resolve local reconciliation and relocation, Root roster acknowledgements, bounded recipient inbox reclamation, and mixed-version relay negotiation. A real second Host, cross-process invitation and receipt replay, live mixed-version rollout, and browser acceptance still require operator-controlled environments. npm publishing remains under operator control. The workspace daemon was left on its previous release during these protocol changes.


### Follow-up UX and worker checkpoint

- Continue on `fix/cafe-onboarding-authorization-2026-11-27`. Check `git status --short --branch`, `git log --oneline -8`, and the local and remote `main` refs. The local `main` fast-forward includes the narrow `.claude/worktrees/` and `.claude/settings.local.json` ignores. It leaves tracked `.cafe` and the worktrees intact. The user authorized pushing `origin/main` after all planned work is complete. That condition is still open.
- `team stop` identifies the recorded roster directory through a live symlink and can stop workers with the recorded path after `.cafe` disappears. Both team and standalone managed writers check canonical paths and filesystem ancestry. The live supervisor holds a retiring writer's scope while the process group exists and revalidates identity on relaunch. Durable reservations, TUI binding and release, grant revocation, `team sync`/relocation, and Root CAS acknowledgements are still open. Standalone readiness matches the worker cwd. Binding readiness to an exact launched Agent remains open.
- The [follow-up outcome spec](../superpowers/specs/2026-11-27-conversation-followup-outcomes-design.md) and [plan](../superpowers/plans/2026-11-27-conversation-followup-outcomes.md) cover #211/#212. The Feed and search preserve the last eligible answer when a later follow-up had no target. The historical preview derives from pre-close finals in journal append order and is separate from exact-Order status. Legacy data uses bounded background recovery. See `followup-outcome.test.ts`, `followup-outcome-recovery.test.ts`, and `web-followup-outcome.test.ts` for coverage.
- The [Team result journey spec](../superpowers/specs/2026-11-27-team-result-journey-design.md) and [plan](../superpowers/plans/2026-11-27-team-result-journey.md) were independently reviewed. CLI/MCP receipt copy and runtime guidance were corrected. An accepted clarification can contribute to the exact parent Order's progress and awaiting-report state. A scratch integration covers reporting after same-process reconnect, a denied namesake, and an idempotent retry. Cross-process resume proof and completed authenticated cross-Host acceptance still depend on Host Auth Task 4. Additional fixes cover `/cafe-team` start guidance (#202), `init --force` help (#203), and encrypted-port troubleshooting (#158).
- Host Auth Task 3 now has isolated tests for the same Root identity at a changed endpoint and a legacy-style handshake missing the capability. Task 4 still needs the exact assignment/receipt path, durable Agent identity and queue, pending replay, event authorization and clarification attestation. An owner-only journal prototype was withdrawn after review found that linked detail could export its payload and recovery could bypass it. In the next implementation, audit journal export and recovery together with relay. Task 5 remote pinned TLS selection and Task 6 atomic replacement/override remain open. Keep `caller-auth-v1` and `team-roster-ack-v1` reserved.
- Real isolated runtime checks used Pi 1.6.0 and OMP 19.0.1 with no model calls. Pi's effective list matched the allowlist. OMP's list included unexpected write tools with the proposed flags. Neither RPC dispatcher exposed direct tool invocation for proving the fake write request was rejected. The managed Pi launcher hash alone does not bind the loaded payload. Keep both production paths fail-closed until the runtime and payload checks meet the worker plan.
- Verification used a fresh OS scratch `CAFE_HOME`, unreachable default loopback address, discovery disabled, and `CAFE_TOKEN` unset. The checkpoint passed 144 files / 884 tests, core and Web type checks, rules routing 67/67, offline package smoke 17/17 including Web build, and Claude plugin 6/6 with validation warnings. The workspace Root was restarted with `cafe daemon stop` and `cafe daemon start`. `cafe doctor` passed all checks. Legacy follow-up projections appear on a fresh Feed load or search request after backfill. Browser interaction was not tested. Real cross-process invitation, second physical Host, mixed-version traffic, and npm publishing remain external acceptance items.

### 2026-11-27 — Safe onboarding and mutual TLS implementation in progress

- Work is on `fix/cafe-onboarding-authorization-2026-11-27`. Check `git status --short --branch` and `git log --oneline --decorate -8`. The owner authorized a push to `origin/main` after the planned work is complete. Keep incomplete work on its local branch. `main` is the earlier enrollment baseline. Read the [Host and caller authorization plan](../superpowers/plans/2026-11-27-host-and-caller-authorization.md) and its [reviewed design](../superpowers/specs/2026-11-27-host-and-caller-authorization-design.md).
- First-use fixes are in the local branch. `cafe init --force` preserves team and malformed files, validates its generated YAML before replacing standalone files, and Doctor advises in-place repair. CLI and Web Root hints include a one-use invitation and favor the reachable TLS listener. The three starter `.cafe` examples parse as YAML. `.vitest/` is ignored.
- Host authorization Task 3 implementation covers the shared TLS listener, certificate-free UI and Agent connections, authenticated inbound/outbound Host links, Root-pinned ID, Root binding refresh, and closing connected peer links when a binding changes. CLI enrollment persists exact retry inputs and adopts the assigned slug. Child startup preserves the enrolled key during temporary local TLS fallback. Address pins are legacy configuration. Complete the Task 3 acceptance checks before marking its plan checkboxes done, especially old-version behavior, real re-key, and routing to an address that changes without changing Root ID.
- Task 4 started. New events carry the issuing Host ID on enrolled transport, and Agent events carry actor identity. Authenticated ingress checks source Host and backfill sends locally authored events. The Store now supports recipient assignment and receipt persistence and exact assignment lookup. The 5,000-entry inbox limit fails closed, with retirement/reclamation still to be designed. Relay, durable Agent queues, pending replay, assignment-level authority and human clarification attestations still need end-to-end wiring.
- Task 5 now has authenticated HTTP caller principals, per-caller idempotency, unverified provenance labels, an operator credential gate, MCP opt-in and stable MCP ownership, and local connector provisioning/revocation. CLI support for automatically discovering a remote pinned Root TLS endpoint is still pending. Task 6 has exact owner/operator/connector cancellation and exact operator request IDs. Replacement routes and rechecks the current Order before closing it, but still needs the single durable `order.replaced` transition and recovery. Operator overrides still use a labeled legacy event and need the dedicated transition plus late-event arbitration. `caller-auth-v1` and `team-roster-ack-v1` remain reserved and unadvertised.
- Team Worker Permissions has local path grants, operator-only `team trust-path` and `team paths`, canonical validation before roster publication and headless launch/restore, and overlap checks for write-enabled members in one launch and against active writers. Pi/OMP allowlist flags and the test probe adapter exist. The production probe stays fail-closed until the real Pi 1.6.0 / OMP 19.0.1 isolation test proves the effective tool registry and fake MCP write rejection. Finish durable reservations across partial starts and stopped members, TUI launch binding, safe grant revocation, and sync reconciliation with Root acknowledgements. Read the [worker permissions plan](../superpowers/plans/2026-11-27-team-worker-permissions.md) and [design](../superpowers/specs/2026-11-27-team-worker-permissions-design.md).
- Verification on the integrated checkpoint passed in an isolated OS scratch directory: 141 test files / 846 tests, core and Web TypeScript checks, Web production build, and rules routing eval 67/67. The fixture run used an unreachable default loopback daemon address, disabled discovery, and left `CAFE_TOKEN` unset. Scratch under the repo inherits its tracked `.cafe` and invalidates missing-identity tests. Offline package build, pack, install and 17 smoke checks passed with explicit `--write` in the disposable Pi startup fixture. This exercises packaged extension loading. Real read-only tool isolation still needs its own acceptance test. The Claude plugin passed 6 tests and validation reported the existing timer typings and missing icon warnings.
- No live enrollment, live daemon restart, or external ledger update. Physical second-Host enrollment, mixed-version traffic, and npm publishing remain pending. One MCP fixture run may have created `~/.cafe/mcp-owner.key` before its CAFE_HOME was isolated. The file was left intact and its contents were not inspected. Version is 0.2.0.

### 2026-11-27 (later) — Host identity enrollment and caller authorization, in progress

- **Read first.** [Host and caller authorization design](../superpowers/specs/2026-11-27-host-and-caller-authorization-design.md) and its [plan](../superpowers/plans/2026-11-27-host-and-caller-authorization.md); [team worker permissions design](../superpowers/specs/2026-11-27-team-worker-permissions-design.md) and its [plan](../superpowers/plans/2026-11-27-team-worker-permissions.md). Both designs passed repeated independent builder checks and multiple rounds of security review; the latest review rounds are reflected in the documents.
- **Done and pushed this session** (tasks 1–2 of the authorization plan): protocol primitives (`HostIdentity`, `EventActor`, `eventHostId`/`actor`, `OrderAssignment`, `assignmentId` on agent events, `order.assigned`/`order.replaced`/`order.overridden`, `parentOwnerAttestation`, `replaceOrderId`, `TargetState` including `overridden`, feature flags `host-auth-v1`/`caller-auth-v1`/`team-roster-ack-v1`); durable pending-event journal and replacement indexing under both Order IDs; Store tables for Host identities, Host invites, invite redemptions (with supersession tombstone) and caller principals; dual-use Host certificates with a `spiffe://cafe/host/<hostId>` URI SAN; Root-assigned Host identity persisted at startup; `/api/host/invites` (loopback + local `operator.key` only) and invite redemption at `/api/tls/leaf` (TLS + token + one-use invite, idempotent by invite/requestId/SPKI/SAN hash, replacement compare-and-swap, superseded tombstone); renewal by signed key-possession challenge (`/api/tls/challenge` → signed nonce → `/api/tls/leaf`), so an expired leaf renews without a new invite; children without an invite stay local-only instead of silently joining; `/api/tls` and `/api/health` expose `hostId`/`rootHostId`; `cafe host invite` and `cafe connect --invite` CLI.
- **Verification:** `npm run typecheck` passed; full `npm test` passed (136 files / 808 tests). The TLS suites were rewritten from the pre-invite "child auto-joins" contract to invited enrollment (`tests/tls-bootstrap|join|peer-pin|accept|addresses|multi-address|child`), matching the spec's fail-closed rule.
- **Unverified / blocked here:** the cross-process CLI path (`cafe host invite` → `cafe connect --invite`) has no automated test in this session: the sandbox auto-reviewer refuses a spawned process that sends an invite/token to a live Root (treated as data exfiltration). `tests/connect-host-invite.test.ts` was written and then removed for that reason; verify manually on a real machine (see the plan's Task 2). The daemon-side invite/redemption/renewal path is covered by `tests/tls-host-enrollment.test.ts` and `tests/host-invite-store.test.ts`.
- **What remains of the authorization plan:** Task 3 (mutual TLS admission: optional client cert on the shared listener, binding `initialize.kind=daemon|peer` to the certificate hostId/SPKI, outbound pinning to `rootHostId`, handler binding only after verification), Task 4 (durable `order.assigned` before relay, recipient inbox/Agent receipt replay, type-specific event authority, Root pending-event staging and source-only backfill, owner-authored clarification attestation), Task 5 (owner/connector first-use credentials, operator credential on `replyAs`, caller-scoped idempotency, HTTP provenance/`provenanceVerified`), Task 6 (exact `orderId` cancel, `replaceOrderId` with one durable `order.replaced` transition, `order.overridden` with serialized target transitions, CLI/Web/MCP wiring), Task 7 (verification + docs). Do not expect `cancel`/`replyAs`/idempotency authorization to hold until tasks 5–6 land: today's code still accepts them as before.
- **Not started:** the whole team-worker-permissions plan (read-only Pi/OMP allowlists + binary-hash probe, path grants, write-scope reservations, TUI launch hash, sync reconciliation, Root roster ack) and the CLI's truthful `done` vs `working` output fix.
- **Rulings made** (also in the plan ledger): `stagePendingEvent` keys the missing authority as `{kind, id}`; Host/invite/caller persistence stays in Task 1; tests assert the new fail-closed contract for uninvited children; renewal is key-possession, not invite-based.
- **External blockers unchanged:** no real second physical Host, no mixed-version network trial, no npm publish, external issue ledger untouched. Package version still 0.2.0.

### 2026-11-27 — 补报读路径与 dogfooding 回归（历史记录）

- **接手。** 用 `git status --short --branch`、`git log --oneline -6` 和 `git rev-list --left-right --count main...origin/main` 核对代码、交接提交和推送状态。下节的任务生命周期批次已上 `main`。本轮沿用其设计与计划，新增的是已知缺陷的回归修复。
- **补报。** CLI JSON 的 `reports` 与直接 `replies` 分列，CLI 文本和 MCP `cafe_wait` 显示 `result report`。选定 Order 的 SSE 仍在该轮终态关闭，随后通过 `/api/threads/:id/result?orderId=…` 读取已经落地的补报和该 Order 的任务状态。等补报的人在前门提交之后可以再次读取。`cafe wait <threadId> --order <orderId>` 支持旧轮次，错误的 Order 返回 404。Root 与请求者 Host 的同步沿用已有的 `thread/reports`，有效范围以精确 Order 为准。旧 daemon 的 CLI 回退读取最新 Thread 状态。
- **搜索。** `order.reported` 可走 FTS 和短查询回退。同一 Thread 即使已有旧索引，也会在升级时补扫一次。回填按旧到新，每次启动最多处理 4,000 条 Thread，完成标记持久化，更多记录会在后续启动继续处理。
- **体验。** #118 支持 `cafe thread show <id>`。#146 历史有更早事件时给出可直接运行的 `--before <eventId>` 命令。#133/#134/#185 的频道路径使用 `(last_activity, thread_id)` 游标与 `limit + 1`，同毫秒边界不漏项，子 Thread 和通用列表游标仍是独立范围。#135 频道活跃度取最后活动。#150 Pi/omp 无正文时发 operational decline。#115 更新客户端前门名称与 playbook 并拒绝陈旧名册版本，已运行进程热切换自己的职责和 Claude 会话内的提示刷新仍待验证。
- **心跳与追问。** #153 心跳续租，仍可通过协议与全局实时事件观察。新的心跳跳过 JSONL 和逐 Thread SSE，保留落盘游标的重放语义。旧 JSONL 与其中的游标继续可读。#155 追问向前读取最近 12 条问题与最终答复，心跳不占条数。#129 daemon、Pi/omp 和 `cafe serve` 共用 1,500 字符的首尾节选，标示截断并保留结论。极长的旧日志仍可能需要同步扫描。#131 列表标明创建时间或该轮关闭时间。
- **台账判断。** 外部 dogfooding 台账是独立工作区资料，本轮只读。#111、#120/#121/#194、#147/#148、#154/#156/#162/#181 的修复证据见历史节与测试。建议按实现、跨 Host 验证和实际用户判据分开确认。#160 的 `cafe connect` 地址用于发现 TLS 端口和公开 CA，HTTPS Web 地址用途不同。仅开放 TLS 端口的部署及说明可单独核验。
- **仍需处理。** Release 门槛包括跨 Host 独立身份、#137 cancel/replace 归属、#138 HTTP `replyAs` 调用者认证、#149 HTTP 订单来源、#180 幂等调用方作用域。#182 的 JSON 上限已落地，请求超过 1 MiB 返回 413，附件继续走上传路径。下一批优先统一 CLI、Web、MCP、连接器和 relay 的身份及兼容交互，先做 spec 的独立 builder review，再写 plan。团队目录与权限 #127/#144/#161/#183/#184，以及 #139 级联取消和 #176 派单预期仍待设计或实现。
- **验证。** 最终代码通过全量 Vitest（131 文件、786 项）、TypeScript、Web check/build、routing 67/67、隔离打包冒烟 17/17。Claude 插件测试通过 6/6，校验仍有既有的 `setTimeout` 类型环境与缺图标警告。独立审阅覆盖补报、分页、请求体、心跳回放和历史截断，已处理发现的行为回归。
- **运行与环境。** 工作区本机 Root 使用 0.2.0，最终代码已 stop/start，`cafe doctor` 全绿。第二物理 Host、混合版本实网与 npm 发布仍待 operator。`.vitest/` 保留为未跟踪目录，首轮 RTK 默认 reporter 更新了其中的 JSON，后续走 `rtk proxy` 与隔离的附件路径。


### 2026-11-27 — Order reports and conversation history

- Start with `git status --short --branch` and `git log --oneline -6`. The [lifecycle design](../superpowers/specs/2026-11-26-task-lifecycle-and-event-auth-design.md) and [implementation plan](../superpowers/plans/2026-11-26-task-lifecycle-and-event-auth.md) explain the Order and task contracts.
- `cafe wait <threadId> --order <orderId>` reads status for the selected historical Order. CLI JSON includes completed result reports in `reports`. CLI text and MCP `cafe_wait` show the report text. The Order stream ends at the terminal event. A subsequent wait can read reports that arrived afterward.
- Reports are searchable through FTS and the short-query fallback. A bounded upgrade scan indexes older reports in batches. The scan handles up to 4,000 Threads per startup and records progress.
- Thread history can page backward by event ID. Channel activity pages use `(last_activity, thread_id)` to preserve entries with matching timestamps. Thread listings label creation and closure times. Follow-up excerpts retain the start and end of long messages. Heartbeats still renew leases and appear on live feeds. The resumable Thread stream sends journaled events and can replay legacy heartbeat entries.
- JSON request bodies are limited to 1 MiB. Large content can use the artifact upload route. Pi and omp send an operational decline when a run produces no answer. The protocol client refreshes the team front door from roster updates and ignores stale revisions.
- Verification for this batch passed across 131 test files and 786 tests, TypeScript, Web check/build, routing evaluation (67/67), package smoke (17/17), and Claude plugin tests (6/6). The local workspace Root passed `cafe doctor` after restart.
- Before release, continue the authorization work described in the lifecycle design. Review the caller identity spec independently before writing its implementation plan. Physical second-Host and mixed-version deployment tests remain pending. The package version is still 0.2.0.

### 2026-11-27 — 任务生命周期与事件授权（历史记录，已合入 main）

- **接手入口。** 设计 [task lifecycle and event auth](../superpowers/specs/2026-11-26-task-lifecycle-and-event-auth-design.md)（经独立 builder check 两轮，“nothing important left”），计划 [implementation plan](../superpowers/plans/2026-11-26-task-lifecycle-and-event-auth.md)，逐任务记录在 `.superpowers/sdd/2026-11-26-task-lifecycle-and-event-auth/progress.md`（该目录被 git 忽略，仅本地）。用 `git status --short --branch`、`git log --oneline -5` 核对现场；`.vitest/` 是既有未跟踪目录，本轮未触碰，测试统一用隔离的 `--attachmentsDir`。这批提交已经合入并推送。以本节上方的最新记录为准。
- **任务时限（#181/#156/#154）。** unicast 默认硬上限从 10 分钟改为 2 小时；ack/heartbeat 仍按 lease 判“没进展”；`deadlineMs` 必须是 1–2147483647 的整数，否则 `bad_request`；硬期限按 `createdAt + deadlineMs` 绝对时刻执行，路由耗时会消耗同一期限，到期前不再投递；恢复沿用同一绝对时刻。`recover()` 改为 `(createdAt, threadId)` keyset 分页直到空页，不再只恢复最近 1000 个 open Thread。
- **串行容量。** 单个 Cafe 会话固定只启动一个 worker，`.cafe` 配 `concurrency > 1` 时 `barista start` 打印一条 warning；pi/omp 扩展与 codex/claude bridge 注册时一律报 `concurrency: 1`。真正的并行需要不同的成员身份和目录（#144 的共享目录问题仍单列）。
- **父任务状态。** `ThreadMeta` 新增可选 `reportedOrderId`（由 `order.reported` 事件写入的唯一索引值）与派生的 `taskStatus`（`working` / `awaiting_report` / `done` / `failed` / `cancelled` / `unknown`）。父 Order 自己的 `status` 与直接回复数不变。判定只使用与该 `parentOrderId` 精确匹配、且经投递或人类所有者证明的子 Thread；澄清子 Thread 不计入。Root 用本地全量子项索引；非 Root 列表用一条批量 `thread/task-statuses` 请求取 Root 结果，Root 不可用时只对本地已知的关联工作标 `unknown`（普通会话不因此变成 unknown）。详情页可单独向 Root 取完整视图。子 Thread 也可以是父（嵌套委派），详情对任何发单在本机的 Thread 都投影。
- **授权边界。** 协议的 ack/heartbeat/reply/decline 先核对 `AgentRecord` 对端身份，再按精确 `(orderId, threadId, agentId, host)` 的持久化 `order.delivered` 记录放行；非 target 返回 `not_a_target`。Order 结束后只保留“已投递 target 的最终回复（审计）”和 `order.reported`，其余迟到 ack/heartbeat/decline 丢弃；仍 open 时，已失败 target 的迟到最终回复可恢复该 target，迟到 decline 不再触发下一个 fallback。`AgentRecord.activeOrderId` 与 `activeThreadId` 成对，旧 Order 的迟到答复不能清掉同一 Thread 的新任务。`parentThreadId` 必须对应真实 parent Order；父子链接需要已注册 peer 的实际投递证明，或原人类 Order 的所有权凭据（CLI）；链接一经建立不可在后续 turn 改挂，未链接的 Thread 不能事后补挂；越权 follow-up（含 `replace`）在取消任何 Order 之前就被拒绝；escalate 同样要求已注册 peer 的真实投递证明。agentId 续用需要匹配的 resume proof（本机从未记录 proof 时要求本次提供 proof，裸声明不再继承投递权限）。
- **操作员代答。** HTTP `replyAs`（`cafe reply`/MCP `cafe_reply`）标记为 `source: "operator"`，CLI、MCP wait、Web 详情/Feed/Live 与 pi 事件流都显示为“operator override”，且不计入 Barista 路由统计；daemon 传给后续 agent 的历史里也显式标注。它仍不是经过认证的 Barista 身份。
- **验证。** 最终全量 `vitest run` **129 文件 / 770 项**（修复后最后一轮见下方“仍待你本人”的前提）；`tsc`、Web check/build（56 modules / 388 kB）、`routing:eval` 67/67、隔离打包冒烟 17/17 通过。Claude 插件 validate 通过，但 `claude plugin test` 被本进程的 rollout 开关挡住（提示需另启带网络的 claude 刷新），未执行；这是环境限制，不是代码失败。
- **独立复核已处理。** 三类 reviewer（整枝、安全、React）发现并已修复：`order.reported` 被 closed-guard 丢弃的 Critical；子项展示分页把完整视图说成完成；Leaf 在 Root 断线/未同步时的状态优先；搜索结果的 taskStatus；嵌套委派被跳过；Feed 用分页行覆盖权威状态并丢失 operator 归属；operator 来源在 MCP/CLI JSON/Pi/历史中丢失；未授权 `replace` 先取消再拒绝；escalate 绕过投递证明；跨 Host 迟到 decline 触发 fallback；远端迟到最终回复进入 follow-up 路由候选；拉取附件期间对端断开仍写 `order.delivered`；`--wait-timeout` 超 Node 上限。React 专项 reviewer 的独立派遣被自动审查拒绝一次，后由整枝复核覆盖 UI。
- **Deferred minor（未修，记录在案）：** 会话页 header/rail 仍显示最近 Order 结果，与正文“Task status: …”并存（已加前缀和常驻 live region）；`restoredTaskStatuses` 只在内存，重启后 Leaf 脱离 Root 时可能退回本地视角；结束后到达的迟到最终回复仍会进 agent 回答统计（只做了路由候选过滤）；`localTaskChildren` 上限 10,001 行，超过即按 partial 处理；`cafe ask --timeout` 超过 Node 上限的旧行为未改。
- **发布阻塞（未变）。** 共享 token + 自报 Host 的跨 Host 身份仍未迁移；HTTP `replyAs` 调用者认证、cancel 归属、幂等键作用域、普通 HTTP 订单的 `origin`/`via` 自报、JSON 请求体上限未在本批处理。真实第二物理 Host、混合版本实网、生产 Root 重启、npm 发布仍由 operator 决定。外部 issue 台账本轮未改。
- **仍需你本人：** 审核上面的行为变化；决定是否在本机 `cafe daemon stop/start` 让新代码生效（本 session 已按既有偏好重启并跑 `cafe doctor`，见本轮结束语）；发版；真实第二 Host dogfood；在带网络的 claude 进程里重跑 `npm run test:claude-plugin`。

### 2026-11-26 — 人工澄清与父会话汇报（本地功能分支）

- 接手 `feat/team-clarification-live-reporting`，从 `git status --short --branch`、`git log --oneline origin/main..HEAD` 核对现场。设计和验收清单见 [team delivery](../superpowers/specs/2026-11-26-team-delivery-design.md) 与 [parent loop plan](../superpowers/plans/2026-11-26-team-parent-loop.md)。上一批已推送的名册工作见下节。
- #171。人类 CLI/Web 新单保存客户端所有权凭据的摘要。被投递的成员使用 `escalate` 发起澄清，父会话显示待答，答复由原发单 Host 核验，随后在澄清 Thread 创建只给原成员的续单。收到确认后显示已送达。成员在受理前离线时保留待答。同一答复重试复用原 Order。原始凭据不会复制到其他 Host。老 Order 没有所有权凭据，沿用 `parent_not_agent`。
- #120/#121/#194。父会话按父 Order 投影子 Thread，自身保留逐 Order 结束语义。CLI 在原 Order 已结束且有待办时显示 `working`、`orderStatus` 和 `pending`，可用 `cafe thread <id> --children` 看结果。前门可用 `CafeClient.report()` 或 pi/omp `cafe_reply` 的 `reportThreadId`／`reportOrderId` 补报。同机三 daemon 测试覆盖在线收件、远端任务完成、原 Host 回连后查询和打开子会话。浏览器用隔离 daemon 实测 Web 发单、澄清答复、收件确认和前门补报。
- **发布阻塞。** daemon/peer 握手仍以共享 token 和自报 Host 为基础，Web 管理凭据没有与 Host 身份分开。已实现的所有权证明约束原发单 Host 上的答复入口。跨 Host 的转发和事件仍依赖现有信任边界。建议单独设计 Host 准入，区分 daemon 与 Web/CLI 凭据，将 Root 握手和直连绑定到经批准的 Host 身份，并在接收答复、收件确认和补报时核验原 Order 与发送 Host。现有叶证书面向服务端，且签发接口接受共享 token，迁移时须一起处理准入。这个分支尚未合入或推送。当前生产 Root 未重启。
- 验收新增了三条恢复路径。已受理答复在重启后复用原 Order，前门补报在发报端和请求端重连后可读，原 Host 漏收澄清发布后仍能打开并答复。还需真实第二物理 Host 与混合版本验证。Root 查询按固定上限补回子任务和近期报告。外部 issue 台账未改，npm 发布仍由 operator 执行。
- 全量 128 文件、724 项测试通过。TypeScript、Web check/build 与 routing 67/67 通过，隔离打包冒烟 17/17，Claude 插件 6/6。独立设计与代码审查已跑。外部台账结构检查为 0 错误，保留 6 条既有警告。

### 2026-11-26 — Team 派单与反馈收口

- **接手入口**。设计见 [team delivery](../superpowers/specs/2026-11-26-team-delivery-design.md)，实施与剩余范围见 [plan](../superpowers/plans/2026-11-26-team-delivery.md)。设计经独立审查，已实现批次也做了两轮独立代码审查。用 `git status --short --branch` 和 `git log --oneline -5` 核对现场。
- **名册与运行器**。`team start` / `team sync` 从首次显式发布的 canonical 目录更新权威名册，目录绑定存本机 KV。现有无绑定名册在首次显式发布时认领。成员注册只会更新在线信息或维护 loose roster。仓库中的 `agent` 限 pi/omp/codex/claude，兼容 `bin: pi|omp`。恢复托管进程时也通过 `TeamLaunchSpec` 校验。名册目录迁移、工作目录授权范围（#144/#161/#183）和同步后停止已移除进程（#184）仍待处理。
- **寻址**。仅显式发布的团队有前门。团队 duty 和广播按团队名册限收件人，共用 channel 且无法确认团队时提示歧义。只有 loose roster 的普通 channel 仍可广播。无显式 channel 的团队或成员点名首单继承目标 channel。前门自投递被拒。多人团队回合后的追问要求点名。新单直达地址也会排除已移除成员。
- **派单与消耗**。pi/omp 的 `cafe_ask` 支持 `delegate: true`、`broadcast: true`。通过本机真实投递记录附有界父任务摘要，同机双 daemon 测试覆盖跨 Host 的委派。投递记录是有限的内存记录，重启或淘汰后摘要可能缺失。团队追问投送当前收件人自己的历史答复。`collect: all` 异步结果合并唤醒一次，pi/omp 通过 exact Order replay 恢复连接断开期间的结果。pi/omp digest 只展示，Claude digest 用 `/cafe-barista digest` 查看最近一份。
- **用户入口**。`dutyAliases` 是前门参考短语。任意自然语言仍先进入前门，确定性测试显式派了开发、测试两类子单。`cafe team start` 给出 TUI 启动命令。`cafe thread <id> --children` 可查看本机能见到的关联任务和结果摘要，子机提示到 Root 查跨机任务。#179 的 JSONL 追加保留原有半行并分隔下一条完整事件。
- **下一轮优先**。#171 目前仅区分 `parent_not_agent`，人工回问与答复送回 agent 尚未接通。#120/#121/#194 目前有 CLI 按需查看，父会话的跨机实时结果及前门最终汇报仍待做。审核 [可点击原型](../superpowers/specs/2026-11-26-team-clarification-preview.html) 后，用明确的请求者身份绑定实现答复，再验证断线、重启和跨机。另有 #16/#27/#39 等既有 backlog，本批未逐项核验。
- **验证**。TypeScript、128 文件 / 712 测试、routing 67/67、Web check/build、隔离打包冒烟 17/17、隔离 Claude 插件测试 6/6 全过。插件校验仍报告既有的 `setTimeout` 类型环境和缺 icon 警告。未跑真实浏览器或付费模型回归。
- **运行态与外部操作**。本机 Root 仍用 0.2.0 workspace link，已 stop / start，`cafe doctor` 全绿。外部 issue ledger 只读，`issuemd check` 无结构错误。npm 发布归 operator。真机第二 Host、混合版本实网和付费模型 dogfood 待测。需要打包时从当前代码重新构建，本批冒烟用的是独立 scratch checkout。

### 2026-11-26 (follow-up) — v4-13 team dogfood + 0.2.0 local release candidate

- **用户已同意的方向**：团队是显式派单/回报协议，不是共享聊天室或内建任务引擎。保留一个 orchestrator 前台、成员显式派单、子 Thread、显式 broadcast；Cafe 不管理 DAG、git/worktree 或合并策略。
- **本轮修复**：`cafe thread show` 的 `order.declined { skipped: true }` 现在按原因分别显示：deadline 为 “did not respond before the deadline”；grace skip 为 “was skipped: another Barista answered first”。普通 decline 文案不变。`tests/cli.test.ts` 两例先 RED 后 GREEN；CLI 测试文件 39/39。独立 TypeScript review 无剩余 finding。
- **新增 team 设计/计划**：`docs/specs/v4-14-team-dogfood.md` 经独立 builder check（nothing important left）；执行计划为 `docs/superpowers/plans/2026-11-26-team-dogfood-and-release.md`。新增 Root + child 集成测试：child roster 更新同步到 Root、在线成员收到恰好一条 `team/roster`、更新不创建 Thread、Root 的远程 Customer 将 `to: <team>` 送到 child orchestrator；相同内容重发保持 revision 和通知数不变。team/session + roster 测试 15/15；observer digest handover 5/5（覆盖 Root 静默期、child 接管和旧活动不重放）。
- **Scratch dogfood / 浏览器**：本轮在隔离 `CAFE_HOME`（端口 47917）用确定性 Baristas 走了 team front door、developer assignment/sub-Thread、`broadcast + collect: all`；Web Feed 显示团队 channel、父 Thread 显示子任务链接、目标状态将无回复的 tester 标为“截止沉默”。fake agents 退出后的历史详情把离线 tester 显示为短 ID，而非名字；这是当前可见性限制。scratch daemon 已停止，未触碰 `~/.cafe`。
- **验证**：`npm run typecheck` 通过；`npm test` **127 文件 / 693 测试全过**；`routing:eval` 67/67；Web check/build 56 modules / 380.00 kB；release smoke 17/17（包版本 0.2.0）；Claude plugin 5/5。Plugin validator 报两条 `setTimeout` 类型环境警告和缺 icon 警告，但 validation passed。
- **独立整枝 review**：reviewer 指出的两项重要测试缺口已补齐：identical roster 重发的 revision/通知 no-op；Root 在线期间 child 不发 digest、安静期不重复、接管后不重放旧 Thread。Deferred minor：还缺 old-daemon CLI `cafe ask --to <known team>` 专项拒绝用例，以及两个以上本机 team members 各收一条 roster note 的 cardinality 用例。
- **0.2.0 与本机 Root**：根 package / lockfile 已升至 0.2.0，打包产物确认含 `team-sessions`。`npm view @blrbiran/cafe version` 仍为 0.1.5，**没有 npm publish**。本机 `cafe` 已是指向本仓库 `packages/cli` 的 workspace link；更新后 `cafe --version` 为 0.2.0。按授权执行 `cafe daemon restart`；Root pid 4087、版本 0.2.0；`cafe doctor` 全项通过，6 项 features 已公告，TLS links 正常。
- **真实多机边界**：完成的是同机 Root/child Daemon 网络模拟和 browser dogfood；当前网络列表只有本机 Root，没有可用的第二物理 Host，因此 ssh1/多物理机团队场景仍待后续实测。没有进行付费模型调用。
- **外部 issue ledger**：`/Users/biran/code/skills/orca/cafe_dogfooding/issue-20261119.md` 在仓库外，本轮未改动；其中 #107–#114 的状态可能落后于当前代码。下一位若要同步台账，使用 `issuemd` 核对当前实现后再关闭，不要直接照抄旧判据。
- **仍待处理**：operator 执行 npm 发布（建议从已验证的 `release/` 执行 `npm publish ./release`）；真实第二 Host team dogfood；#71 自然语言职责匹配仍非确定性保证，显式 `to: <duty>` 可用；检查已登录用户是否希望把 offline target 短 ID 改善为稳定名称。

---

### 2026-11-26 (later) — v4-13 团队会话：一个前台 + playbook + 名册生命周期；#107/#111/#112/#114（已推送 main，未发版）

> 下方历史记录描述的是 v4-13 刚合入 main 时的状态；后续 dogfood、0.2.0 本机候选和未完成的外部操作见本节上方的 follow-up。

- **一句话**：按用户逐条拍板把 team 从 v4-11 的“频道里一堆 agent”改成 **一个 orchestrator 前台**：`to: <team>` 和 team channel 的默认收件人都只到 orchestrator，全员必须显式 `broadcast`；成员注册时收到 playbook，名册变化推一条 `team/roster` 注记；同时修掉 #107/#108/#109/#110/#111/#112/#113/#114。设计经独立 subagent 审阅（5 个 must-fix 全部折进 spec）。**未发版**（建议 **0.2.0**，因为 team 路由语义是破坏性变更）。
- **Spec/plan**：`docs/specs/v4-13-team-sessions.md`（rev 2，含审阅修正）、`docs/superpowers/plans/2026-11-26-team-sessions.md`。v4-11 的 team 路由章节被取代；roster/channel/escalate/collect 原语保留。
- **团队语义（用户 2026-11-26 拍板，勿悄悄推翻）**：
  - `.cafe` 必须有且只有一个 `duty: orchestrator`；0/多个硬失败。没有老 roster 需要兼容，**不保留 legacy 组播回退**。
  - `to: <team>` = 只发给 orchestrator；fresh team-channel 消息无 `to:` 也发给 orchestrator；`broadcast: true` 才是全员；`to: <member>` / `to: <duty>` 是显式派单（同名 agent 优先于 duty；多人 duty → `ambiguous_duty` 列名字）。
  - 追问只发给上一轮最终回复者 → 上一轮 `targetStates` 的 targets → `responders_offline`；**绝不回落 rules/LLM**。显式 `to:`/`broadcast` 覆盖。
  - 注册结果带 `teamContext`（playbook + roster + revision）；`team/roster` 是 daemon→agent 通知，不创建 Order、不触发 turn；`cafe team context` 可打印同一份。
  - 名册：`publishRoster` 发完整 `.cafe` 名册并设 `authoritative`；`teams()` 不从 registry 给 authoritative 名册补人；`contentHash` 让相同内容重发是 no-op；`removed: true` tombstone 持久化，延迟 upsert 不会复活；`cafe team sync` 只发布不启动；`cafe team remove` 有在线成员时 409。
  - 混合版本**硬拒绝**五项：`escalate` / 非 default `channel` / `to: <team>` / team 身份 / `collect: all`；`duty` 只警告。新增 `team-sessions` feature flag（`teams` 不够）。
- **#109**：Root 在线时由 Root 给所有 observer 发完整摘要；child 只在 Root 离线时发 `partial`；`digestId` 改 `host:seq`；客户端按 id 和 `(publisher,channel,since)` 去重；child 接管时游标设为 now，避免回放。
- **#108**：roster key 改 `(host, team, channel)`；同主机同名 team 不再合并；发送方按自己的 `teamChannel` 选，否则 `ambiguous_team`。**#113**：`team/remove` 实现、tombstone、channel 冲突 warning + `/api/channels.conflict`。
- **#107**：Codex TUI `candidates()` 按 id 去重（保留最新行）。**#114**：store 读取路径统一补 `channel: "default"`（`getThread`/`listThreads`/`listThreadsIn`/`listThreadsInByActivity`/`openThreads`）。**#111**：`cafe thread show` 打 `targets:` 行，Web 显示最近一轮 targetStates。**#112**：`/api/threads?parent=` + Web 父/子链接，`threads.parent_thread_id` 列 + 索引。
- **验证**：`vitest run` **127 文件 / 690 测试全过**（两轮全量：第一轮 686/686 后补了 4 个新测试；最后一轮 690/690）；`build:web` 56 modules / 380.00 kB；`routing:eval` **67/67**；`test:release` **17/17**；`test:claude-plugin` **5/5**。`tsc` 在主体实现完成时通过；**最后一次 tsc 被 sandbox classifier 拒绝**（理由与本轮改动无关），之后只改了 daemon 的 `team/roster` 转发、follow-up 的 `broadcast` 条件、测试与文档，全量 vitest（会编译所有文件）仍全绿。
- **行为变化（请审核）**：① `to: <team>` 不再组播，只到 orchestrator；② team channel 新消息默认到 orchestrator；③ 追问不再回落 router；④ 混合版本对五项硬拒绝（不再只是警告）；⑤ `.cafe` 团队必须有且只有一个 orchestrator；⑥ `team start`/`team sync` 发布完整名册且相同内容不 bump revision；⑦ 名册变化会给在线成员一条 `team/roster` 注记；⑧ `team remove` 是 tombstone；⑨ #109 摘要发布者从“注册所在 daemon”改为“Root 在线时 Root 全量”；⑩ `cafe thread show`/Web 新增 targetStates 与子 Thread 链接。
- **诚实边界**：
  - Claude session-host 没有静默系统注记，`teamContext`/roster 注记会拼在**下一个 Order** 的前面；从名册变化到下一个 Order 之间它的视图是旧的，playbook 要求大任务前 `cafe team status`。
  - Web 的 targetStates/子 Thread/Teams orchestrator 徽章只过了 `build:web`，**没有在真机浏览器 dogfood**。
  - `team/roster` 的跨 daemon 转发（Root→child、child→uplink）已实现但只有同机测试覆盖；多机 team 需要真机验证。
  - Root 在线时 Root 给远端 observer 发摘要依赖 observer 在 Root registry 里的记录；child 刚注册、registry 还没复制到的窗口内可能晚一个周期。
  - `digestId` 从 number 变 string；`ChannelDigest` 接受两者，老客户端忽略 id 不受影响，但第三方脚本若把 id 当 number 会需要适配。
  - 台账 `issue-20261119.md` 在仓库外，sandbox 拒绝了我执行 `issuemd close`；**状态未改**。下一轮可跑：
    `issuemd close <file> 107 --criteria "…"` …（#107/#108/#109/#110/#111/#112/#113/#114；#71 保持“部分解决”，判据 1 现在可由 `to: <duty>`/orchestrator 完成，但 rules-router 的自然语言职责匹配仍未做，属 #39）。
- **仍需你本人**：审核上面的行为变化；`cafe daemon restart` 后 `cafe doctor` 看 `team-sessions`；用真实 `.cafe`（一个 orchestrator + dev/tester）跑一次 `cafe team start`、`cafe team sync`、`cafe ask --to <team>`；发版 **0.2.0**；Discord 实测；ssh1 复核 #91；证书安装（你说先不做）。
- **下一步候选**：#39 路由精度（含 duty 语义）、#27 全网升级、#18 只读 token、#33/#34 规模、#73 orca 反向 connector、#106 代理；真机多机 team（#108/#109 的跨机路径）。

### 2026-11-26 — v4-11 实现自审修复 + v4-12 混合版本能力声明（已推送 main，未发版）

- **一句话**：独立 subagent 对已推送的 v4-11 实现做了代码审阅（20 条：4 P1 / 12 P2 / 4 P3），
  确认并修复了全部 P1/P2；随后按 `docs/specs/v4-12-capabilities.md`（经独立 subagent 两轮审阅后修订）
  实现了混合版本能力声明；验证全绿并推送 origin main；**未发版**（建议 0.1.6）。
- **v4-11 安全/授权（批 1）**：
  - `bindAgentMethods` 移到 `initialize` 成功之后：修复了任意网络 socket 在握手前就能
    `agent/register` / `order/create` 的鉴权绕过。
  - `/api/baristas` 的 `team` 分支只接受成员名，channel/agent/bin 一律从磁盘 `.cafe` 读取
    （修复 #65 的嵌套绕过）。
  - `escalate` 改用**该 Order 自己的** `tracking.targets` 证明投递，不再用跨轮累积的
    `ThreadMeta.targets`。
  - 合成 roster 保留 `observer`；裸名字跨主机同名时优先发送方主机，否则 `ambiguous_address`。
- **名册/托管（批 2）**：supervisor `save()` 持久化“实际在管的成员集合”（部分 start 不再缩小、
  stop 一人不再复活）；启动前校验成员目录，spawn error 走正常退避；presence 只看本机且失败 worker
  视为缺失；native session 以 team/member 为键（同 cwd 的两个成员不再互相 resume）；权威 `.cafe`
  替换成员集合、revision 严格递增、equal 忽略、forget host 清 teams；子机重连后重发本地 roster；
  `team start` 对 Claude 不再提示 pi 才有的 `/cafe-team`。
- **摘要/查询（批 3）**：只有 observer 注册所在的 daemon 发布摘要；游标按 channel 持久化
  （重启不再回放）；channel 历史/摘要按 `last_activity` 查询（新增列 + 索引），旧 Thread 的新回复
  不再落在“最新 500 条创建时间”之外；CafeClient 按 digestId 去重并在重连时清空；Claude 的 digest
  改为队列；恢复的订单重新按同一策略上 deadline。
- **诚实失败/Web（批 4）**：pi/MCP/CLI 对 `parent_offline`/`unknown_team`/空 channel 立即报错
  （CLI exit 1），空池给 `no_channel_members` 或 `no_online_barista`；Web/MCP 把
  `order.declined {skipped}` 显示为截止沉默；子机 team 视图始终 `partial`，`hostOnline` 用 registry；
  切 channel 不再卸载 Feed（保留草稿）；`loadOlder` 用 channel generation，不再被同 channel 重连卡住。
- **v4-12 混合版本（批 5，`docs/specs/v4-12-capabilities.md` + plan）**：
  - daemon 在 `initialize`、`/api/health`、`/api/snapshot`、`/api/daemons` 声明
    `features: ["teams","channels","escalate","collect","digests"]`；子机记录 `rootFeatures`。
  - **absence = 未确认，不是“不支持”**（v4-11 的 0.1.5 构建不声明）：客户端再用
    `agent/register` echo 证明身份字段、`cafe team` 用 `GET /api/teams` 探测。
  - 语义降级 warn-and-continue（owner 2026-11-26 决定）：channel/escalate/collect/team 身份；
    文本含 host、版本、观察到的去向与“先重启再升级”提示。CLI stderr + `--json` warnings、MCP/pi
    工具结果、pi 启动 notify。
  - observer：确认不支持时**发送前拒绝**；未声明时注册后比对 echo，被剥离则立即断开并拒绝。
  - **注册表发布按 peer 过滤**：旧 daemon 不会收到 observer 或只在非 default channel 的 agent，
    因此它的 `eligible()` 选不到它们（修复审阅的 P1）。
  - `cafe team *` 与 `barista start --member` 在**任何写操作前**探测 teams（旧 0.1.5 会把
    `DELETE ?team=1` 当普通 `stop(dir)`）。
  - 子机的 Root 不支持 channels 时，channel 订单本地路由；roster 无法上送时
    `rosterShared: false` 并只记一次日志。
  - Web：snapshot 无 features 且 `/api/channels` 探测失败时进入 legacy 视图（强制 default、隐藏
    chips、banner）；Teams 端点缺失显示“unavailable”而不是空名册。
- **验证**：`npm run typecheck`；`npm test` **两遍 675/675（126 文件）**；`routing:eval` 67/67；
  `build:web` 56 modules / 376.25 kB；`test:release` 17/17；`test:claude-plugin` 5/5；本机 Root 已
  重启，`/api/health.features` 与 `/api/snapshot.features` 均为五项，`cafe doctor` 全绿
  （含新增的 `features` 检查）。
- **行为变化（请审核）**：① 握手前不再有任何 agent RPC；② `team start/stop` 在旧 daemon 上直接
  失败且不发写请求；③ supervisor 重启只恢复实际在管的成员；④ 摘要有唯一发布者且游标持久化；
  ⑤ channel 历史/摘要按活动时间排序；⑥ 立即路由失败时 `cafe ask` 非零退出；⑦ 切 channel 保留
  草稿；⑧ 混合版本会给警告（observer 会被拒）；⑨ 旧 peer 收不到 observer/非 default channel 的记录；
  ⑩ 子机 team 视图始终 `partial` 且带 `rosterShared`。
- **诚实边界**：Claude session-host 目前只把混合版本警告写日志（hook 没有 warning 消息类型）；
  旧 daemon 的模拟来自测试里的 protocol-1 假 daemon，没有打包 0.1.5 tarball 的端到端对比；注册表
  过滤只影响升级后新连上的 peer，升级前已缓存的记录仍可能留在旧 peer 上；Web legacy 视图只在
  自定义新 bundle + 旧 API 时出现（daemon 通常服务自己的 bundle）。
- **仍需你本人**：审核上面的行为变化；发版（建议 0.1.6）；真机 team dogfooding；Discord 实测；
  ssh1 复核 #91；证书安装（你说先不做）。
- **下一步候选**：Claude hook 的 warning/refusal 消息；Web 子 Thread 导航（escalate 的父/子链接）；
  pi/Claude 的 `/cafe-team` 运行时重新注册；#34 snapshot 分页 / #33 虚拟列表；#18 只读 token；
  #27 升级通知；#73 orca 反向 connector。

### 2026-11-25 — v4-11 team/channel 全量落地（批次 A–E，已推送 main）

- **一句话**：team/channel 从设计到实现全部完成（#71/#72）：显式 escalate 子 thread、channel 路由、`collect: all`、`.cafe` 名册、`cafe team`、observer digest、Web Teams 页；验证全绿并推送 origin main；**未发版**（建议 0.1.6）。
- **设计**：`docs/specs/v4-11-agent-teams.md`（rev 2；经独立 subagent 两轮对抗审阅后改定）；实现计划 `docs/superpowers/plans/2026-11-25-agent-teams.md`。v4-5 已标 superseded。
- **关键决定（与 v4-5 不同，勿悄悄推翻）**：
  - 子单 = **新子 thread**（`parentThreadId` 关联），不是同一 thread 的并行 order；`ThreadMeta` 保持单 order 聚合。
  - `escalate` 是显式字段；单独的 `parentOrderId` 仍是旧的 provenance，不被重新解释。
  - channel 参与路由过滤；显式 `to:` 可跨 channel；已注册 agent 的新单默认 home channel（`channels[0]`）。
  - `collect: all` 无 grace；deadline 的沉默 target 记 `skipped`（不算 decline），`ThreadMeta.targetStates` 可查。
  - 一个 `.cafe` 一个 team；roster 经 `team/upsert` 汇总到 Root，持久化 `teams.json`；supervisor 每个 headless member 一个 worker、各自 cwd。
  - observer 永不被路由；每 interval 一条 digest（Root 全网络、子机 `partial`）；digest 唤醒一个 turn（不是每条消息）。
  - Web：Teams 页 + roster drawer；channel 是 Feed 的全局维度，URL 带 channel，store 按 channel 重置。
- **实现批次（均已在 main）**：
  - **A** 协议/daemon：`escalate`、sub-thread、`unknown_parent`/`not_a_target`/`parent_offline`、显式地址绕过 chain。
  - **B** channel/duty/collect：AgentIdentity/Order/ThreadMeta `channel`、duty 路由信号、`collect: all`、`targetStates`、`threads.channel` 列、`?channel=` 过滤、CLI/MCP 参数。
  - **C** 名册/托管：`TeamSpec`/`CafeDocument`、`loadAgentIdentity`/`teamDir`、supervisor `startTeam`/`stopTeam`（每 member cwd、日志含 roster hash）、`/api/teams`、`team/upsert`、`to: <team>`、`cafe team start/status/stop`、`/cafe-team`。
  - **D** observer：`channel/digest`、`onDigest`、`/api/channels`、channel history `after` 游标、`cafe channel`、pi/Claude digest 处理。
  - **E** Web：Teams 页/drawer、channel chips、composer 目的、per-channel store、channel 路由。
- **验证**：`npm run typecheck`；`npm test` **两遍 641/641（120 文件）**；`routing:eval` **67/67**；`build:web` 56 modules；`test:release` 17/17；`test:claude-plugin` 5/5；本机 Root 已重启（0.1.5），`/api/teams`、`/api/channels`、Web `/` 均 200。
- **行为变化（请审核）**：
  1. 只有 `escalate: true` 才回上级；旧的 `parentOrderId` 行为不变。
  2. 子单创建新 thread，不再加入父 thread；父 thread 的 replies/history/turn 不受影响。
  3. channel 过滤路由；显式地址可跨 channel；team member 新单落 home channel。
  4. `collect: all` 的 deadline 沉默记 `skipped`；`ThreadMeta.targetStates` 新增。
  5. `.cafe` 新增 `team:` 块；成员进程用 `--team-dir`/`CAFE_TEAM_DIR`；同一 `.cafe` 一个 team。
  6. supervisor 日志名含 member + roster hash；`team stop` 只停托管成员。
  7. Web 默认 Feed 只显示当前 channel（默认 `default`）；旧客户端/旧 URL 不带 channel 仍看全部。
- **诚实边界**：
  - 混合版本没有 capability 拒绝：旧 daemon 会 strip `channel`/`escalate`，按旧语义处理；升级两端再用 team。
  - 子机的 `/api/teams` 指标是本地视角；Root 在线时 Web 通常跑在 Root。observer 请放 Root 或 team 所在机。
  - Codex bridge 没有 cafe 工具面，不能 escalate；pi/Claude/CLI/MCP 可以。
  - TUI `/cafe-team` 只记录选择，**重启会话**才真正换身份（TUI context 无法隔离）。
  - 子机在 Root 离线期间新建的 team，重连后不会自动重发；等成员重新注册或重启 daemon。
  - `routing:eval` 的 3 条 blocked team case 已移除（escalate/collect all 由 daemon 测试覆盖），不是“悄悄跳过”。
- **仍需你本人**：审核上面的行为变化；真机跑一次 team（`cafe team start` + TUI 成员）；发版（建议 0.1.6）；Discord 实测；ssh1 复核 #91；真机证书安装（你说先不做）。
- **下一步候选**：#39 路由精度、#34 snapshot 分页、#33 虚拟列表、#18 只读 token、#27 升级通知、team dogfooding 反馈。

### 2026-11-25 — 台账第十三轮补充复核之后：三批（#98 #103 #105 / #99 #104 / #100 #101 #102）

- **一句话**：测试者第十三轮（含补充复核）新开的 #103/#104/#105 与仍开着的 #98/#99/#100/#101/#102 全部处理完，分三批提交并推送 origin main；**未发版**（建议 0.1.5）；§4 新增 5 条不可悄悄推翻的约定，§8 新增 4 条陷阱。
- **批 1｜地址与诊断（#98 #103 #105）**：
  - `resolveDaemonUrl()` 保留原始错误为 `cause`，`describeFetchError()` 在没有 code 时读 `cause.message`（`bad port` 不再变成 `fetch failed`）。TLS 网络 + 裸 `host:port` 这条**唯一**能由人手输入的路径现在返回 `ECONNREFUSED` 之类的 code。
  - `discoverTls()` 在明文端口拒绝时，会再试同一主机的默认 TLS 端口（4778）——只发布 4778 的容器能被发现；两个端口都失败时错误里同时含两个端口号。**loopback 不做这个回退**（127.0.0.1 上的端口名指某个具体实例，4778 可能是另一个 daemon；测试里也避免了误连本机真 Root）。
  - `setHostAddress()` 改成**先探测再落盘**：探测失败不写 `config.yml`、不改在线机器的显示地址，返回 `verified:false` + code。不在线的主机仍可预先保存（这是修 Docker 地址的用法），但未验证的 pin 不会再盖住一个能用的地址（`daemons()` 只在已验证或主机离线时采用 pin）。
  - `webStale` 改为比较 `index.html` 的**内容哈希**：同样的字节重新构建（新 mtime）不再提示重启。
  - Web 的 `ECONNREFUSED` 文案补了“也可能只发布了加密端口（4778）”。
- **批 2｜链路存活与 Root 换址（#99 #104）**：spec `docs/specs/v4-10-link-liveness.md`，实现前由独立 subagent 审阅，审阅的 16 条意见全部处理（连接中的 socket 不 ping、Root 身份校验、不改写 `config.root`、轮换顺序、定时器清理、loopback 候选过滤、mDNS 退避上限、CLI 输出等）。
  - **#99**：Daemon↔Daemon 链路（child 上行、Root 侧的 child 链路、直连 peer）加 ws ping/pong，默认 30 s、连续 2 次无 pong 则 `terminate()`，走既有 close 路径（child 记 `root connection lost` 并重连；Root 走 `onPeerClosed()`）。**只在 socket OPEN 后开始 ping**（CONNECTING 上 ping 会抛，黑洞 SYN/慢 TLS 发现不能被误杀）；agent/UI socket 不 ping；watcher 在 close 与 `Daemon.stop()` 时清理。
  - **#104**：Root 在 child 注册时和每次 `emitDaemons()` 发 `root/moved {addresses}`（去掉无可路由地址时的 127.0.0.1 回退）。child 把地址存入 kv `rootAddresses`（≤8），重连候选依次为 `config.root` → 上次成功地址（kv `lastRoot`）→ 学到的地址；每次失败/掉线才前进一格。**不改写 `config.root`**（可能是人手设的 ssh 隧道）；候选成功只记 `lastRoot`。**身份校验**：非 `config.root` 的候选若 `initialize` 回来的 host 与已知 Root 不同，拒绝（`answers as root 'x', but the Root was 'y'`）；只有人手设的地址能改变归属。mDNS 在全部候选失败后重试，30 s 起翻倍到 5 min、最多 6 次。
  - `/api/health`（child）新增 `root` / `rootOnline` / `rootConnected` / `rootLastSeenAt`；`cafe status` 与 `cafe daemon status` 显示 `(online via <addr>)` 或 `(offline, last heard Ns ago)`。
  - **诚实边界**：mDNS 再发现、TLS 跨叶子续期的换址没有自动化测试；换到从未见过且不在同一 LAN 的地址仍需人工（日志给 `cafe root set` 提示）。TLS 网络换址有分钟级窗口（每个候选先 `discoverTls`、Root 叶子最多 5 分钟才写到新地址、新 `host:port` 要重新 TOFU pin）。
- **批 3｜三个小修（#100 #101 #102）**：
  - **#100** `barista run/start --agent codex --tui` 不再“挑目录里最新的会话”（那往往是你正在打字的那个）：目录里只有一个会话就直接用并打印 id + dir + 换法；多个会话则**拒绝并列出候选**，要求 `--thread <id>`；多选时跳过“正在跑 turn”的会话（另一进程看到的是 `interrupted` 且无 `completedAt`）。`--tui` 的帮助文案明确“接入已存在的会话，本命令不开界面”。README/README_zh 同步。
  - **#101** `order.declined` 新增可选 `skipped: true`：grace 窗口跳过仍发事件（可审计），但不再计入 outcome 与 `meta.declines`，晚到的回复不会让同一个 agent 同时出现在 replies/declines，`cafe stats` 不再把“没赶上”算成“婉拒”。
  - **#102** worker 日志名改为 `barista-<叶子名>-<sha256(dir) 前 8 位>-<slot>.log`，两个同名叶子目录不再交错写一份日志。
- **验证**：`npm run typecheck`；`npm test` **两遍各 606/606 全绿**；`routing:eval` 67/67；`build:web` 55 modules；`test:release` 17/17；`test:claude-plugin` 5/5。本机 Root 已用 `cafe daemon stop/start` 重启，`cafe daemon status` 与 `cafe status` 都正常。
- **flake（非本次改动）**：机器高负载时（本机同时 20+ 个 Claude 会话）并行全量跑曾见 `tests/connector.test.ts` 的 install（20 s 超时）与 `tests/cli.test.ts > prints the port-in-use reason…`（5 s 计时）超时；单独跑 45/45 通过，未改动的树上也会复现。
- **行为变化（请审核）**：① 失败的地址不再落盘（离线主机除外）；② `barista --tui` 多会话时必须 `--thread`；③ grace 跳过不再计入 declined；④ 日志文件名变化（旧的 `barista-work-1.log` 不再更新）；⑤ `root:` 不被自动改写，换址走 `lastRoot`。
- **仍需你本人**：发版（0.1.5，含 #91–#105 相关批次）；Discord 实测；Root 换新代码后在 ssh1 上复核 #91；真机证书安装（你说先不做）。
- **下一步候选（先 brainstorm/spec 再拍板）**：#34 snapshot 分页、#33 虚拟列表/脉冲动画剩余开销、#39 路由精度、#18 只读 token、#27 Root 推送升级通知、#71–#73 team/channel、v4-10 的 mDNS/TLS 换址自动化。

- **给测试者的复核清单**（纯文本，可直接转发）：

```
cafe 台账复核建议（2026-11-25 第十三轮补充复核之后）

1. #98/#103：TLS 网络下对裸 host:port 的不可达地址 POST /api/hosts/test → 响应含 code（ECONNREFUSED 等），
   不再是 "fetch failed"；只发布 4778 的容器可被发现（loopback 地址不做 4778 回退）。
2. #103：对**在线** Host 保存一个不可达地址 → verified:false + code，/api/daemons 仍是原可用地址，
   config.yml 的 pinnedDaemons 不含它；离线 Host 仍允许预存（但不会被广播）。
3. #105：不改源码重跑 npm run build:web（字节相同）→ /api/snapshot 不再带 webStale。
4. #99：把 child 与 Root 之间的 TCP 代理断开一半（半开）→ 90 s 内 child 日志出现 root connection lost 并重连；
   agent/UI 连接不受心跳影响；/api/health 的 eventsSinceStart 不因心跳增长。
5. #104：改 Root 的地址/端口后，child 通过 root/moved 学到的候选重连；cafe daemon status 显示
   root: <configured> (online via <connected>)；学到但答成另一个 Root 的地址会被拒绝；mDNS 只在前述都失败后重试。
6. #100：同一目录两个 Codex 会话 → barista run --agent codex --tui 拒绝并列出 id，要求 --thread；
   只有一个会话时 ready 文案给出 threadId 和目录；有 turn 在跑的会话会被跳过。
7. #101：broadcast 里慢 worker 在 grace 后交活 → meta.declines 不含它，cafe stats 的 declined 不增长；
   事件里仍有 skipped:true 的 order.declined 可审计。
8. #102：两个不同路径的同名叶子目录 → supervisor 日志路径不同（barista-<name>-<hash8>-<slot>.log）；
   旧的 barista-<name>-<slot>.log 不再更新。
9. #61 判据 5：仍建议把 "<10%" 改成绝对值（perf:tls 同时打印两者）。
```

### 2026-11-25 — 台账第十一轮：#97 Web token 走请求头、v4-9 加密访问 Web、`perf:tls`、测试地址

- **一句话**：测试者第十一轮新开 #97（P1）和一条测试缺陷；用户裁定 Q126–Q128 全按推荐（token 存 localStorage +
  设置里可忘记；401 时页面要 token、支持 `#token=` 链接；范围 = #97 + 测试地址 + `perf:tls`，之后做局域网 https），
  并在离开前授权「按建议做完、推送 origin main、最后报审」。三批均已提交并推送；**未发版**（建议 0.1.5）。
- **#97**（`packages/web/src/auth.ts`）：token 只从 `#token=` / `?token=` 链接或输入页读一次 → 存 localStorage
  （`cafe.token`）→ `history.replaceState` 清地址栏 → 只发 `Authorization: Bearer`（fetch、上传 XHR；附件下载在有 token
  时改为带头 fetch → blob）。401 或 WS initialize `unauthorized` → `TokenGate` 输入页（错 token 有提示）；设置里
  「在此浏览器忘记 token」。服务端口径未变（`?token=` 仍 401）。局域网地址 + 临时 daemon 浏览器实测通过。
- **测试地址**：`tests/tls-multi-address.test.ts`、`join-hint.test.ts` 把测试者机器的真实 VPN 地址 `30.251.51.85`
  换成 TEST-NET-1 `192.0.2.85`（之前在测试者机器上必挂一条）。
- **`npm run perf:tls`**（`scripts/perf-tls.ts`，报告不当门槛）：同一临时 TLS Root 的明文口与 TLS 口，交替 3 轮取中位数。
  新建连接 TLS **+2~6 ms p95**（判据 <10 ms，每次达标）；常驻往返两边 p95 都是 0.05–0.1 ms，差值 **±0.04 ms 以内**，
  但「<10%」在这个量级上 −14%～+55% 来回跳——建议测试者把 #61 判据 5 改成绝对值（如 <0.1 ms）。
- **v4-9 加密访问 Web**（`docs/specs/v4-9-lan-https.md`，独立 subagent 审阅 11 条全部采纳，见 §7）：发现 **TLS 口本来就
  提供同一套 Web**，缺的是信任与提示。新增：`GET /ca.crt`（两个口，只在已入网时）；`/api/tls.web`（公开）与
  `/api/settings.web.https` = 叶子证书里确有的 `https://地址:TLS口/`（不含 loopback）；Web 在「经网络的明文页」显示
  横幅 / 输入页警告，链接用 `#token=` 把 token 带过去；设置「加密访问」：本页是否加密、地址、证书下载、指纹（**要求在终端
  用 `cafe root show` 对照**）、各平台信任步骤、信任 CA 的含义；`cafe daemon status` 多一行 `web:`；Host 白名单缓存
  未命中时重建（≤1 次/秒，VPN/DHCP 新地址之前要重启才能写）。没有单独写 plan 文档：规模小，spec §4 + §7 即实现清单。
- **改了一处旧测试**：`web-auth.test.ts` 的守卫从「源码不得出现 `token=${`」收窄为「`#` 之后的除外」——片段不会发给
  服务器，v4-9 有意用它；查询参数里的 token 仍被禁止。
- **验证**：每批 typecheck、web check、`build:web`；最终 **588 tests ×2**；`routing:eval` 67/67；`test:release` 17/17；
  `test:claude-plugin` 5/5。本机 Root 已重启：`web:` 行给出 `https://192.168.3.129:4778/`，`/ca.crt` 200，doctor 全绿。
  截图（scratchpad，不入库）：token 输入页 1440/390、横幅、设置「加密访问」。
- **请你审核**：① 加密访问的文案与位置（设置抽屉最上面一节、横幅可「知道了」关闭）；② 真机上的证书安装：iOS 下载
  `content-disposition: attachment` 是否弹出描述文件、Android 的安装路径（模拟器/真机都没测）；③ Firefox 步骤。
- **仍需你本人**：发版（0.1.5 带上 #91–#97、#31/#33/#84、v4-8、v4-9）；Discord 实测；Root 换新代码后 ssh1 复核 #91；
  上面三项审核。
- **台账对照**：#95/#96 已在上一轮修（测试者只复核到 `c3f3955`）；#34 里「registry 全删全插」「announceRoot 串行」早已
  修（差量写、8 路并发 1.5 s），只剩 snapshot 固定 200 与 prune 内存（等规模）；#33 剩判据 5/6（虚拟列表，建议收窄）；
  #61 剩判据 5 的口径（上面）。
- **下一步候选（都要先 brainstorm/spec，并要你拍板）**：#18 只读 token（你之前推迟）；#27 `update/announce` 协议
  （涉及「升级只走 CLI」的既有裁定）；#71–#73；#34 snapshot 分页（等规模）；v4-9 之后可选「非 loopback 的 4777 自动
  跳到 4778」（spec §3 B，等大家都会装证书再说）。

- **给测试者的复核清单**（纯文本，可直接转发）：

```
cafe 台账复核建议（2026-11-25 第十一轮之后）

1. #97：从局域网地址打开 http://<ip>:4777/ → 出现「需要 token」页；粘贴 token 后各页 200；DevTools 里没有 URL 含 token
   （除你自己输入的旧式 ?token= 导航本身）；地址栏被清掉；curl "…/api/snapshot?token=…" 仍 401；附件下载带 Authorization。
   tests/web-auth.test.ts。
2. 测试地址：tests/tls-multi-address.test.ts 改用 192.0.2.85，你机器上那条失败应消失。
3. #61 判据 5：npm run perf:tls。新建连接 +2~6 ms p95；常驻往返差值 ±0.04 ms，但百分比在回环量级上不稳定，建议改成绝对值判据。
4. v4-9（#61 判据「局域网 Web 明文」）：https://<ip>:4778/ 就是同一套 Web；http://<ip>:4777/ca.crt 下载 CA（未入网的机器 404）；
   /api/tls.web 只列叶子里有的地址、无 127.0.0.1；明文页横幅的「打开加密地址」带 #token=，跳过去不再要 token；
   新的 VPN 地址不重启也能写（Host 白名单缓存未命中会重建）。tests/lan-https.test.ts、web-security.test.ts、web-line.test.ts。
5. #95 / #96：上一轮已修（复核清单见下一条 2026-11-25 记录）。
6. #34：registry 已按差量写、announceRoot 已 8 路并发；剩 snapshot 固定 200 与 prune 内存。
```

### 2026-11-25 — 台账第十轮：#95 多地址入网、#31 SSE 游标、#33、#84、#16 关闭；v4-8「移除离线机器」

- **一句话**：按 `../cafe_dogfooding/issue-20261119.md` 第十轮复核，用户裁定 Q121–Q125 全按推荐：批 A（#95 #31 #33 #84）+
  批 B「移除离线机器」（Q125 A，spec → 独立 subagent 审阅 → 修订 → 实现）+ #16 用真 Codex 跑行为回归。两批均已提交，
  **未推送、未发版**（`git log origin/main..main` 查看；#91–#94 已在 origin 上，但还没发版）。
- **#95**：`joinAddresses()`（`daemon.ts`）——没设 `advertise` 时给出本机所有 IPv4 的 `host:port`，设了只给那一个；
  `/api/settings.join` 多了 `addresses`/`advertised`（`address` 保留给旧客户端）；`cafe root show` 用 `join-text.ts`，多地址时
  每个地址一条命令 + 「用对方能连到的那条」+ `advertise` 提示；Web「加入另一台机器」每条命令一个复制按钮（截图 1440/390 已看）。
  本机实测给出 `192.168.3.129` 与 `198.18.0.1` 两条。
- **#31**：`/api/threads/:id/stream?after=` 改为 `store.readEventsAfter(file, after, 5000)` 从游标往后读，不再切默认 200 条的页；
  找不到游标（或其后超过 5000 条）先发命名事件 `event: gap`，再重放最近一页。目前没有客户端传 `after`（CLI/connector 的
  解析器只取 `data:`，将来传 `after` 的客户端要跳过带 `event:` 的块，已写进 v4-3 spec）。`putThread` 整份序列化不改（理由：
  replies/declines 各 ≤50 且 150ms 合并）。`tests/sse-after.test.ts`。
- **#33**：进行中卡片只有「已用时」那段每秒刷新（`<ElapsedText>`），卡片本身 30 s；虚拟列表仍不做（300 条上限，不是瓶颈）。
- **#84**：favicon 白底去掉 `rx`，16px 四角不透明（`rsvg-convert` 实测四角 RGB 白、无 alpha 通道）。
- **#16**：`codex exec --json --ephemeral -s read-only` 5 次（用户 provider，约 5 次小调用），提示「$cafe 问 cafe 负责人 SSE after…」：
  **5/5 首个工具调用是 `cafe agents`**；只读沙箱里连不上 daemon（EPERM）时 5/5 停下并请用户选择，没有回落去读本地代码。
  按判据（≥4/5 软约束）可关闭。注意：`zsh -lc` 会重置 PATH，所以桩没被调用、跑的是真 `cafe agents`（只读、被沙箱挡住，
  没有产生任何 Order）。脚本与输出在 session scratchpad（不入库）。
- **v4-8 移除离线机器**（`docs/specs/v4-8-forget-host.md`，含审阅后的修订记录）：Root 上 `forgetHost(name)` / `POST /api/hosts/forget`
  / `cafe host forget <host>` / Network 页离线卡片「移除」（行内二次确认，非弹窗）。按 id、显示名、别名解析，也能删只剩配置的
  主机（Root 重启后）。删 `daemonRecords`、该主机的 Registry Agent（delta 广播）、`knownDaemons`/`pinnedDaemons`/`hostNames`、
  `reportedUrls`、`refusedPlaintext`；`forgotten` 标记挡住正在进行的地址探测写回；`uplinkAlive` 之后不再 await，期间重连的子节点
  不删（409）；ping 不回的连接先关掉再删。子节点收到 `cafe/hostForgotten` 后丢掉 `peerUrls`、直连和该端点的 pin（别的 peer 或
  Root 还在用的 pin 保留）。**不是封禁**：还有 token 的机器再连会重新出现；文案写明换 token 的命令。在线 → `409 host_online`。
  审阅发现并已修：pin 实际在子节点（Root 没有）、探测竞态、若干对现有代码的错误描述。12 条新测试。
- **验证**：批 A：typecheck；545 tests ×2；`routing:eval` 67/67；web check + `build:web`；`test:release` 17/17；`test:claude-plugin` 5/5。
  批 B：typecheck；**559 tests ×2**；`routing:eval` 67/67；web check + `build:web`；`test:release` 17/17；`test:claude-plugin` 5/5。
  本机 Root 已重启，doctor 全绿（多地址 join 已生效）。
- **纠正上一轮复核清单**：ssh1 的 Test 显示「Reachable from this machine」是**对的**——那是 Root 直连 ssh1 成功；黄色提示只在
  「直连不通但 ssh1 的上行链路活着」时出现。而且那台 Root 是测试者的机器（#91–#94 尚未推送）。#91 真正要复核的是反方向：
  ssh1 经 VPN 地址 `30.251.51.85:4778` 连 Root（需要 Root 换上新代码，叶子含 VPN 地址）。
- **仍需你本人**：推送与发版（建议 0.1.5 带上 #91–#95、#31/#33/#84、v4-8）；Discord 实测（附件私信、`/new`、6h 新 thread、稳态
  重启去重、回答途中重启）；Root 换新代码后在 ssh1 上复核 #91（经 VPN 地址入网）；看一眼 v4-8 截图/文案是否满意。
- **下一步候选（先 brainstorm/spec）**：#18 只读 token；#27 Root 主动推送升级通知；#71–#73；Web「哪段加密」标注 + 局域网 https
  原型（Q120）；#34 snapshot 分页（等规模）；#61 `perf:tls` 基准。

- **给测试者的复核清单**（纯文本，可直接转发）：

```
cafe 台账复核建议（2026-11-25 第十轮之后）

1. #95：多网卡 Root 上 cafe root show 每个地址一条 cafe connect；/api/settings.join.addresses 含全部地址；
   设 advertise 后只剩一条。Web 设置抽屉「加入另一台机器」同样。tests/join-hint.test.ts、join-text.test.ts、web-join.test.ts。
2. #31：GET /api/threads/<id>/stream?after=<比默认页更旧的 eventId> 返回该游标之后的全部事件；未知游标先出
   event: gap（data {"after","reason":"unknown_cursor"}）再重放最近一页。tests/sse-after.test.ts。putThread 整份序列化维持现状。
3. #33：有进行中卡片时只有用时文本每秒更新（Feed.tsx <ElapsedText>）；虚拟列表不做，建议收窄判据 5。
4. #84：icon.svg 白底无 rx；rsvg-convert 16px 四角不透明白。
5. #16：codex exec 5 次，5/5 首个工具调用是 cafe agents，连不上 daemon 时不回落本地搜索 → 建议按软约束关闭。
6. 新功能 v4-8：Root 的 Network 页离线机器「移除」/ cafe host forget <host>；在线时 409；被拒的明文卡片不显示按钮；
   再连会重新出现。tests/forget-host.test.ts、forget-host-cli.test.ts。
7. 上一轮清单第 2 条更正：Root 上 Test 显示「Reachable」= 直连成功，是正常结果；黄色提示只在直连不通、上行活着时出现。
```

### 2026-11-25 — 测试者第九轮的 #91–#94（TLS 部署），两批均已提交

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
- LAN security: **TLS is implemented and hardened** (v4-6 #61, see §1/§5): CA + leaf, dual port, fail-closed, TOFU CA fingerprint, **per-peer leaf pin enforced on Daemon links**, **leaf renewal (start + every 5 min while running, #91)**, **exact SAN coverage**. Remaining is phase 2: mutual TLS (a client certificate per peer) and ECDSA leaves (`node-forge` 1.x has no EC keygen); the token still travels inside TLS rather than replacing it.
- `search` uses the FTS5 trigram index (`search_index`) for 3+ char queries and falls back to the JSONL scan below that; `threadsNeedingIndex()` + `backfillSearchIndex()` index Threads that predate the index. A short/symbol-only query returns [] from the index path rather than erroring.
- Web: maybe a routing-quality view (eval numbers are only in `tests/routing-eval.test.ts` and `cafe stats`).

## 8. Traps already found
- **Liveness watchers (v4-10)**: `ws.ping()` throws while the socket is CONNECTING — attach the watcher on `open`, not on creation, or a black-holed SYN / slow TLS discovery is killed after one tick. Stop on `close` and from `Daemon.stop()`. Never ping agent/UI sockets (`tests/link-liveness.test.ts` pins the CONNECTING case).
- **Root candidate rotation (v4-10)**: advance the index on a failed/dropped dial (not inside `scheduleReconnect`, or the first retry skips `config.root`), and guard the in-flight dial with `dialTarget`, not `config.root` — comparing to `config.root` cancels every rotated dial. A learned candidate's `initialize.host` must match the stored `rootHost` (`tests/root-failover.test.ts`).
- **`root/moved` payload**: `joinAddresses()` falls back to `127.0.0.1` when a machine has no routable IPv4; strip loopback from the payload when real addresses exist, or a remote child adopts an unusable candidate.
- **`discoverTls` fallback (v4-10 #98)**: the implicit 4778 retry is for non-loopback hosts only — a typed `127.0.0.1:<port>` names one instance and 4778 may be an unrelated daemon (a test child enrolled the developer's real Root before this guard). It never speaks plaintext to 4778: only TLS.
- **`webStale` compares content (v4-10 #105)**: never re-introduce mtime; a deterministic rebuild rewrites identical bytes and would nag for a restart that changes nothing.
- **Sub-Threads, not parallel Orders (v4-11)**: `ThreadMeta` resets `replies`/`turn` on every new `order.created` and ignores non-current orders, so two open Orders in one Thread corrupt replies/history/SSE follow/cancel. An escalation creates a new Thread (`parentThreadId`) and inherits the parent channel; `thread_busy` stays per Thread. `escalate: true` is explicit — the pi extension used to set `parentOrderId` on every ask, which would otherwise redirect unrelated questions.
- **Channel routing (v4-11)**: `eligible()` filters `!observer && channelsOf(r).includes(order.channel)`; explicit `to:` bypasses the filter and the chain (`tests/channel-routing.test.ts`). The `threads` table has a `channel` column with a `default` backfill; the FTS channel predicate must be applied before the limit, or a channel with matches is starved (review finding).
- **Team supervisor (v4-11)**: team workers are keyed by `rosterDir` + `member`; `w.cwd` is the member dir while `w.spec.dir` stays the roster dir (so `save()` is one spec per roster). Log names include the member and a hash of the member dir and roster, otherwise two rosters with the same member/cwd interleave. `team stop` uses `stopTeam`, never bare `stop(dir)`.
- **Digests (v4-11)**: assembled by the daemon the observer is registered on (Root = network view, child = `partial`). One per interval per channel; `digestId` lets the client drop replays. Never deliver an Order to an observer implicitly.
- **`.cafe` team validation (v4-11)**: `team.channel` is sanitized from the team/`.cafe` name (dots → dashes); `default` is reserved; duplicate members and a member whose `channels` omit the team channel are parse errors. A member process in a sibling worktree has no `.cafe` upward: pass `--team-dir`/`CAFE_TEAM_DIR` (bridge/session-host now accept a roster-backed identity).
- **Web channels (v4-11)**: channel is a route field (`#/?channel=`), a per-channel store (reset on switch), and a server filter on snapshot/threads/search. WS thread upserts for another channel must not enter the visible list; a late snapshot/older page from the previous channel is dropped by `snapshotSeq`. A channel with no Threads says so explicitly.
- **The TLS port serves the Web UI too (v4-9)**: both listeners share `handleRequest`, so `https://<addr>:4778/` is the encrypted Web. Only list addresses the current leaf names (`sanCovers`) and never offer a CA from a Host with `tlsContext.network === false` (temporary CA). A token may cross origins only in a `#token=` fragment, never a query.
- **Web token (#97)**: the daemon takes only `Authorization: Bearer` from non-loopback callers; the Web keeps the token in localStorage `cafe.token`. A plain `<a href>` cannot carry the header — downloads fetch with it when a token is set. Test against a LAN address, not 127.0.0.1 (loopback needs no token and hides the bug).
- **Test helpers**: `startDaemon` sets `advertise: 127.0.0.1` unless the config overrides it (`advertise: undefined`); Node's `fetch` silently drops a hand-set `Host` header — use `node:http` for Host tests. Made-up IPs in tests come from 192.0.2.0/24 (a real VPN address broke a tester's run).
- **Backward reads must split bytes, not strings (#90)**: a fixed-size chunk boundary can cut a UTF-8 character; decoding a chunk before joining the carried half line turns it into U+FFFD while the JSON stays valid, so counts and ids look fine. Any test of a reader must use CJK/emoji text and assert the text, not only ids.
- **TLS pins live where the link is dialled (v4-8)**: `security.tls.pins` is written by `linkOptions` (a child's uplink and direct links), so the Root holds no pins for its children; cleaning a forgotten Host's pins happens on the children, and only for keys no other peer (or the Root) maps to. Async address probes (`rememberChildUrl`) must check the `forgotten` mark before writing `knownDaemons`.
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
- **Leaf lifecycle (v4-6 §5 B).** A leaf is valid 90 days; `ensureLeaf` reissues when it is inside `LEAF_RENEW_BEFORE_MS` (21 days) **or** the SAN set changed, and a running Daemon checks every `timing.leafCheckIntervalMs` (5 min prod since #91, tunable in tests) and renews in place (write-through to disk + `setSecureContext`). A child with no CA key renews by asking the Root; if the Root is unreachable the tick retries and the not-yet-expired leaf keeps serving. Do not shorten validity or remove the renewal path — fail-closed means an expired fleet has no rescue.
- **SAN coverage is exact.** `sanCovers()` compares whole `subjectAltName` entries. A substring test let `127.0.0.1` "cover" `127.0.0.10` and `desk` cover `desk.example`, which kept a stale leaf and made the new name fail closed with `ERR_TLS_CERT_ALTNAME_INVALID`.
- **Per-peer leaf-key pin.** `security.tls.pins[host:port]` is enforced via `checkServerIdentity` on Daemon-to-Daemon `wss://` (TOFU on first contact, persisted to config); it is separate from the CA fingerprint and must never be compared to it. The CA pin authenticates the trust anchor; the pin catches an unexpected leaf issued under that CA. **The pin names the leaf's public key (SPKI), not its certificate** — a certificate fingerprint changes on every renewal and would reject a Host that merely rotated. Old certificate pins are accepted while that leaf is unchanged and upgraded in place. Clear one with `cafe host pin <host:port> --clear` (hot, `POST /api/tls/pins`).
- **A custom `checkServerIdentity` disables Node's SAN check.** Node *replaces* the default identity check when the option is supplied; it does not add to it. `trust.ts`'s `pinnedIdentityCheck` runs `tls.checkServerIdentity` first and the pin second — never pass a pin-only function here, or every `wss://` link stops checking SANs (`tests/tls-pinned-san.test.ts` pins the old bug down).
- **Renewal must keep the leaf key.** `issueLeaf(ca, sans, days, key?)` re-signs the existing key (or an SPKI a child sends in `POST /api/tls/leaf`); `ensureLeaf`, `tlsContext.renew`, and `cafe daemon renew-cert` all pass it. `POST /api/tls/renew` goes through `renew` so the leaf is written through; do not swap only the in-memory leaf.
- **Connectors survive a daemon restart.** They are detached processes; after changing `packages/connector/**` run `cafe connector restart <name>` too (Discord ran stale code for hours on 2026-11-24).
- **A second local TLS daemon collides on 4778.** An isolated test daemon on the same machine as the real Root must set `security.tls.port` (only `EADDRINUSE` is printed otherwise).
- **playwright-cli `goto` to the same URL with a new hash does not reload** the page: after a rebuild, `reload` before taking screenshots.

- **Agent RPC is bound after `initialize` (v4-12).** `accept()` used to call `bindAgentMethods` before the handshake, so any socket that could open `/ws` could `agent/register`/`order/create` without a token. Keep the bind inside the initialize handler after the token/protocol/TLS checks.
- **An absent feature list is not incapability (v4-12).** v4-11 shipped under version 0.1.5 without advertising `features`; treat absence as unconfirmed and probe (`agent/register` echo, `GET /api/teams`). Only a present list may support "does not support" copy.
- **Old peers must not learn observers or channel-only agents (v4-12).** An old `eligible()` ignores `observer` and `channels`; `registry/sync`, `registry/snapshot` and `registryDelta` are filtered per peer (`publishableTo`). Filtering at registration alone is not enough.
- **Team writes preflight `GET /api/teams` (v4-12).** A tagged 0.1.5 daemon handles `DELETE /api/baristas?team=1` as a plain `stop(dir)`; never send a team POST/DELETE before the probe succeeds.
- **Digests: one publisher, a persisted per-channel cursor (v4-12).** Every daemon sees the network registry; only the observer's registration host may publish. The cursor lives in the store kv, so a restart does not replay old activity.
- **Team session keys are `team/member`, not cwd (v4-12).** Native members often share `dir: .`; keying sessions by cwd lets them resume each other's conversation.
- **Roster membership follows the file, not the union (v4-12).** An authoritative `.cafe` replaces members (removals take effect), revisions increase strictly, and `forgetHost` drops that host's teams. The reconnect path republishes local rosters when the Root advertises `teams`.
- **Channel history/digests page by `last_activity` (v4-12).** The column is migrated and backfilled; the creation-ordered window missed replies on old Threads.
- **`Order.variants` (#39)**: delivery-only. `dispatch()` sends `body = variants[agentId] ?? body` with `variants` stripped; do not write per-variant text into `history()` or `order.created`, and do not attach variants to a unicast. The rules split is deliberately narrow (explicit two-clause punctuation only).

## 9. Working with this user

- They write in Chinese; answer in Chinese. They decide quickly when given numbered questions with a recommended answer (last used number: **Q128**). On 2026-11-24 night they approved the Web small fixes (#63/#74/#64) directly and asked that the session finish every non-blocking task, report review items at the end, and hand off; do not wait on them for anything that does not need a person. On 2026-11-20 they approved #20 Q1–Q4, #27 Q1–Q5 and #28 Q1–Q4 (Discord), accepted a brief stop for upgrades, deferred read-only tokens, and required that **large attachment contents never be put into an agent's context automatically**. On 2026-11-21 they asked for **one intuitive `/cafe` entry across Claude/pi/omp** and for the inconsistent group to be renamed: the Customer command is `/cafe` everywhere; the Claude plugin's session pause/resume moved to `/cafe-barista`.
- New feature areas: go through the decisions first; small fixes go straight ahead. When they are away, follow the recommendations, keep going on what does not need them, and list the review items at the end.
- Commit when asked (or at the end of an away batch they asked to hand off), with a stat or diff shown first; messages end with the Co-Authored-By line.
- Restart their daemon yourself after daemon / web changes (section 8). Publishing to npm and changing their Claude / Codex config stay with them.
- UI prototypes are Claude artifacts: v1 https://claude.ai/artifact/JQDywMh5YuYWsT7yaMXtSK, routing-history display https://claude.ai/artifact/JJit3GCxiQZUypYVWZFxFg (approved: Q51–Q53 as recommended), older threads + search https://claude.ai/artifact/ARjRg8XRAdsx44YSdYehvZ (approved: Q67–Q68 as recommended), versions https://claude.ai/artifact/SVLEJhirFrxq7ugMipjeiZ (Q71 A, implemented), agent kinds https://claude.ai/artifact/X3F3dx2PtBQf3R5HwsiRL5 (Q81–Q83 as recommended, implemented). Artifacts are unavailable under `ANTHROPIC_AUTH_TOKEN`; the v3-3 workbench used a local prototype instead: [`docs/prototypes/web-workbench-2026-11-19.html`](../prototypes/web-workbench-2026-11-19.html) (Q101–Q107, implemented).

**Suggested skills for the next agent** (call via Skill): TLS (#61) and per-target questions (#39) are implemented; use `superpowers:brainstorming` for #71 team/channel design and TLS phase 2, `superpowers:writing-plans` once a spec is approved, and `superpowers:systematic-debugging` plus `superpowers:test-driven-development` for the regressions listed in §5. Use `cafe` for live network diagnosis and `playwright` for browser regressions. For UI design, use `artifact-design` when the artifact tool is available. A local HTML prototype works when it is unavailable.
