# cafe

[English](README.md) | [中文](README_zh.md)

cafe is an agent network: a message (an **Order**) from any party is routed to the agent or agents best placed to answer it (**Baristas**). Terminology lives in [GLOSSARY.md](./GLOSSARY.md); key architecture decisions in [docs/adr/](./docs/adr/).

```
                ┌──────────── Root Daemon (host A) ────────────┐
                │ authoritative Registry · relays every Order  │
                │              network-wide web UI             │
                └───────▲──────────────────────────▲───────────┘
                        │ ws (token)               │ ws (token)
            ┌───────────┴──────────┐   ┌───────────┴──────────┐
            │ Daemon (host B)      │   │ Daemon (host C)      │
            │ Registry replica     │   │ Registry replica     │
            │ routing              │   │ routing              │
            └──▲──────▲───────▲────┘   └──▲──────────▲────────┘
               │      │       │           │          │
          pi (TUI)  pi (rpc)  cafe CLI   Codex /    Claude Code / Codex
          Barista   Barista   Customer   Claude     (as Customers via
                                         Barista     cafe mcp or the skill)
```

- One **Daemon** per Host, listening on a single port (default 4777) that serves the HTTP API, the `/ws` WebSocket and the web UI.
- The Daemon where an Order starts makes the **Routing Decision**: an LLM (via the pi SDK) when `router.model` is set, otherwise keyword rules. The Order text passes through unchanged.
- While the Root is online, every Order is relayed through it (ADR-0001). While it is offline, same-host Orders still deliver and cross-host Orders go directly to the target Daemon (ADR-0004); only when that is unreachable does the Order fail with `root_unreachable`. When the Root returns, conversations from the offline period are backfilled to it.
- The Registry is replicated from the Root to every Daemon (ADR-0002). Thread contents live in `~/.cafe/sessions/<date>/<threadId>.jsonl`; SQLite keeps only metadata (ADR-0003).

## Quick start

Requires Node ≥ 22.19.

```bash
npm i -g @blrbiran/cafe
cafe init --yes --name my-agent --description "what this agent can answer"
cafe daemon start --root
cafe doctor                       # checks each item and prints the next step; "all checks passed" when healthy
open http://127.0.0.1:4777/       # web UI
```

`cafe --help` carries the same quick start. Install the same version on every machine: incompatible protocol versions are refused, and compatible-but-different versions are flagged by `cafe daemon status` and the Network page.

## Identity: `.cafe`

`.cafe` is a YAML file giving agents started in that directory a name, description and role. `cafe init` writes a commented minimal file:

```yaml
name: billing
description: Owns the billing service: invoices, VAT, payment provider integration.
tags: [billing, invoice, vat]
scope: [~/code/billing]
role: barista        # or customer (asks only, never receives Orders)
concurrency: 1       # headless worker processes
```

- Without a `.cafe`: Customers (CLI, MCP, Claude Code / Codex) work anonymously under the directory name; Baristas (`serve`, `barista start`) need an explicit identity and are pointed at `cafe init`.
- A directory named `.cafe` is cafe's data directory (`~/.cafe`), not an identity file; `cafe init` will not overwrite it.
- A broken `.cafe` reports the file path, the missing field and a minimal template instead of a raw `EISDIR` / ZodError.

Renaming and aliases (routing keys and history are untouched; see [ADR-0007](docs/adr/0007-display-names-and-aliases.md)):

```bash
cafe host rename mac-mini-2         # this Host's display name (hot)
cafe host alias old-mac-mini        # a user alias; shown first, removable
cafe host unalias old-mac-mini      # remove a user alias (automatic old names stay routable)
cafe agent rename billing@mac-mini billing-owner   # Agent display name; Address unchanged
cafe agent alias billing@mac-mini invoices         # user alias (alias-first display)
cafe agent unalias billing@mac-mini invoices
cafe daemon rename ssh1 ssh1-docker # from the Root: rename another Daemon's display name
cafe host address ssh1 30.251.57.17:4777   # Root only: pin the address others use for a machine
cafe host address ssh1 --clear             # forget the pinned address
```

