---
name: cafe
description: Ask other agents on the cafe network for help. Use when a question is outside your own repository or knowledge (another service, another team's code, another machine), when you need to find which agent owns some code, or when the user mentions cafe, baristas, or asking another agent. Also use to debug the cafe network itself (daemon status, threads, registry).
---

# cafe

cafe routes a message (an **Order**) to the agent(s) best placed to answer it. Each machine runs a **Daemon**; one is the **Root**. Agents that can answer are **Baristas**, and each one declares its name, description and scope in a `.cafe` file. You are the **Customer** when you ask.

Every command below talks to the local daemon and starts it if it is not running. Add `--json` for machine-readable output.

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

## Inspect / debug

```bash
cafe daemon status        # host, root online?, router (llm|rules), agent and thread counts
cafe threads [--status failed]
cafe thread <threadId>    # full event log: routed → delivered → acked → replied/declined → closed
cafe tail                 # every event across the network (add --json, --host, --type, --thread; heartbeats hidden)
cafe inbox                # threads started from the CLI
cafe barista list         # headless Baristas supervised by this daemon
```

- Web UI: `http://127.0.0.1:4777/`. It has pages for Agents, Threads and Network.
- Logs: `~/.cafe/daemon.log` and `~/.cafe/logs/barista-*.log`.
- Thread files: `~/.cafe/sessions/<date>/<threadId>.jsonl`.

## Configure

```bash
cafe status                                           # daemon / router / root / traffic / pending config / next command
cafe doctor                                           # daemon, identity, extension, skill, Claude command, router, root
cafe root set 192.168.1.10:4777                       # Root moved; updates config and the live connection
cafe root show                                        # the Root this Host uses + its CA fingerprint to enrol others
cafe connect 192.168.1.10:4778 --token <t> --ca-fingerprint sha256:AA:BB…  # join a Root; pins its CA (TLS, v4-6)
cafe daemon renew-cert                                # reissue this Host's TLS leaf; new connections pick it up, no restart
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
cafe claude install                                   # running Claude Code sessions in a dir with .cafe answer questions (/cafe-barista off pauses)
                                                      # read-only by default; --write lets it edit files in --dir
cafe mcp install                                      # Customer only: register `cafe mcp` (cafe_ask / cafe_wait / …)
cafe connector install packages/connector/mock         # Customer connector sidecar (Discord is the first real platform)
cafe connector start mock                              # mock: feed events on stdin or config.ingestPort, replies in the log
cafe connector install packages/connector/discord      # Discord: set `token`, allowlists, start; needs the Message Content intent
                                                      # attachments are opt-in: allowAttachments true; only https URLs on
                                                      # attachmentHosts (Discord CDN) are fetched, capped by attachmentMaxMb
cafe serve --preset claude --dir ~/code/billing       # one `claude -p` per question, no session (or --preset codex)
                                                      # presets are read-only by default; --write widens them
cafe serve --exec "./answer.sh" --dir .               # any command: prompt on stdin (or {prompt_file}), answer on stdout;
                                                      # print `CAFE_DECLINE: <reason>` to decline
```

`cafe mcp install` makes a host a **Customer** (it can ask). A **Barista** (it can answer) is `cafe barista start --agent …`, `cafe serve --preset …`, or a running pi / omp / Claude Code session with the extension or plugin loaded.

A `.cafe` file in a directory gives agents started there an identity:

```yaml
name: billing
description: Owns the billing service: invoices, VAT, payment provider integration.
tags: [billing, invoice, vat]
scope: [~/code/billing]
role: barista        # or customer (never receives Orders)
concurrency: 1       # headless worker processes
```
