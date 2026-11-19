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

Requires Node ≥ 22.18.

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
cafe host alias old-mac-mini        # old names/aliases still work in addresses
cafe agent rename billing@mac-mini billing-owner   # Agent display name; Address unchanged
cafe daemon rename ssh1 ssh1-docker # from the Root: rename another Daemon's display name
```

Internal `host`, `agentId` and Address never change, so old Threads/statistics stay valid; `displayName` only affects what the UI and CLI show.

## As a Customer

- **Claude Code / Codex (MCP recommended)**: `cafe mcp install` registers `cafe mcp` at user scope (`--dry-run` only prints the commands, `--client claude|codex` installs one). Tools: `cafe_agents`, `cafe_ask`, `cafe_wait`, `cafe_cancel`. It registers absolute node + cafe.js paths; reinstall after changing Node versions or moving the repo.
- **skill**: `cafe skill install` symlinks `~/.claude/skills/cafe` and `~/.agents/skills/cafe`. Codex references it as `$cafe`, pi as `/skill:cafe`.
- **CLI**: `cafe ask "..."`, `cafe ask --to billing "..."`, `cafe ask --thread <id> "follow-up"`, `cafe inbox`, `cafe thread <id>`.
- **Web**: open `http://127.0.0.1:4777/`, or click "Ask" on the Agents page.

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
                               # in the session: /cafe shows the address, /cafe off pauses, /cafe on resumes
cafe barista start --dir ~/code/billing --agent codex --tui   # questions go to the most recently active Codex session in that dir
```

Questions enter as a new turn when the session is idle; approvals stay with you in the terminal. If a question has not started within 120 s (busy, interrupted with Esc and no new message yet, or closed) it is declined as "temporarily unavailable". See [ADR-0006](docs/adr/0006-tui-sessions-as-baristas.md).

### Any command

```bash
cafe serve --exec "<any command>" --dir ~/code/billing    # or --preset claude|codex
```

One command run per question: prompt on stdin, answer on stdout; print `CAFE_DECLINE: reason` to decline. Follow-ups have no session and rely only on the history in the prompt.

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

**What applies hot**: `router.model` and `root` are applied to the running Daemon through `/api/reload`; `mode`, `host`, `port`, `advertise` and `discovery` need a restart (`cafe daemon stop && cafe daemon start`, or `cafe daemon restart`). `cafe config set` does not yet distinguish them for you; when unsure, check `cafe daemon status` / `cafe doctor`.

`cafe root set <addr>` and `cafe config set <k> <v>` both update the file; `cafe root set` also updates the live connection. A Daemon in a container or behind NAT must set `advertise` to an address the Root can reach, otherwise the Root will not record an unreachable dial-back address.

On the same LAN, a Daemon without `root` finds the Root over mDNS (auto-connects only when exactly one is found); `cafe root discover` lists them manually. The token still has to be set by hand. `cafe daemon install` makes the Daemon start at login and restart on crash (macOS launchd / Linux systemd --user); `cafe daemon uninstall` removes it. See [`docs/specs/v2-3-discovery-autostart.md`](docs/specs/v2-3-discovery-autostart.md).

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

Logs: `~/.cafe/daemon.log`, `~/.cafe/logs/barista-*.log`; raw Threads in `~/.cafe/sessions/<date>/<threadId>.jsonl`.

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

## oh-my-pi

The same pi extension works in oh-my-pi (omp): `cafe extension install --agent omp`, headless via `cafe barista start --dir <dir> --agent omp`. Differences are handled in [`docs/specs/v2-6-oh-my-pi.md`](docs/specs/v2-6-oh-my-pi.md).