Internal `host`, `agentId` and Address never change, so old Threads/statistics stay valid. Renaming no longer adds the old name to the display candidates: it goes into `legacyAliases` and keeps routing, while `aliases` are user-added and are shown first (`alias → displayName → stable name`). The Web shows both as chips; only user aliases have a remove button.

## As a Customer

- **Claude Code / Codex (MCP recommended)**: `cafe mcp install` registers `cafe mcp` at user scope (`--dry-run` only prints the commands, `--client claude|codex` installs one). Tools: `cafe_agents`, `cafe_ask`, `cafe_wait`, `cafe_cancel`. It registers absolute node + cafe.js paths; reinstall after changing Node versions or moving the repo.
- **skill**: `cafe skill install` symlinks `~/.claude/skills/cafe` and `~/.agents/skills/cafe`. Codex references it as `$cafe`, pi as `/skill:cafe`.

How each host exposes cafe (all of them can also ask through the CLI or MCP):

| Host | Natural entry | Notes |
|---|---|---|
| Codex | `$cafe` + MCP tools | `cafe mcp install` makes Codex a **Customer**; `cafe barista start --agent codex` makes it a **Barista** |
| pi / omp | `/cafe agents\|ask\|status\|thread\|help` + `/skill:cafe` + extension tools | the extension registers `/cafe`; the skill keeps its own `/skill:cafe` namespace |
| Claude Code | `/cafe agents\|ask\|status\|thread\|help` (Customer, after `cafe commands install --agent claude`), `/cafe-barista off\|on` (plugin session control), skill, MCP | the Claude plugin owns `/cafe-barista`; `/cafe` is the same Customer entry as pi/omp |

`cafe mcp install` only lets the host **ask** other agents. To let it **answer**, start a Barista: `cafe barista start --dir <dir> --agent codex|claude`, or `cafe serve --preset codex|claude` (both read-only by default; `--write` widens it).
- **CLI**: `cafe ask "..."`, `cafe ask --to billing "..."`, `cafe ask --broadcast "..."` (explicitly ask every Barista; normal routing asks one, or at most a few when nobody clearly owns it), `cafe ask --attach ./log.txt "..."`, `cafe reply <threadId> --agent <address> --attach ./out.txt "..."` (reply as a target Barista from a script), `cafe ask --thread <id> "follow-up"`, `cafe inbox`, `cafe thread <id>`, `cafe thread <id> --download <attachmentId>`, `cafe tail` (every routed / delivered / acked / replied / closed event; `--json` for JSONL, `--host` / `--type` / `--thread` to filter, heartbeats hidden by default).
- **Web**: open `http://127.0.0.1:4777/`. The nav stays fixed and the content scrolls independently. Click a conversation to open it in a side drawer; the nav's Agents item expands to show the registered agents; Settings changes display names/aliases, the routing model and supervised Baristas; Live is the network-wide event stream.

## As a Barista

### pi / omp (persistent install)

```bash
cafe extension install --agent all          # pi: writes ~/.pi/agent/settings.json; omp: omp install
cafe extension status                       # check both hosts actually load it
cafe extension install --agent pi --dry-run # only show what would be written
```

`pi -e "$(cafe pi-extension-path)"` / `omp -e ...` still work, but only for that one launch — handy for temporary debugging.

Headless Baristas (supervised by the Daemon, restarted on crash):

```bash
cafe barista start --dir ~/code/billing            # pi
cafe barista start --dir ~/code/billing --agent omp
```

`barista start` waits until the Barista registers and prints its address. If it fails at once (a missing executable, no Codex session for `--tui`, a broken `.cafe`), the command fails with the worker's own message and its log path and leaves nothing running. A worker that fails three quick starts in a row stops retrying; `cafe barista list` shows it as `failed` with the reason, and running `barista start` again replaces it.

### Codex / Claude Code (native sessions, supervised by the Daemon)

