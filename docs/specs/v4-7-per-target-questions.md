# v4-7 — Per-target sub-questions on a multicast Order (#39, remainder)

Status: **implemented 2026-11-24.** Drafted 2026-11-23 for the per-target
sub-question work from #39. The owner approved Q1–Q4 as recommended.

Implementation notes (2026-11-24):

- `Order.variants` and `RoutingDecision.variants` are both optional; `dispatch()`
  sends target `t` a copy of the Order with `body = variants[t] ?? body` and
  `variants` stripped, so a Barista's prompt cannot leak another target's half.
  The recorded `order.created` and `history()` keep the shared `body`.
- Rules router splits only on an explicit two-clause structure (`, and `, `, also `,
  ` and also `, `；`, `以及`), assigns each verbatim clause to its own best owner
  and only when the two point at different Agents; otherwise it multicasts the
  shared body. LLM router keeps model-provided `variants` for real multicast
  targets only (drops unknown/blank; never attaches them to a unicast).
- Eval: two cases added to `EXTRA_CASES` (a clean split expecting 2 variants, and
  a non-split conjunction expecting a shared body); the rules baseline is 67/67.

## 0. Why

Today a multicast Order sends **the same body** to every target
(`packages/daemon/src/daemon.ts` `dispatch()` → `deliver()` puts `order.body` on
each delivery). When a question has two separable owners, each gets the whole
question and tends to answer both halves; the Thread then holds two overlapping
answers, and `graceMs` closes it 2 s after whichever final answer lands first,
marking the other target `skipped`.

The owner asked for a spec first (2026-11-21, #39 questions), specifically so the
wire shape is decided rather than improvised. This document fixes only the wire
and the routing contract; it does not add a domain/capability guard (`domain` stays
out of the Order, per v4-4 §2).

## 1. Goals / non-goals

Goals:

- A multicast Order can carry a **different question per target**, so each Barista
  sees only its own half.
- The Thread, the Web UI, provenance and history keep working with no new concept
  for the Customer; a single-target Order is unchanged on the wire.
- The rules router and the LLM router can both produce sub-questions, but producing
  them stays **optional** — a router that cannot split a question still multicasts
  the shared body, exactly as today.

Non-goals: per-target *answers* (a reply is already attributed by `agentId`),
per-target deadlines, nested parallel Orders, and a new `DeliveryMode`.

## 2. Wire shape (proposed)

`Order` gains one optional field; nothing existing changes meaning:

```ts
// packages/protocol/src/index.ts
export const Order = z.object({
  // … existing fields, unchanged …
  /**
   * Optional per-target question text. Keyed by agentId. A target missing from the
   * map receives `body`, so a partial map is safe. Only meaningful when the Order
   * was routed to more than one target.
   */
  variants: z.record(z.string(), z.string()).optional(),
});
```

Why a map keyed by `agentId` rather than an array of `{ agentId, body }`:

- A target that drops out (offline between routing and delivery) needs no special
  case; the map simply has an unused key.
- Merge semantics across a relay are trivial: the Root relays the Order untouched
  (ADR-0001: it does not re-route), so there is only ever one map.
- A missing key is a defined fallback (`body`), so older daemons that strip the
  field still deliver a usable Order (see §5).

Non-fields, deliberately: no `variantOf`, no `subOrderId`, no per-variant routing
reason. The routing decision already records `targets`; `variants` only customises
the prompt text.

## 3. Delivery contract

1. **Routing** returns `targets` and, when it can, `variants`. A router that does
   not split a question returns no `variants` (current behaviour preserved).
2. **Dispatch** sends target `t` the body `variants?.[t] ?? order.body`. The
   delivery frame's `order` is a shallow copy with `body` replaced and `variants`
   removed, so a Barista never sees another target's half (no accidental leakage
   through the prompt).
3. **History** (`history()` in `daemon.ts`, used for follow-ups and recovery) records
   one `order.created` line per turn using the **shared** `body`; per-target text
   is not written into the history the next turn reads. Rationale: a follow-up goes
   to whoever answered, and that Barista already has its own variant in its own
   session; replaying every variant would bloat the prompt and leak the other half.
