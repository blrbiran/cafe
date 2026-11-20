# v4-4 — Routing accuracy (#39): decisions and eval plan

Status: **implemented for rules + LLM policy; domain guard deferred.** The rules
router now stems English plurals, weights specific/action words, fans out to at
most `TOP_K` (`3`) when nobody clearly owns the question, multicasts a
separable two-owner question, and broadcasts only when the customer explicitly
asks (`cafe ask --broadcast`, MCP `broadcast: true`, the Web composer checkbox).
The LLM router has a rewritten prompt, output normalisation (de-duplicate, cap,
order by candidate list, downgrade an unrequested broadcast) and a bounded
decision cache. Multicast/broadcast Threads close `graceMs` (2 s) after the
first final answer and mark silent targets `skipped`. The eval script reports
mode/target variance across `--repeat` and can gate on accuracy/variance.

`domain` is **not** in the Order wire this round: it is a new product concept
(Barista-held capabilities and an admission check), not routing glue.

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

## 2. Decisions (implemented)

1. **Default to unicast.** The LLM prompt says: prefer one owner; use
   multicast only when the question genuinely contains separable sub-tasks, and
   then give every target its own part. Never use `broadcast` as the fallback
   for "not sure".
2. **Bounded top-k, not `no_owner`.** When no Barista clearly owns the
   question, the rules and LLM routers ask at most `TOP_K` (3) candidates.
   Broadcast stays available through a deliberate option (`cafe ask
   --broadcast`, MCP `broadcast: true`, the Web "Ask everyone" checkbox), not
   as the default. (`no_owner` remains only the empty-candidate case.)
3. **Domain/capability guard (deferred).** An Order may later carry
   `domain`/`capability`; a Barista would declare the domains it holds. This is
   a new product concept and must be decided separately; it is **not** in the
   wire this round.
4. **Stemming and intent in the rules router.** English plurals are normalised
   (`-s`, `-es`, `-ies`; conservative about `-ss`, `-us`, `-is`, `-ws`); longer
   tokens are weighted as more specific; a small action/artifact lexicon
   (`readme`, `documentation`, `deploy`, `rotate`, …) beats a domain word.
5. **Stabilise LLM output.** Targets are validated, de-duplicated, capped at
   `TOP_K`, ordered by the candidate list, and an unrequested `broadcast` is
   downgraded to multicast. A successful decision is cached by
   `(body, candidate fingerprint)` (bounded, per daemon). Temperature is not
   exposed by the pi session API; the cache and deterministic post-processing
   cover the observable variance instead.
6. **Wait strategy.** Unicast unchanged. For multicast/broadcast, after the
   first final answer a `graceMs` window (default 2 s; tests can shorten it)
   closes the Thread and marks the remaining targets `skipped` through an
   `order.declined` with `unavailable: true`. A silent target no longer holds
   the Thread to `broadcastDeadlineMs`.
7. **Idempotency (later).** A `clientOrderId`/dedup window for Baristas:
   a repeated delivery returns `duplicate`, not a second execution. This is
   closer to #28/#31 than to this spec; keep it on the backlog.
8. **Observability.** `cafe stats` still reports outcomes; `confidence`,
   `whyNot` and average fanout are not exposed yet.

## 3. Evaluation plan

`tests/routing-fixtures.ts` now has two sets:

- `EVAL_CASES` — the original 53 labelled, mostly-clear cases. The rules test
  still asserts every `clear` case.
- `EXTRA_CASES` — overlap, morphology, multicast, top-k, and a repeated input
  for stability. The rules test asserts the routing-shape cases; the script
  reports them all.

Harness (implemented):

1. `routing:eval --repeat N` reports cases whose mode or target set varies
   across repeats (`unstable`), in both text and `--json`.
2. `--min-accuracy <0..1>` and `--max-unstable <n>` set a non-zero exit code,
   so CI can gate on them.
3. A real-model baseline before/after the prompt change is still pending (paid;
   needs approval). Commit its JSON under `docs/eval/`.
4. "Same domain, different action" and "two owners, each with a sub-task" have
   fixtures; the multicast *sub-task text* is not sent to each target yet (the
   rules router cannot split the question, and the LLM output has no `parts`
   field).

## 4. Open questions for the owner (answered)

- **Default when nobody matches:** bounded top-k (`TOP_K = 3`), not `no_owner`
  and not broadcast. `no_owner` remains only when there are no eligible
  Baristas.
- **`domain` in the wire:** no this round. It is a separate product concept
  (declared capabilities + admission check); add its own spec before touching
  the Order type.
- **Multicast decline:** one target's decline is `done` for that target and the
  others continue; silent targets are marked `skipped` after `graceMs`. The
  Thread closes when every target is resolved.
- **Decision cache:** per daemon, bounded to 200 entries. A cross-daemon cache
  would need invalidation on registry changes and is not worth it yet.

## 5. Acceptance

- Rules: `Please update the README …` reaches `docs`; plural forms match their
  singular tag; an unknown question produces at most `TOP_K` answers, never
  "nine answers". (`npm run routing:eval`: 63/63.)
- LLM: output is de-duplicated, capped and ordered; an unrequested broadcast is
  downgraded; identical `(body, candidates)` reuses a cached decision.
- A silent target no longer holds a Thread open to the broadcast deadline
  (`tests/routing-grace.test.ts`).
- The eval script reports stability and can gate on it.
