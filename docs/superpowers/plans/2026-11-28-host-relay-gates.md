# Host Relay Gates Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline verification. Keep production capability flags reserved until rollout acceptance.

**Goal:** Verify owner-only lifecycle events and negotiate delivery without sending private payloads over unsupported routes.

**Architecture:** The journal and pending replay validate the canonical owner. Transport preflight and requests use the live authenticated route and exact Agent registration.

**Tech Stack:** TypeScript, SQLite, Vitest, TLS WebSocket RPC.

**Spec:** [Host relay gates](../specs/2026-11-28-host-relay-gates-design.md), reviewed independently before this plan.

## Global Constraints

Keep plaintext fixtures and known historical journals readable. Preserve exact attested clarification answers and current compatibility transport. Hold production assignment capabilities until secure delivery readiness is verified.

## Review Focus

Early close, reordered final acceptance, recipient dispatch failure, authenticated direct backfill, changed peer or Agent capability, and unsupported replacement before commit.

### Task 1: Owner event authority

- [ ] Add tests in `tests/host-assignment-relay.test.ts` for a legitimate owner route and close presented ahead of creation, replay, and authenticated recipient dispatch failure. Run the focused tests before implementation.
- [ ] In `packages/daemon/src/daemon.ts`, validate owner-scoped lifecycle events by exact Order authority. Keep the exception for successful owner-attested clarification. Preserve terminal closure on replay. Make the recipient delivery-failure event exact to the assignment and integrate it with tracking and projections.
- [ ] Run focused authority tests plus TLS child, replacement, clarification, and e2e suites.

### Task 2: Strict relay negotiation

- [ ] Reserve both flags in `packages/protocol/src/version.ts`. Add fixture-only strict support in the daemon options. Test incompatible Host or Agent, changed connections, and capable Root and direct routes.
- [ ] Preflight live peers and Agent readiness with body-free RPC, validate the exact owner and target on strict delivery, acknowledge each hop, and never fall back to legacy transport for an already committed strict assignment. Store the mode with canonical assignment evidence.
- [ ] Preflight strict replacement before journal commit. Recheck original Order immediately before commit. Preserve ordinary local traffic and compatibility mode throughout.
- [ ] Run mixed-build, replacement, direct replay, and full suite checks before integration.
