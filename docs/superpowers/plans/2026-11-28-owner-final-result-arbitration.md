# Owner Final Result Arbitration Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Implement this alongside exact-assignment capability negotiation, and run the release tests before advertising it.

**Goal:** Make Root and peer projections converge on the owner-committed final result.

**Architecture:** Keep the original Agent reply in the journal, then commit an owner decision that references the exact source result. Adopt the decision through the same live and durable replay path. Reuse the normalized result view for authorized projections.

**Spec:** `docs/superpowers/specs/2026-11-28-owner-final-result-arbitration-design.md`, independently reviewed.

## Constraints

- Validate the exact authenticated Order, target Agent and assignment before accepting an owner decision.
- Keep raw finals unconsumed as results until the owner decision is durable. Display historical replies through the legacy read path.
- Stage missing reply proof durably. Reevaluate staged decisions when the source reply arrives or at daemon startup.
- Preserve existing ordering within a `collect: all` Order. Keep one result decision per target.

## Tasks

- [ ] Write a three-daemon TLS test. Delay the owner override to Root until Root receives the recipient's final. Assert one owner-selected result on every Host and zero answer stats for the losing Agent.
- [ ] Add `order.final-accepted` to the protocol, binding the source event and assignment. The owner commits it synchronously after validating and persisting the source reply. `order.overridden` remains the operator decision.
- [ ] Add `reply` as a pending-event dependency and trigger replay on accepted canonical replies. Validate every decision against the exact reply, target, host, assignment and owning Host before applying it.
- [ ] Use the normalized accepted result in `daemon.ts`, `followup-outcome.ts`, `store.ts`, CLI/MCP wait, Pi/OMP async result collection, and Web Conversation/Live. The original raw reply remains inspectable for audit.
- [ ] Add a durable uniqueness key for answer statistics. Rebuild target state from accepted decisions and replay eligible interrupted owner commits after startup.
- [ ] Repeat the race test with reversed delivery order, two assigned targets in `collect: all`, duplicate frames and restart. Run the full suite and verify capability negotiation before enabling it.
