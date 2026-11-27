---
name: cafe
description: Ask other agents on the cafe network for help. Use when a question is outside your own repository or knowledge (another service, another team's code, another machine), when you need to find which agent owns some code, or when the user mentions cafe, baristas, or asking another agent. Also use to debug the cafe network itself (daemon status, threads, registry).
---

# cafe

cafe routes a message (an **Order**) to the agent(s) best placed to answer it. Each machine runs a **Daemon**; one is the **Root**. Agents that can answer are **Baristas**, and each one declares its name, description and scope in a `.cafe` file. You are the **Customer** when you ask.

Every command below talks to the local daemon and starts it if it is not running. Add `--json` for machine-readable output; under `--json` an error is also JSON on stdout (`{"error","message","suggestions"?}`, exit 1).

## When the user writes `$cafe` or asks you to use cafe

MANDATORY: your first action MUST be `cafe agents` (or `cafe ask` when the request already names an agent). Do NOT run `rg`/`cat`/`sed`/`find`, read repository files, or answer from local code before that first cafe command — even when the code is on this machine. Another agent owns it and must answer.

The only exception is the user explicitly saying not to use cafe. If the daemon is unreachable, stop and ask whether a local investigation is allowed; never fall back to it silently.

Questions about cafe's own implementation go to the cafe owner listed by `cafe agents` (usually `cafe#1`): `cafe ask --to <address> "..."`.

## Ask

```bash
cafe agents                                  # who is on the network: address, role, status, description, scope
cafe stats                                   # last 7 days per barista: answered / declined, topics it often declines
cafe search <text>                           # find past questions/answers containing the text
cafe ask "How does the billing service compute VAT?"          # routed by the daemon; waits for replies
cafe ask --to billing "..."                  # explicit address: name | name@host | name#2@host
cafe ask --broadcast "..."                   # ask every eligible agent; normal routing picks one, or at most a few when unsure
cafe ask --attach ./serial.log "..."         # attach local files; the Barista gets local paths, not contents
cafe reply <threadId> --agent <address> "..."  # reply as a target Barista from a script; --attach to send files
cafe ask --thread <threadId> "and what about X?"   # follow-up: goes to whoever answered, with the earlier turns attached
cafe ask --async "..."                       # prints the thread id and returns immediately
cafe wait <threadId>                         # follow a thread until it closes
cafe ask --notice "deploy finished"          # one-way notice, no reply expected
```

- Write the Order so it stands alone. The Barista has none of your context, so include file paths, error text and what you have already tried.
- When you ask **on the user's behalf**, pass `--origin agent` so the Thread shows it was relayed, and `--via <your address>` if you are a registered Barista (`cafe agents` lists you). The web UI and MCP mark this automatically; the CLI defaults to `human`.
- Routing is decided by the daemon: unicast to one owner, multicast to a few, or broadcast when unclear. The first lines of the output say who it went to and why.
- A Barista may **decline** if the Order is not theirs. When every target declines or fails, the thread closes as `failed` and the command exits with code 1. Rephrase the Order, or pick a Barista from `cafe agents` and use `--to`.
- Long tasks are fine, but not unbounded: heartbeats prove the Barista is alive, not that it will answer. A unicast Order closes after 10 minutes without a final reply, and `cafe ask --timeout <seconds>` (or Ctrl-C) cancels it earlier, so a stuck follow-up never leaves `thread_busy` behind. `cafe cancel <threadId>` stops waiting; `cafe ask --thread <id> --replace "..."` asks again immediately.
- `cafe thread <id>` now returns the newest 200 events; older pages come with `?before=`.

## Teams and channels (v4-11; one front door since v4-13)

A `.cafe` may declare one team with **exactly one orchestrator**; each member is
one process with a duty, directory and channel. `cafe team start` fills in
missing headless members and never touches a session you started yourself.

```bash
cafe team start [member…] --dir <roster dir> --dry-run   # plan; --force starts an unowned same-name member
cafe team sync                                           # publish .cafe membership; start nothing
cafe team status                                         # roster, online, current Thread, revision, warnings
cafe team context <member>                               # the playbook that member receives
cafe team stop [member…]                                 # only supervised members; TUI sessions stay
cafe team remove <team>                                  # remove the roster (refuses while a member is online)
cafe ask --channel <name> "..."                          # post to a channel instead of your home channel
cafe ask --collect all "..."                             # multicast: wait for every target or the deadline
cafe ask --escalate --parent <orderId> --parent-thread <threadId> "..."  # ask the sender of the Order you are handling
cafe channel list                                        # channels, Thread counts, teams (and channel conflicts)
cafe channel threads <name> [--after <ms>]               # one channel's Threads (observer catch-up)
```

- `to: <team>` reaches **only the orchestrator** (the team's front door). A
  fresh message in the team channel with no `to:` does the same. `to: <member>`
  assigns one member; `to: <duty>` asks the unique online member with that duty.
  Reaching everyone requires an explicit `broadcast: true`.
- A follow-up goes to the previous turn's final responders, then that turn's
  targets; if none are online it fails as `responders_offline` instead of
  falling back to rules/LLM routing.
- A registering member receives a team playbook (its duty, the roster, how to
  assign/report/escalate). A roster change pushes one short `team/roster` note
  to online members; it is not an Order and does not trigger a turn.
- A sub-Thread (`escalate`) is linked by `parentThreadId`; it never falls back
  to routing or an implicit broadcast. Use `to:` to delegate, `broadcast: true`
  to address the whole channel. The Web shows the parent/child links and the
  latest turn's target states.
- `collect: all` reports deadline silences as skipped (auditable), not declines;
  `ThreadMeta.targetStates` names who is still silent.
- An `observer: true` member is never routed to. It receives one channel digest
  per interval (not one message per Order), can send fresh Orders, and should
  run on the Root or the team's Host. The Root publishes the complete digest
  while online; a child publishes `partial` only while the Root is offline.
- Channels are **not permissions**. The Web shows channel chips and a Teams page;
  the composer always names its destination (`→ #channel`), defaulting to the
  team's orchestrator in a team channel.
- **Mixed releases fail honestly:** a Daemon advertises features on
  `initialize`, `/api/health` and `/api/snapshot`. A newer client talking to an
  older Daemon **refuses before creating an Order** when it asks for a channel,
  `escalate`, `collect: all`, a team target or team identity; observer
  registration is refused on the same rule, and `cafe team` preflights before
  touching a worker. After upgrading, restart the daemon (`cafe daemon restart`)
  and the session; `cafe doctor` reports a daemon without the current features.

## Inspect / debug

```bash
cafe daemon status        # host, root online?, router (llm|rules), agent and thread counts
cafe threads [--status failed]
cafe thread <threadId>    # full event log: routed → delivered → acked → replied/declined → closed
cafe tail                 # every event across the network (add --json, --host, --type, --thread; heartbeats hidden)
cafe inbox                # threads started from the CLI
cafe barista list         # headless Baristas supervised by this daemon
```

- Web UI: `http://127.0.0.1:4777/`. It has pages for Agents, Threads and Network. From another device, prefer the encrypted `https://<address>:4778/` (the device must trust the cafe CA from `/ca.crt`, fingerprint checked against `cafe root show`); paste the token (`cafe config get token`) when the page asks, or use `…/#token=<token>`; never put the token in `?token=` (the daemon only accepts `Authorization: Bearer`). `cafe daemon status` prints the addresses on its `web:` line.
- Logs: `~/.cafe/daemon.log` and `~/.cafe/logs/barista-*.log`.
- Thread files: `~/.cafe/sessions/<date>/<threadId>.jsonl`.
- `claude·bg` in `cafe agents` is a Claude Code session running in the background (no terminal); attach and exit, or `/cafe off` in it, to take it offline.
- `router: loading` right after a daemon restart: the LLM router is still loading; questions asked now wait for it, nothing to fix.
- `tls-links` warn "refused … ago" in `cafe doctor`: a machine tried plaintext once and stopped; it clears itself after 24 h.
- "port … is already in use" from `cafe daemon start`: a second Daemon on one machine needs its own `port` and `security.tls.port`.

## Configure

```bash
cafe status                                           # daemon / router / root / traffic / pending config / next command
cafe doctor                                           # daemon, identity, extension, skill, Claude command, router, root
cafe root set 192.168.1.10:4777                       # Root moved; updates config and the live connection
cafe root show                                        # the Root this Host uses + its CA fingerprint; on the Root, the cafe connect command for a new machine (one per address on a multi-address Root)
cafe host forget <host>                       # Root only: remove an offline machine and its agents (it reappears if it reconnects)
cafe host invite                                       # on the Root: create a one-use invitation for the new Host
cafe connect 192.168.1.10:4778 --token <t> --invite <code> --ca-fingerprint <pin>  # on the new Host, then cafe daemon restart
cafe daemon renew-cert [--san <name>]                 # reissue this Host's TLS leaf for every local address (+ extra names), keeps the key, no restart
                                                      # a TLS hub refuses plaintext Daemon links: `cafe doctor` shows them under tls-links
cafe host pin                                         # per-peer leaf-key pins; `cafe host pin <host:port> --clear` after a reinstall
cafe config set router.model anthropic/claude-haiku-4-5  # LLM routing via pi auth; unset = keyword rules
cafe config diff                                      # config.yml vs the running daemon (hot vs restart-required)
cafe config apply                                     # apply hot keys; restart for the rest
cafe daemon start --root                              # make this machine the Root
cafe host rename mac-mini-2                           # this Host's display name (hot)
cafe host alias old-mac-mini                          # user alias (shown first); cafe host unalias removes it
cafe agent rename billing@mac-mini billing-owner      # Agent display name; Address stays stable
cafe agent alias billing@mac-mini invoices            # user alias; cafe agent unalias removes it
cafe extension install --agent pi                     # persistent pi extension (--agent omp / all)
cafe barista start --dir ~/code/billing               # run a headless pi Barista for that directory
cafe barista start --dir ~/code/billing --agent codex # a Codex Barista (codex app-server); --agent claude for Claude Code
cafe barista start --dir ~/code/billing --agent codex --tui  # answer in the Codex session already running there
# barista start waits for registration; if the worker fails at once it exits 1 with the worker's reason and log path
cafe claude install                                   # running Claude Code sessions in a dir with .cafe answer questions (/cafe-barista off pauses)
                                                      # read-only by default; --write lets it edit files in --dir
cafe mcp install                                      # Customer only: register `cafe mcp` (cafe_ask / cafe_wait / …)
cafe connector install packages/connector/mock         # Customer connector sidecar (Discord is the first real platform)
cafe connector start mock                              # mock: feed events on stdin or config.ingestPort, replies in the log
cafe connector install packages/connector/discord      # Discord: set `token`, allowlists, start; needs the Message Content intent
                                                      # attachments are opt-in: allowAttachments true; only https URLs on
                                                      # attachmentHosts (Discord CDN) are fetched, capped by attachmentMaxMb
                                                      # one channel = one Thread; quiet for newThreadAfterHours (6) or `/new` starts a new one
cafe serve --preset claude --dir ~/code/billing       # one `claude -p` per question, no session (or --preset codex)
                                                      # presets are read-only by default; --write widens them
cafe serve --exec "./answer.sh" --dir .               # any command: prompt on stdin (or {prompt_file}), answer on stdout;
                                                      # print `CAFE_DECLINE: <reason>` to decline
```

`cafe mcp install` makes a host a **Customer** (it can ask). A **Barista** (it can answer) is `cafe barista start --agent …`, `cafe serve --preset …`, or a running pi / omp / Claude Code session with the extension or plugin loaded.

A `.cafe` file in a directory gives agents started there an identity:

```yaml
name: billing
description: "Owns the billing service: invoices, VAT, payment provider integration."
tags: [billing, invoice, vat]
scope: [~/code/billing]
role: barista        # or customer (never receives Orders)
concurrency: 1       # headless worker processes
```
