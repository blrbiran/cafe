# Conversation outcomes after failed follow-ups

Issues #211 and #212. The Feed and search results must tell a reader both that a conversation has an answer and that their latest follow-up could not be delivered. The detail timeline continues to show which turn the answer belongs to.

## Approach

Add optional bounded historical answer metadata alongside current-Order metadata. Keep current `status`, `replies`, `targetStates`, and their consumers tied to the exact Order. Preserving old replies in `replies` would misattribute the answer to the new Order and affect routing and tracking. Reading full event histories on every Feed request would make list latency depend on the size of those histories. Use the same display interpretation in Feed and search, with detail retaining its per-turn outcomes.

## Behavior

- After a previous final answer and an unroutable follow-up, show `Answered · Follow-up not delivered` (`已回答 · 追问未送达`) and a snippet of the last available answer. Include it under Answered. A first unanswered Order stays under Unanswered.
- Only classify a follow-up as not delivered when the journal records a failed close and the route had no targets. A delivered turn that times out keeps its own outcome. Working, cancelled, and task-status messages retain priority. Keep answer-source labeling for operator notes.
- An eligible prior answer is the last final reply appended before that Order's `done` close, in the highest earlier turn containing such a reply. Local append order breaks ties and excludes post-close audit replies, including any remote reply first observed after close. Capture the Order ID, turn, agent ID, optional address and operator source, and at most 300 UTF-16 code units without cutting a surrogate pair. Mark truncated text and put the ellipsis in the view. Replay of an older turn cannot overwrite a newer turn's answer.
- The failed attempt requires an explicit empty `order.routed` decision and a failed close for the exact current follow-up Order. Search uses the same badge and filter as Feed and shows a historical answer preview on question-only matches. If search already shows a snippet for that answer's Order, omit the duplicate preview. Detail keeps per-turn outcomes and audit content. Suppress duration on the historical-answer card.
- Legacy recovery uses background batches with resumable progress. Process the journal incrementally in append order, yield between batches, and queue unavailable journals for later retry so they do not block other Threads. Keep historical metadata and progress together in durable storage. Check journal length again on startup to repair an append committed just before a crash. Re-read the live meta when saving and merge only the derived historical fields. A page loaded before recovery reflects the update on its next normal refresh. Do not add a per-row journal lookup to list or indexed search.

## Acceptance

Exercise a successful first turn then an offline follow-up. Check the Feed, search, detail and raw exact-Order status after restart. Repeat with legacy persisted data, a long reply, a first-turn failure, an operator override, a dispatched timeout, and a late reply. Avoid a list-time full journal scan. Verify both locales and keep unchanged the semantics of digest counts for the current Order.