```bash
cafe barista start --dir ~/code/billing --agent codex    # codex app-server
cafe barista start --dir ~/code/billing --agent claude   # claude -p, one process per question
```

**Read-only by default** (Codex read-only sandbox, every approval refused; Claude only Read / Grep / Glob). `--write` allows editing files inside `--dir` and nothing more; `--model <m>` picks the model. Claude uses the local `claude` login with read-only user settings; with `ANTHROPIC_API_KEY` set it switches to `--bare`. See [ADR-0005](docs/adr/0005-native-codex-claude-baristas.md).

### The terminal session you are already using

```bash
cafe claude install            # install cafe's Claude Code plugin (--dry-run first)
                               # Claude Code sessions opened in a dir with .cafe then answer questions
                               # in the session: /cafe shows the address, /cafe-barista off pauses, on resumes
                               # (older plugin installs used /cafe for pause/resume; rerun `cafe claude install`)
cafe barista start --dir ~/code/billing --agent codex --tui   # questions go to the most recently active Codex session in that dir
```

Questions enter as a new turn when the session is idle; approvals stay with you in the terminal. If a question has not started within 120 s (busy, interrupted with Esc and no new message yet, or closed) it is declined as "temporarily unavailable". See [ADR-0006](docs/adr/0006-tui-sessions-as-baristas.md).

### Any command

```bash
cafe serve --exec "<any command>" --dir ~/code/billing    # or --preset claude|codex
```

One command run per question: prompt on stdin, answer on stdout; print `CAFE_DECLINE: reason` to decline. Follow-ups have no session and rely only on the history in the prompt.

## Chat connectors (experimental)

`cafe connector` runs a Customer connector **out of process**: it turns platform messages into cafe Orders and posts the answers back. A mock connector ships for testing, and **Discord** is the first real platform.

```bash
cafe connector install packages/connector/mock   # from a source checkout
cafe connector config mock ingestPort 4899       # optional: feed events over HTTP
cafe connector start mock
curl -s -X POST 127.0.0.1:4899 -H 'content-type: application/json' \
  -d '{"channel":"demo","user":"you","eventId":"e1","text":"what does cafe do?"}'
cafe connector logs mock --follow                # heartbeats and replies
cafe connector status mock
cafe connector stop mock
```

**Discord** (needs the bot token and the **Message Content** privileged intent in the Discord Developer Portal → Bot):

```bash
cafe connector install <cafe-package>/connector/discord   # or packages/connector/discord from a checkout
cafe connector config discord token <bot token>           # stored owner-only; never echoed
cafe connector config discord allowChannels '["1234"]'    # allowlist guild/channel/user ids
cafe connector config discord allowGuilds   '["5678"]'
cafe connector start discord
cafe connector logs discord --follow
```

In a guild the bot answers only messages that mention it (`requireMention`, default on); `allowDMs` enables direct messages. Replies are posted back to the same channel, chunked to Discord's 2000-character limit; each chunk carries a stable nonce, so a crash-recovery resend cannot post the same answer twice. `allowGuilds`/`allowChannels`/`allowUsers` default to empty = allow all, so set an allowlist for a shared server. The connector installs `discord.js` into its own directory (not a cafe dependency).

**Attachments are opt-in.** With `cafe connector config discord allowAttachments true`, a message's files are downloaded, uploaded to the local daemon and attached to the Order; the Barista gets the text and a local path, never the file contents. Because a message URL is attacker-controlled, a download happens only when the URL is `https` and its host is exactly in `attachmentHosts` (`cdn.discordapp.com` and `media.discordapp.net` by default), and only up to `attachmentMaxMb` (default 25). A message that is only a file is accepted when attachments are enabled.

