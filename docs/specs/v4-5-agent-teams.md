# v4-5 — Agent teams: orchestration semantics (#71, #72)

Status: **superseded by `v4-11-agent-teams.md` (2026-11-25).** Kept for the
original #72 decision record and the eval fixtures; implement from v4-11.
Drafted 2026-11-23 from the dogfooding ledger entries #71/#72. The owner chose to
record the decisions and add offline eval cases before touching routing or the
wire, because every option here changes how Orders are delivered.

## 0. Scope

Two separate questions, deliberately not merged (the owner's call):

- **Teams (#71)** — `.cafe` gains a team definition and per-agent responsibilities,
  and a Team has its own channel so internal traffic does not pollute the default
  channel. `team` = membership, `channel` = message scope. A channel is **not** a
  security boundary.
- **Orchestration (#72)** — when several agents work on one Thread, what the daemon
  guarantees: can a member ask its leader back, can one Thread hold parallel
  sub-orders, and does "collect N answers" exist.

This spec only covers #72. #71 needs a design pass (Web channel switching, the
responsibility field, `.cafe` schema) and lands after.

## 1. What the code does today

| Behaviour | Where |
|---|---|
| First final answer arms a 2 s `graceMs` window; the rest are marked `skipped` | `daemon.ts` (`finishGrace`), `timing.graceMs = 2_000` |
| `eligible()` excludes `from.id` **and the whole `chain`**, so a sub-agent can never ask its leader | `daemon.ts` (`eligible`) |
| One open Order per Thread (`thread_busy`) | `daemon.ts` (`createOrder`) |
| Fan-out capped at `TOP_K = 3`; depth capped at `MAX_ORDER_DEPTH = 4` | `router.ts`, `protocol/index.ts` |
| A unicast Order now has an upper bound (10 min) | `timing.unicastDeadlineMs`, this batch (#60) |

The team loop breaks in three places: a developer cannot ask its orchestrator a
clarifying question (`targets=0`, reported as "no online barista"), three pieces
of work cannot run in parallel on one Thread, and a broadcast ends 2 s after the
first answer instead of after everyone delivers.

## 2. Decisions

### D1 — A member may ask its direct leader back (escalate)

`eligible()` keeps excluding the sender and the rest of the chain, **except the
Order's direct parent's sender** (`order.parentOrderId` → that Order's `from.id`).
That is the clarify-the-task case; every other member of the chain stays excluded,
so an escalate cannot loop.

When a target set still comes back empty, the failure names the reason
(`excluded_by_chain`, `offline`, `no_candidates`) instead of "no online barista
at …", so an agent does not read a routing rule as "my leader is down".

Wire: **no change.** `parentOrderId` already exists.

### D2 — Parallel sub-orders on one Thread, behind an explicit opt-in

A Thread keeps the one-open-Order rule by default: that is what makes follow-ups
unambiguous and stops two people accidentally talking over each other.

A sub-order (`parentOrderId` set) may coexist with its parent and siblings **only
when the customer asked for it** (`Order.parallel: true`). The rule then is:
concurrent Orders in a Thread are allowed while they all share a `parentOrderId`
or carry `parallel`; a plain follow-up on a Thread that already has an open Order
still fails with `thread_busy` plus the `cafe cancel` / `replace` escape.

Wire: one optional boolean `parallel`. Absent = today's behaviour.

### D3 — Collection: `any` by default, `all` on request

`Order.collect?: "any" | "all"` (default `any`):

- `any` — today's behaviour: first final answer wins, 2 s grace, the rest are
  `skipped`.
- `all` — the Thread stays open until **every** target is `done`/`failed` or the
  Order's deadline fires. A target that answers early is simply `done`; silence
  is not success. The deadline (`unicastDeadlineMs` for one target,
  `broadcastDeadlineMs` otherwise) is the backstop, not the normal path.

`collect` and `graceMs` are mutually exclusive by construction: `all` never arms
the grace timer.

Wire: one optional string enum. Absent = `any`, so an old Daemon and an old
customer keep working.

### D4 — `TOP_K` and `MAX_ORDER_DEPTH` stay product constants

No per-team override this round. An explicit `broadcast` already ignores
`TOP_K`; a team that needs five parallel developers sends five sub-orders with
`parallel`, which is explicit and visible in the Thread. A configurable `TOP_K`
would let one team's setting silently change routing for everyone on that Daemon.

## 3. Evaluation plan

`tests/routing-fixtures.ts` gains `TEAM_CASES` — shape assertions the rules router
can answer offline today, plus the cases that only become answerable once D1/D2/D3
land (marked `blocked: "<decision>"`, so the eval reports them without failing the
suite):

1. A two-part task with two owners is a multicast (already passes).
2. A bare escalate (`targets` would be empty today) is expected to reach the
   parent's sender — blocked on D1.
3. Three parallel sub-orders on one Thread — blocked on D2.
4. `collect: all` with two slow targets keeps the Thread open — blocked on D3.

`npm run routing:eval` prints blocked cases as `blocked` rather than `miss`, so
the numbers before and after implementation are comparable.

## 4. Acceptance (when implemented)

- A sub-order can ask its direct leader and gets an answer; asking anyone else in
  the chain still yields `excluded_by_chain`, with that reason in the error.
- With `parallel`, three sub-orders run on one Thread and each gets its own
  reply; without it, `thread_busy` still points at `cafe cancel` / `replace`.
- With `collect: all`, two targets that answer 4 s apart both land in the Thread
  and it closes after the second (or the deadline), never after the first + 2 s.
- An old customer that sends neither field sees byte-identical behaviour.
- `routing:eval` shows the team cases moving from `blocked` to passing.

## 5. Open questions

1. **Escalate depth.** D1 allows the direct leader only. Two levels up (a
   developer asking the architect who asked the orchestrator) stays excluded
   unless a real team asks for it — reopening this means a third wire field.
2. **`collect: all` and a dead member.** `all` waits for the deadline when one
   target never answers; that is intentional (silence is not success), but the
   Web UI must show *which* member is still silent, otherwise it looks stuck.
3. **`parallel` and routing.** Each sub-order still routes on its own; a team
   that wants "these five developers" should use explicit addresses or a
   broadcast, not rely on the LLM picking five.