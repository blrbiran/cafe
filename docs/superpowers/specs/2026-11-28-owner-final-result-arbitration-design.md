# Owner Final Result Arbitration

Host authorization gives each Order one owning Host. Its Order journal decides which final result wins for each target. A mirror currently projects an Agent final as soon as it arrives. If the owner accepted an operator override first, network arrival order can still cause the mirror to show both results and count a result the owner did not accept.

## Approaches

- Remove a result from the mirror whenever an owner override arrives. This can repair a snapshot but leaves already-published history and statistics dependent on arrival order.
- Carry a durable decision from the Order owner. Mirrors keep raw Agent finals for audit and apply one owner decision for each target. Use this approach so every mirror converges without exporting owner credentials or rewriting a sender's event.

## Contract

- Add `order.final-accepted` with `targetAgentId`, `replyEventId` and the exact `assignmentId` for an Agent result. It is authored by the Order-owning Host. The event `order.overridden` with `final: true` already serves as the owner decision for operator results. At the owner, commit the decision before publishing its effect or closing the Order. Existing ordering of direct replies versus operator decisions applies within one synchronous owner transition.
- The decision references an append-only `order.replied` record. A receiver waits durably for any missing canonical Order, assignment, or source reply. It applies the owner decision exactly once. The reply belongs to the same Thread, Order, Agent and assignment, and its author matches the assigned Host. The owner decision and the original Agent payload remain distinct in audit history.
- The terminal decision is the source for preview, exact-Order status, follow-up responders, statistics and final result notifications. Raw Agent finals with no decision remain audit-only. Interim notes keep their existing behavior. Historical replies with no authenticated assignment retain their legacy display and cannot prove a decision under this contract.
- Restart from the owner journal. A successful synchronous JSONL append is the process-crash commit boundary. Power loss and filesystem failure are outside this guarantee. An accepted result remains final if the process stops after its acceptance event. An unaccepted raw reply may be reevaluated only while the exact target and Order are still eligible. Use the stable reply event ID for journal replay and notification deduplication, and a durable uniqueness constraint for statistics.
- Enable this change with the complete negotiated assignment contract. Old peers retain the existing legacy mode during migration. `caller-auth-v1` remains reserved until cancellation, replacement and override pass the release checks.

## Acceptance

1. An operator wins on the child owner while an Agent reply arrives at Root first. After both arrive in either order, the Root and owner show one operator result and no Agent answer statistic for that target.
2. An Agent result wins first. An override is rejected and the winning result is counted once across duplicate frames and recovery.
3. Backfill and direct-link replay preserve the same result. A malformed decision does not advance the target. A valid decision received before its proof stays pending across restart and applies exactly once.
4. With `collect: all`, accept one decision per target and keep other targets open. Show the operator label only for the targets actually overridden.