A connector is a directory with `cafe-connector.json` (name, entry, permissions, configSchema) and an entry that uses `@cafe/connector`'s `defineConnector`. State lives in `CAFE_HOME/connector-data/<name>/`; logs in `CAFE_HOME/logs/connector-<name>.log`. `install` copies the directory and links the SDK into its `node_modules`; the SDK ships with the package (`connector/`), so a connector installed from a published cafe resolves `@cafe/connector` too. A connector runs under a supervisor: if it exits unexpectedly it is restarted with backoff, and after 5 exits within a minute it is left `crashed` (check `cafe connector logs`) instead of looping forever. Tune with `CAFE_CONNECTOR_MAX_RESTARTS` / `CAFE_CONNECTOR_WINDOW_MS` / `CAFE_CONNECTOR_BACKOFF_MS`.

## Configuration

`~/.cafe/config.yml` (override the directory with `CAFE_HOME`):

```yaml
mode: daemon               # daemon | root (changing this needs a restart)
host: mac-mini             # part of the address; see renaming below
port: 4777                 # changing the port needs a restart
token: <shared token>      # required for LAN connections; loopback connections need no token
advertise: 192.168.1.10    # address other machines can reach; must be set explicitly in containers/NAT
root: 192.168.1.10:4777    # when mode=daemon
router:
  model: anthropic/claude-haiku-4-5   # via pi's auth.json; unset = rules routing
  fallback: rules          # rules | root (ask the Root to route when no local LLM)
  learn: true              # use the last 7 days of declines to order equally-matching Baristas
discovery: true            # LAN mDNS: the Root answers, Daemons without root look for one
retention:
  days: 90                 # optional; unset = never auto-prune, use `cafe prune --older-than N [--yes]`
```

**What applies hot**: `router.model` and `root` are applied to the running Daemon through `/api/reload`; `mode`, `host`, `port`, `advertise`, `retention` and `discovery` need a restart. `cafe config set` now says which case applies (`applied` vs `saved; restart required: cafe daemon restart`), `cafe config diff` lists every file-vs-running difference, `cafe config apply` applies the hot keys, and `cafe daemon restart` applies the rest. `cafe status` shows daemon, router, root, traffic, pending config and the next command in one screen.

`cafe root set <addr>` and `cafe config set <k> <v>` both update the file; `cafe root set` also updates the live connection. A Daemon in a container or behind NAT must set `advertise` to an address the Root can reach, otherwise the Root will not record an unreachable dial-back address.

On the same LAN, a Daemon without `root` finds the Root over mDNS (auto-connects only when exactly one is found); `cafe root discover` lists them manually. The token still has to be set by hand. `cafe daemon install` makes the Daemon start at login and restart on crash (macOS launchd / Linux systemd --user); `cafe daemon uninstall` removes it. See [`docs/specs/v2-3-discovery-autostart.md`](docs/specs/v2-3-discovery-autostart.md).

**Controlled update / rollback**: `cafe update apply --file <release.tgz>` (or `--version <x>` to download from npm) stages the release under `~/.cafe/releases/<version>`, drains open Orders (`cafe daemon drain`), stops the daemon, atomically switches the `current` symlink, starts the new code and health-checks it; a failed check switches back to the last-known-good release. `cafe update status` / `check` / `rollback` report and control this; `--sha256` verifies the tarball (optional, warns when absent). Upgrades are CLI-only by design — an Order or the Web UI cannot trigger one. See [`docs/specs/v4-2-update-rollback.md`](docs/specs/v4-2-update-rollback.md).

Routing is driven mainly by each Barista's description; `router.learn` is only auxiliary: Baristas that recently declined similar questions are ranked lower, but never excluded and never outrank a better description match. `cafe stats` shows each Barista's answered/declined counts and frequent decline topics over the last 7 days. See [`docs/specs/v2-1-routing-hints.md`](docs/specs/v2-1-routing-hints.md).

## Verify and troubleshoot

```bash
cafe doctor               # checks daemon, identity, extension, skill, router, root; prints the next command
cafe daemon status
cafe agents               # you should see your Barista (address, role, status)
open http://127.0.0.1:4777/
```

"Installed the extension but no Agent in the web UI" — check in this order:

1. `cafe extension status`: is there a cafe entry in pi's settings, did omp link successfully;
2. the host must restart to reload extensions; `cafe daemon status` shows whether the Daemon is running;
3. `cafe init` confirms the current directory has a parseable `.cafe`;
4. `cafe doctor` prints all of the above plus the next step.

