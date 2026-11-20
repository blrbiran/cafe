# v4-4 — Routing accuracy (#39): decisions and eval plan

Status: **decisions recorded, not implemented.** This spec is the basis for a later
`superpowers:writing-plans` batch. No routing behaviour changed in the batch that
added this file; the only code change is the expanded eval set in
`tests/routing-fixtures.ts` (`EXTRA_CASES`) and `scripts/router-eval.ts`.

## 1. What the dogfooding run found

Setup: nine Baristas with overlapping responsibilities (billing / billing-owner /
payments / aosp / docs / oncall / helper / cjk / ledger), one question set, rules
and the real LLM router.

- Rules router: 10/12 correct. Two failures:
  - `Please update the README for the billing service` → `billing-owner`, not
    `docs`: the score is a pure sum of keyword hits, so the domain word (billing)
    outweighs the action word (README/docs).
  - `ledgers are out of sync` → **broadcast to all nine** because the description
    says `ledger` (singular) and the Order says `ledgers`; `tokenize()` has no
    stemming.
- Two broadcasts made all nine Baristas answer, producing nine copies of the
  answer in one Thread.
- LLM router: semantics are better, but the same input produced different
  `mode`/`targets` across three runs (2 of 6 questions changed mode). Targets
  also came back in a different order.
- Broadcast latency: the slowest target sets the close time; a silent Barista
  can hold the Thread for `broadcastDeadlineMs` (120 s in production) even after
  a good answer arrived.

## 2. Decisions (recommended; confirm before implementation)

1. **Default to unicast.** The LLM prompt must say: prefer one owner; use
   multicast only when the question genuinely contains separable sub-tasks, and
   then give every target its own sub-question. Never use `broadcast` as the
   fallback for "not sure".
2. **Add `no_owner`.** When no Barista clearly owns the question, return
   `no_owner` instead of fanning out. The Thread records a clear reason and the
   customer can rephrase or address someone explicitly. Broadcast stays
   available through a deliberate option (e.g. `cafe ask --broadcast`), not as
   the default.
3. **Domain/capability guard (optional, phase 2).** An Order may carry
   `domain`/`capability`; a Barista declares the domains it holds. If an Order
   names a domain nobody holds, reject with `no_owner` before delivery. This is
   a new product concept and must be decided separately; do not add it merely
   as routing glue.
4. **Stemming in the rules router.** At minimum normalise English plurals
   (`-s`, `-es`, `-ies`), and give action words (`document`, `readme`, `docs`,
   `deploy`, `rotate`, …) and role/tag hits more weight than generic description
   words. Keep rules conservative: when nothing matches, return `no_owner` or
   the top-1 candidate list, not everyone.
5. **Stabilise LLM output.** Use temperature 0 where the provider supports it;
   validate the schema; de-duplicate and sort targets deterministically;
   require a sub-task for every multicast target; treat a low-confidence answer
   as `no_owner`. Cache the decision by `(body, candidate fingerprint)` so a
   retry does not re-roll the dice.
6. **Wait strategy.** Unicast unchanged. For multicast/broadcast, close on the
   first final answer plus a short grace window (`graceMs`, e.g. 2 s), mark the
   rest `skipped`, and never let a silent target hold the Thread to the
   deadline.
7. **Idempotency (later).** A `clientOrderId`/dedup window for Baristas:
   a repeated delivery returns `duplicate`, not a second execution. This is
   closer to #28/#31 than to this spec; keep it on the backlog.
8. **Observability.** Add `confidence`, `whyNot`, and `fanout` to the routing
   decision (returned by the API; the Web can keep showing the short reason).
   `cafe stats` should report average fanout and first-answer latency.

## 3. Evaluation plan

`tests/routing-fixtures.ts` now has two sets:

- `EVAL_CASES` — the original 53 labelled, mostly-clear cases. The rules test
  still asserts every `clear` case.
- `EXTRA_CASES` — overlap, morphology, multicast sub-tasks, an unknown owner,
  and a repeated input for stability. These are **not asserted** against the
  current rules router; they are reported by `npm run routing:eval`.

Next steps for the harness:

1. Make `routing:eval --repeat N` report mode/target variance per case, not
   just accuracy. A case passes stability only if every repeat has the same
   mode and the same target set (order-insensitive).
2. Add a `--min-accuracy` / `--max-variance` gate for CI.
3. Run one real-model baseline before and after the prompt/post-processing
   change (paid; needs approval) and commit the JSON under `docs/eval/`.
4. Add fixtures for "same domain, different action" and "two owners, each with
   a sub-task" once the multicast contract exists.

## 4. Open questions for the owner

- Is `no_owner` acceptable for open-ended questions that used to broadcast?
  If not, what is the default for "nobody clearly matches"?
- Does `domain` belong in the Order wire type, or is it only a routing hint?
- Should a multicast target be allowed to decline its sub-task without closing
  the whole Thread? (Probably yes: mark it `skipped`, let the others answer.)
- Do we want a decision cache across daemons, or only per daemon?

## 5. Acceptance (for the implementation batch)

- Rules: `Please update the README …` reaches `docs`; plural forms match their
  singular tag; an unknown question produces at most top-k or `no_owner`, never
  "nine answers".
- LLM: five identical runs produce the same mode and target set; multicast
  carries a sub-task per target.
- A silent target no longer holds a Thread open to the broadcast deadline.
- The eval script reports stability and fanout; CI can gate on them.
