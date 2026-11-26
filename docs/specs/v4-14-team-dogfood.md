# v4-14 — Team dogfood and context budget

**Status:** implementation-ready validation design, 2026-11-26.
**Depends on:** `v4-13-team-sessions.md` and its current implementation.
**Source:** dogfooding ledger #71/#72 and the owner's approval to proceed with the team-session approach.

## 1. Intent

Validate that v4-13 behaves like a useful team front door in a realistic workflow, and that it reduces unnecessary agent wakeups and context growth. The implementation and unit suite already cover routing, roster lifecycle, escalation, collection, and UI links; the remaining risk is whether the combined workflow is understandable and efficient when used end to end.

Use the existing Cafe team protocol: one orchestrator, explicit member assignments, sub-Threads for delegated work, and explicit broadcast. Cafe records the conversation and delivery states. It does not plan a task DAG, operate git/worktrees, or decide merge strategy.

## 2. Goals

- Confirm a new request to a team wakes only its orchestrator.
- Confirm one explicit assignment wakes only its named member and creates a linked child Thread.
- Confirm a follow-up reaches only the immediately preceding turn's final responders, or fails honestly with `responders_offline`.
- Confirm explicit broadcast reaches all eligible members and `collect: all` waits for all targets or the deadline.
- Confirm target states and parent/child navigation make pending work visible in CLI and Web.
- Confirm roster sync reaches online members as a note without creating an Order or starting a turn.
- Record actual recipient count and wait time for each step, so context amplification and orchestrator queueing are visible.
- Exercise Root-online complete digests and Root-offline child partial digests across hosts.

## 3. Non-goals

- No new routing behavior, notification field, urgency tier, task graph, retry policy, or merge workflow in this validation batch.
- No paid model calls. Use deterministic local agents or existing no-cost session fixtures.
- No changes to the external issue ledger; it is outside this repository.

## 4. Approaches considered

| Approach | Description | Trade-off |
|---|---|---|
| **Team session dogfood (chosen)** | Exercise the current one-orchestrator protocol end to end, measure delivery and queue behavior, and change the design only when an observed failure justifies it. | Requires a small sequence of manual/local scenarios; does not automate the full value judgment. |
| Shared-room notifications | Let all team members observe each new request, then add notification levels or subscriptions. | Reintroduces wakeup/context coupling before evidence shows the front-door model is insufficient. |
| Built-in task coordinator | Cafe decomposes work, manages dependencies/retries, and collects outputs. | Adds a second task engine and expands Cafe beyond the existing Thread/sub-Thread contract. |

The owner selected the first approach. The other approaches remain possible only if dogfood evidence shows a concrete gap.

## 5. Scenario and expected observations

Use a scratch `CAFE_HOME` and a team roster with one `orchestrator`, one `developer`, and one `tester`. Keep all execution local unless a separately configured child host is available. Do not use the person's real `~/.cafe` for synthetic agents.

| Step | Action | Expected delivery / visible result |
|---|---|---|
| 1 | Submit a fresh request to the team, with and without an explicit team target. | Only the orchestrator is targeted. A busy orchestrator queues the work; an offline one returns `team_offline`. |
| 2 | Orchestrator assigns a concrete coding task to the developer. | Only the developer is targeted; the child Thread links to the parent; the parent remains the human-facing entry. |
| 3 | Developer needs a decision and escalates. | The parent sender is targeted. No unrelated router candidate receives the clarification. |
| 4 | Orchestrator sends an explicit `broadcast: true` in the team channel with `collect: all`. | All eligible members other than the sender are targeted (the protocol has no explicit multi-address target list); the Thread remains open until every target finishes or the deadline. Silent targets appear as skipped/pending, not as refusals. This separately verifies multi-recipient collection from the single-member assignment in step 2. |
| 5 | Ask an unrelated follow-up after a responder goes offline. | It returns `responders_offline`; it does not wake an unrelated agent through the rules/LLM router. |
| 6 | Send `broadcast: true`. | Every eligible member is targeted; observers are not implicitly targeted. |
| 7 | Change the `.cafe` roster and run `cafe team sync`. | Revision changes once; each online member gets one roster note; no Order is created and no turn starts. Repeating unchanged sync is a no-op. |
| 8 | Inspect the same Threads through CLI and Web. | Parent/child links and per-target state agree; deadline silence is not labelled declined. |
| 9 | With Root online, then offline, observe a digest on a remote observer. | Root publishes the complete digest while online; a child publishes partial only during Root outage; no duplicate digest for one interval. |

For each step record: target agent IDs, number of delivered Orders, number of agent turns actually started, elapsed time to first and final response, and whether the user could determine what is waiting without inspecting logs. Keep raw prompt/reply contents out of the handoff; record counts and short paraphrases only.

## 6. Decision rules after dogfood

- If the default team request wakes more than the orchestrator, treat it as a regression.
- If a direct assignment wakes a non-target member, treat it as a regression.
- If a follow-up with no live prior responder routes elsewhere, treat it as a regression.
- If roster updates start turns, treat it as a regression.
- If the orchestrator's serial queue is the main user-visible delay, record queue wait separately from task time. Propose a change only with a reproducible example; do not add DAG or urgency semantics preemptively.
- If developers still accumulate excessive unrelated context, identify which event caused each wakeup and whether it was a new Order, a follow-up, a digest, or a roster note before proposing notification tiers.

## 7. Release gate

Before the 0.2.0 release candidate is installed:

1. Run the full repository verification gates recorded in `docs/handoff/handoff.md` §3, including release smoke tests.
2. Run the local team scenarios and browser inspection.
3. If a second host is available, run the cross-host roster, roster note, and digest handover scenario; otherwise record it as blocked and retain it as a follow-up.
4. Re-check these five approved behavior changes against the implementation: `to: <team>` and a fresh team-channel request target only the orchestrator; follow-ups do not fall back to rules/LLM routing; `.cafe` requires exactly one orchestrator; old daemons hard-reject channel/escalate/collect/team identity/team target before Order creation; while Root is online it publishes complete digests and children publish partial digests only while Root is offline. Update the handoff with concrete results and limitations.

Publishing to npm and making changes to the person's installed daemon configuration remain operator actions. Build and verify a publishable package in-repository; install/restart only after a published or locally selected package is available.