4. **Cancel / skip / grace** are unchanged: `graceMs` after the first final answer,
   silent targets marked `skipped`. Sub-questions do not change how a Thread closes.
5. **Provenance** is unchanged: `origin` / `via` describe the Customer, not the
   variant.

## 4. Routing sources

**Rules router.** It may split a question that matches two descriptions into two
sub-questions only when the split is mechanical and safe to explain: the input
contains an explicit two-clause structure (", and ", "；", "also ", "以及"). It then
assigns clause A to the best match for A and clause B to the best match for B, and
records `reason` naming the split. No semantic rewriting: the clause text is passed
through verbatim. If the split is not clean, the rules router multicasts the shared
body (today's behaviour).

**LLM router.** The prompt already asks for `mode` and `targets`. It gains an
optional `variants` map, validated by the same output normalisation (de-duplicate,
cap to `TOP_K`, drop unknown agentIds, drop empty strings). The model must not be
*required* to produce variants; its absence is normal.

## 5. Compatibility

- `variants` is optional and additive. The daemon builds the delivery frame itself
  (`deliverLocal()` → `notifyLocal()` / `pullAndDeliver()` → `peer.notify(Methods.orderDeliver, { order, … })`),
  so the frame never passes through a zod `Order.parse` that would strip unknown keys:
  the origin daemon decides what a target receives. §3.2 therefore has to be
  implemented in `dispatch()`/`deliver()`, not relied on from schema stripping.
- An old daemon that receives an Order with `variants` (e.g. relayed by a newer
  origin) simply ignores the field: it has no code that reads it and delivers
  `order.body`, which is today's behaviour. That is a correct, degraded delivery.
- No `PROTOCOL_VERSION` bump: the field is optional and an old daemon behaves
  identically to a router that never split the question.
- The Web UI continues to show the shared `body` on the card. This release adds
  no split indicator.

## 6. Observability

`RoutingDecision` already carries `fanout`. Add nothing new to the decision; the
eval script can assert that a two-clause case produced `mode: multicast` with two
`variants` keys, and that a one-clause case produced none. No new wire event.

## 7. Acceptance criteria

1. A multicast Order with `variants` delivers each target only its own text, and
   the target's prompt does not contain the other variant.
2. A target missing from `variants` receives `body` unchanged.
3. An old daemon (no `variants` support) still delivers `body` to every target.
4. A follow-up in a multicast Thread goes to the answering Barista(s) and does not
   replay every variant into the history prompt.
5. `npm run routing:eval` gains two cases: a clean two-clause split (expects
   multicast + 2 variants) and an ambiguous one (expects multicast, no variants);
   the rules baseline must not regress on the existing 65 scored cases.
6. No `PROTOCOL_VERSION` change; `packages/protocol` Order schema accepts an Order
   without `variants` and with a partial map.

## 8. Owner decisions

| # | Question | Approved decision |
|---|---|---|
| Q1 | Map keyed by `agentId` vs an array of `{ agentId, body }`? | **Map** — partial maps and relay are simpler; a dropped target needs no cleanup. |
| Q2 | Should the generic history record per-variant text at all? | **No** — record the shared `body`; per-target text stays in each Barista's own session (§3.3). |
| Q3 | May the rules router split by clause, or should splitting stay LLM-only? | **Rules may split only on an explicit two-clause structure**, verbatim; otherwise a shared body. Keeps the rules path explainable and free. |
| Q4 | Is a Web "拆分给 N 个 Barista" note wanted, or keep the UI silent? | **Silent for now**; a one-line note only if the UI later needs to explain different answers to one question. |

## 9. Honest boundaries

- Verified: the current multicast sends one identical body to every target; the
  delivery frame is built by the daemon and is not re-parsed through zod; the
  `PROTOCOL_VERSION` gate exists for major changes (`mismatchMessage`); the
  grace/skip path is independent of body text.
- Not verified: how often real question sets actually contain separable clauses
  (the eval plan in §7.5 is what would measure it).
- Not done: no product code changed for this spec.