`cafe daemon stop` / `restart` only act on the daemon of *this* `CAFE_HOME`: the daemon reports an id of its home in `/api/health`, and a daemon that belongs to another home (or a `CAFE_HOME` with no `config.yml`) is refused instead of being shut down. Read-only commands no longer create `config.yml` in an empty `CAFE_HOME`; `cafe daemon start` (or `cafe config set`) does. With `--json`, every error, including a misspelt command, is one JSON object on stdout (`{"error","message","suggestions"?}`) with exit code 1.

`GET /api/health` also returns `startedAt` and scoped metrics: `*SinceStart` counters reset when the daemon restarts (`eventsSinceStart`, `appendBytesSinceStart`, `metaWritesSinceStart`, `metaBytesSinceStart`), `*Total` are what the database holds (`threadsTotal`, `indexedEventsTotal`), `last*` time the most recent operation (`lastSnapshotMs`, `lastSearchMs`); `subscribedThreads` counts live thread subscriptions. The unscoped names (`events`, `threads`, …) are kept for one release.

Network page → **Test connection** names the cause (connection refused, host not found, timeout, token, certificate) instead of "fetch failed"; saving an address the hub cannot reach says so, and the other machines keep the last address that worked.

Logs: `~/.cafe/daemon.log` (timestamped, capped at 16 MB with one `daemon.log.1`), `~/.cafe/daemon.stdout.log` (raw startup output), `~/.cafe/logs/barista-*.log`; raw Threads in `~/.cafe/sessions/<date>/<threadId>.jsonl`.

### Addressing and access

- The daemon answers only to a `Host` header that belongs to this machine (`localhost`, `127.0.0.1`, its own host name, `advertise` or one of its IPs). A page that reached it through DNS rebinding is refused, including its static files.
- A request that carries a foreign `Origin` cannot write. A write is accepted only when the `Origin` names exactly the scheme, host and port the request arrived on — a different port or scheme on a trusted hostname is refused too. The Web UI and CLI keep working; `curl`/MCP send no `Origin` and are unaffected. Loopback still needs no token; remote access still does.
- `advertise` may be a bare host (`192.168.1.20`) or `host:port`. A port already in it is not doubled. `cafe root set` and `cafe connect` validate the address before writing it (and `POST /api/root` refuses a malformed one), so a stopped daemon is never pointed at an address it cannot parse.
- A child whose `advertise` is unreachable from the Root (Docker/NAT) no longer poisons direct links: the Root only broadcasts addresses it has verified, and `cafe host address` (or Network → Edit address) pins a working one. A pinned address is broadcast only once a reachability probe succeeds; `cafe host address <host> --clear` falls back to the address the Root last verified.
- `cafe ask` gives up after `--timeout <seconds>` (default: no limit) and cancels the Order, and Ctrl-C cancels it too, so a stuck follow-up does not leave `thread_busy` behind. If that cancel request fails, the CLI says so instead of claiming the question was cancelled. A unicast Order whose Barista only heartbeats closes after 10 minutes. A follow-up on a busy Thread can pass `--replace` to cancel the old question. `cafe wait` on a turn older than the daemon's 200-event replay page still finishes, because the daemon reads that turn's close from the Thread file.
- `POST /api/baristas` only starts `pi`, `omp`, `codex` or `claude`; it no longer accepts an arbitrary executable or argv.
- **Transport security (TLS, v4-6).** `security.mode: tls` is the default. A Root generates a CA once (`~/.cafe/tls/ca.crt` + `ca.key`, 0600) and each Daemon presents a leaf signed by it on a TLS port (`security.tls.port`, default 4778); the Web UI and loopback calls stay on plaintext 4777. `root` is the Root's **main** address (the one `cafe daemon status` prints, e.g. `192.168.1.10:4777`); a child Host with no CA fetches the Root's public CA from it, checks or records its SHA-256 fingerprint, learns the Root's TLS port, and dials `wss://` there. Set the pin explicitly with `cafe connect <host:port> --token … --ca-fingerprint sha256:…` (`cafe root show` on the Root prints it). Until a child has joined the network it does **not** connect to the Root at all — `cafe doctor` / `cafe daemon status` show "not on the network yet" with the reason, and it retries (5 s up to 5 min). Daemon addresses on a TLS network are `wss://<host>:<tls port>`, so direct links between children are TLS too; a plaintext address (a hand-set one, or one from an older Daemon) is upgraded by asking that Host for its TLS port, never dialled in plaintext. `GET /api/tls` (CA + TLS port) is public. Verification is fail-closed — there is no plaintext fallback — and the SAN is checked together with a per-peer leaf-key pin (`security.tls.pins`, recorded on first contact). A leaf is renewed automatically before expiry (inside 21 days, checked every 6 h while running) and a renewal keeps the leaf's key, so a pin survives rotation; `cafe daemon renew-cert` reissues on demand. If a Host was deliberately reinstalled and its key changed, clear the old pin with `cafe host pin <host:port> --clear`. `security.mode: plaintext` is an explicit local/isolation escape hatch. See [`docs/specs/v4-6-tls.md`](docs/specs/v4-6-tls.md).

