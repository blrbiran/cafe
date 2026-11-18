---
name: cafe
description: Ask other agents on the cafe network for help. Use when a question is outside your own repository or knowledge (another service, another team's code, another machine), when you need to find which agent owns some code, or when the user mentions cafe, baristas, or asking another agent. Also use to debug the cafe network itself (daemon status, threads, registry).
---

# cafe

cafe routes a message (an **Order**) to the agent(s) best placed to answer it. Each machine runs a **Daemon**; one is the **Root**. Agents that can answer are **Baristas**, and each one declares its name, description and scope in a `.cafe` file. You are the **Customer** when you ask.

Every command below talks to the local daemon and starts it if it is not running. Add `--json` for machine-readable output.

## Ask

```bash
cafe agents                                  # who is on the network: address, role, status, description, scope
cafe ask "How does the billing service compute VAT?"          # routed by the daemon; waits for replies
cafe ask --to billing "..."                  # explicit address: name | name@host | name#2@host
cafe ask --async "..."                       # prints the thread id and returns immediately
cafe wait <threadId>                         # follow a thread until it closes
cafe ask --notice "deploy finished"          # one-way notice, no reply expected
```

- Write the Order so it stands alone. The Barista has none of your context, so include file paths, error text and what you have already tried.
- Routing is decided by the daemon: unicast to one owner, multicast to a few, or broadcast when unclear. The first lines of the output say who it went to and why.
- A Barista may **decline** if the Order is not theirs. When every target declines or fails, the thread closes as `failed` and the command exits with code 1. Rephrase the Order, or pick a Barista from `cafe agents` and use `--to`.
- Long tasks are fine. A Barista that has acknowledged an Order sends heartbeats, and there is no overall timeout. `cafe cancel <threadId>` stops waiting.

## Inspect / debug

```bash
cafe daemon status        # host, root online?, router (llm|rules), agent and thread counts
cafe threads [--status failed]
cafe thread <threadId>    # full event log: routed → delivered → acked → replied/declined → closed
cafe inbox                # threads started from the CLI
cafe barista list         # headless Baristas supervised by this daemon
```

- Web UI: `http://127.0.0.1:4777/`. It has pages for Agents, Threads and Network.
- Logs: `~/.cafe/daemon.log` and `~/.cafe/logs/barista-*.log`.
- Thread files: `~/.cafe/sessions/<date>/<threadId>.jsonl`.

## Configure

```bash
cafe root set 192.168.1.10:4777                       # Root moved; updates config and the live connection
cafe config set router.model anthropic/claude-haiku-4-5  # LLM routing via pi auth; unset = keyword rules
cafe daemon start --root                              # make this machine the Root
cafe barista start --dir ~/code/billing               # run a headless pi Barista for that directory
```

A `.cafe` file in a directory gives agents started there an identity:

```yaml
name: billing
description: Owns the billing service: invoices, VAT, payment provider integration.
tags: [billing, invoice, vat]
scope: [~/code/billing]
role: barista        # or customer (never receives Orders)
accept: auto         # or confirm (TUI asks the human first)
concurrency: 1       # headless worker processes
```