## Package layout

| Package | Purpose |
|---|---|
| `packages/protocol` | Wire types and zod schemas, `Peer` (request/response/notification), `CafeClient` (agent-side client), `.cafe` discovery |
| `packages/daemon` | Daemon/Root, Registry, Router (rules / LLM), Store, HTTP+WS server, headless Barista supervisor |
| `packages/cli` | The `cafe` command; `src/bridge/` bridges Codex / Claude Code Baristas, `src/mcp.ts` is `cafe mcp` |
| `packages/pi-extension` | pi extension: makes pi a Barista (TUI or headless) and provides `cafe_ask` and friends |
| `packages/web` | Web UI (React 19 + Vite + Tailwind v4), served by the Daemon after build |
| `skills/cafe` | Skill for Claude Code / Codex / pi |

## Development

The source is TypeScript run directly by Node's type stripping — no build step.

```bash
npm install
npm run typecheck
npm test                     # vitest: multi-daemon end-to-end tests (fake baristas, fake LLM)
npm run build:web            # build the web UI → packages/web/dist

npm link --workspace @cafe/cli    # optional: put `cafe` on PATH
cafe daemon start --root
cafe barista start --dir ~/code/some-repo
cafe ask "who knows about this?"
open http://127.0.0.1:4777/
```

Publishing (maintainers): `npm version <x.y.z>` → `npm run test:release` (pack, install into a temp prefix and smoke-test, no model calls) → `npm publish ./release`. See [`docs/specs/v2-7-publishing.md`](docs/specs/v2-7-publishing.md).

### Upgrade an existing source install

The Daemon is a long-running process: `npm run build:web` does **not** switch a running Daemon to new code. Update the files, then restart it:

```bash
git pull
source ~/.bash_profile          # Node ≥ 22.19 (nvm); a bare ssh login may still be Node 18
npm install
npm run build:web
npm link --workspace @cafe/cli
cafe daemon restart             # required: builds do not reload the daemon
cafe extension install --agent pi
cafe extension install --agent omp   # optional; omp install is an alias of omp plugin install
cafe daemon status              # version should now match package.json
cafe status                     # daemon / router / pending config in one screen
cafe doctor
```

Changing the Node version (or moving the repo) invalidates the absolute paths recorded by `cafe daemon install`, `cafe mcp install` and `cafe claude install`; run them again. In a container or behind NAT, set `advertise` to an address the Root can reach. Running pi / omp sessions keep their old extension until the host restarts.

## oh-my-pi

The same pi extension works in oh-my-pi (omp): `cafe extension install --agent omp`, headless via `cafe barista start --dir <dir> --agent omp`. Differences are handled in [`docs/specs/v2-6-oh-my-pi.md`](docs/specs/v2-6-oh-my-pi.md).
