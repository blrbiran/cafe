# Task Lifecycle and Event Authorization

## Intent

Keep Cafe's per-Order stream contract while making long-running delegated work truthful and recoverable. People should be able to tell whether the front-door Order ended, whether linked work is still running, and whether a final report is still expected. A Barista must not be able to change an Order it did not receive.

## Goals

- A healthy long-running Barista is not failed after the current ten-minute default solely because the Order is old.
- Missing acknowledgements and missed heartbeats still fail promptly; a separate hard lifetime still prevents an Order from remaining open forever.
- Callers can stop waiting without that local wait ending the server-side Order.
- Recovery considers every open Thread, not only the newest 1,000.
- Advertised Barista capacity matches the actual serial execution path; concurrent work must not share one logical session and be presented as independent capacity.
- Parent Order status remains ordinary Order-level status. A separate derived task status reports active children, completed children awaiting a front-door report, and reported completion.
- Only an agent that was actually delivered an Order may ack, heartbeat, reply, or decline it. Parent provenance must refer to a real parent even when `escalate` is false.
- Deadline values cannot overflow Node timers or turn a requested long timeout into an immediate failure.

## Non-goals

- Do not make Cafe a DAG, worktree, merge, or retry engine.
- Do not change parent Order status when a child opens or closes; do not copy child replies into the parent's direct-reply count.
- Do not make child completion an implicit final answer. The front door remains responsible for the final summary through `order.reported`.
- Do not complete the Host identity migration in this batch. Shared-token/self-declared-Host relay remains a release blocker requiring a separately reviewed transport design and physical/mixed-version validation.
- Do not change external dogfooding issue statuses in this batch.

## Approaches

### Deadlines

1. Keep one absolute deadline from Order creation. This is simple, but fails active work at ten minutes and conflates caller wait with task lifetime.
2. Use the existing ack and heartbeat leases for inactivity, and retain a separate hard lifetime. **Selected.** This uses current liveness events, preserves bounded Orders, and separates a live worker from a stalled one.
3. Remove server-side hard deadlines. Rejected because queued or abandoned Orders could remain open indefinitely.

### Parent task state

1. Keep only `ThreadMeta.status`. Rejected because a completed front-door Order can coexist with active children and reads as whole-task completion.
2. Derive a `taskStatus` projection from children and exact parent-Order reports while preserving `ThreadMeta.status`. **Selected.** It fits the current linked-child projection and avoids changing Order/stream semantics.
3. Keep the parent Order open until every child completes. Rejected because it changes Order-level stream termination and couples child lifecycle to a different Order aggregate.

### Capacity and recovery

1. Continue advertising configured concurrency while execution remains serial or shares session/workspace state. Rejected because routing promises capacity the worker cannot safely provide.
2. Report one active slot for a single serial Cafe session; require separate identities/directories for independent workers. **Selected for this batch.** Do not add worktree creation.
3. Build isolated workspaces and session storage per slot. Deferred as a separate feature with a larger filesystem and lifecycle boundary.

## Chosen behavior

### Order deadline and wait behavior

- `ackTimeoutMs` and the per-target heartbeat lease remain the inactivity controls. Every valid heartbeat refreshes the target lease. A missing ack or missed heartbeat fails the target with its existing specific reason.
- The daemon hard lifetime remains absolute. Default unicast hard lifetime becomes two hours; broadcast/notice retain their separately configured hard lifetime. An explicit `deadlineMs` overrides the hard lifetime for that Order.
- A hard-lifetime failure is recorded as `reason: "deadline"` for compatibility. The distinction from inactivity is the failure reason: idle failures remain `no ack` or `lost (missed heartbeats)`.
- A local CLI `--wait-timeout` stops only that client's wait. It does not cancel the Order. Preserve the existing `--timeout` cancel-on-timeout and Ctrl-C cancel behavior for compatibility; a network interruption also does not issue a server-side cancel. Explicit `cafe cancel` remains available.
- Deadline values must be integers from 1 through Node's maximum timer delay (`2_147_483_647` ms). Invalid values fail with `bad_request`; zero, negative values, and overflow values must not reach `setTimeout`.
- On restart, remaining hard lifetime is derived from the same absolute due time as before restart. If it elapsed while offline, recovery finalizes the Order immediately.

### Recovery and capacity

- Recovery pages open Threads in stable `(createdAt, threadId)` order until the page is empty. Every page uses the same latest-Order reconstruction and routing rules as current recovery.
- A serial bridge/session advertises concurrency one. Supervisor startup must not create multiple indistinguishable workers for the same identity and working directory merely because `.cafe` declares a larger concurrency. The operator receives a clear diagnostic that independent parallel workers need distinct identities and directories.
- Team members remain separate roster entries and may continue sharing a directory under current behavior; changing that rule could invalidate existing rosters and is tracked separately as #144. This batch prevents duplicate slots for one serial identity, not parallel execution by distinct members.

### Parent task status

- Add a derived, optional `taskStatus` for Threads with linked work, in detail and list projections:
  - `unknown`: linked-child view is partial; never infer completion from an incomplete view.
  - `working`: one or more non-clarification child tasks of the current `parentOrderId` are open. This takes precedence over a failed/cancelled parent Order while work remains.
  - `failed` / `cancelled`: no child remains open and the parent Order has that terminal status.
  - `awaiting_report`: a human-originated parent has at least one agent-created child task, all are closed, and the same parent Order is done without an `order.reported` event.
  - `done`: the same parent Order is done and has an `order.reported` event, or it has no linked work / only owner-created child work and completed normally.
- Persist a single `reportedOrderId` summary marker when `order.reported` is recorded. It is an indexable summary of the JSONL event, not an authority separate from that log; taskStatus itself remains derived and is not persisted.
- Root list projections use the local child index. A non-root list makes one bounded batch query to Root for parent Orders on the page, not one RPC per card. If Root is unreachable or lacks `team-child-view`, show `unknown` only for a parent with local evidence of linked work; omit taskStatus for ordinary conversations so one outage does not turn the whole Feed into unknown. Opening a specific parent detail may query Root for its complete view.
- Human clarification children keep their existing separate pending-answer UI and do not count as delegated work for `taskStatus`.
- Agent-originated parents show `working` while a child is open, then fall back to their direct Order status after children close; `awaiting_report` is human-only because `order.reported` is currently scoped to human Orders.
- Child status is correlated by the immutable parent Order recorded on the child's first turn. Follow-ups inherit that link when omitted; supplying different parent IDs on a linked Thread is rejected, and an unlinked Thread cannot be retroactively linked.
- CLI `ask`/`wait`, Web parent detail, and list cards must present `taskStatus` separately from the parent Order status. A final front-door report stays attached to the original Order and does not increment direct replies.

### Agent event authorization

- For agent-originated `order.ack`, `order.heartbeat`, `order.reply`, and `order.decline`, validate the exact `(orderId, threadId, agentId, host)` against persisted delivery evidence before recording the event.
- Reject mismatched Order/Thread pairs and non-target agents. A target on the issuing Host is authorized from its registered peer identity. A remote Host's claimed identity is still within the existing shared-token trust boundary and is not cryptographic proof; do not claim cross-Host event authentication is solved.
- A valid target reply arriving after its target lease failed but while the Order remains open may recover that target and contribute to the Order result. After the Order closes, only a final reply from a previously delivered target may be retained as a late audit event; it cannot change the terminal status, targets, or active-thread marker. Late ack, heartbeat, and decline events are ignored. Human clarification delivery keeps its existing retry-until-hard-deadline behavior.
- Track the active Order as well as the Thread for an agent. An event may clear the visible active marker only when it matches both, so a late result cannot clear a newer turn in the same Thread.
- The HTTP `replyAs` endpoint is an operator override, not an authenticated agent event. It must be visibly attributed as an operator action and must not be described as proof the named Barista authored the answer. Its caller-authentication/removal decision remains a release-gate item; this batch will not falsely treat delivery evidence alone as authentication of the HTTP caller.
- If `parentOrderId` is supplied, it must resolve to a real Order. If `parentThreadId` is also supplied, it must match that Order's Thread; `parentThreadId` without `parentOrderId` is rejected. A lone valid `parentOrderId` remains provenance only and does not create a linked task.
- A linked child Thread belongs to the parent Order on its first turn. Follow-up Orders keep that relationship when parent fields are omitted; a different parent or retroactive link is rejected.
- Agent-created linked children require the registered peer identity plus exact persisted delivery proof for the parent Order. Human CLI requests may link a child only with the original human Order-owner credential; the child is attributed as human-originated, not as a Barista delegation. MCP keeps its existing `origin: "agent"` behavior and cannot use the human-owner path; without a registered Barista peer, an MCP request that tries to create an agent-linked child fails with an actionable error. A caller-supplied `via` value is never sufficient proof.
- A follow-up on an already linked child Thread inherits its original parent link only when the caller is the authenticated creator of that child, an agent delivered the previous child Order, or the original parent human owner. The follow-up cannot change or remove the parent link. Thread ID possession alone does not authorize a new turn that changes parent task status.
- The parent fields do not by themselves make a sub-Thread: `escalate: true` remains the only switch that creates a sub-Thread from an agent delegation. Preserve the existing legacy meaning of `parentOrderId` when it is supplied alone.
- Heartbeats received after an Order has closed are ignored for durable history and state.

## Authorization boundary and release gate

This batch's event checks prevent non-target agents from mutating an Order based on current delivery records. They do not establish cryptographic Host identity. Before a real second-Host or mixed-version release trial, independently authenticated Host identity and event-source validation must cover relay, report, cancel, and acknowledgement paths. HTTP caller identity, cancellation ownership, caller-scoped idempotency, provenance fields, and request-body limits remain separate open hardening items unless explicitly implemented by the execution plan.

## Acceptance criteria

1. An acked worker that heartbeats and replies after the previous ten-minute threshold ends `done`; an agent that stops heartbeating still fails by the lease timeout.
2. An explicit short hard deadline still fails the Order; a hard-deadline event is distinguishable from ack/heartbeat loss by its reason.
3. Zero, negative, fractional, and over-limit `deadlineMs` values fail with `bad_request`; they never become immediate timeouts or overflow Node timers.
4. `cafe ask --wait-timeout` leaves the daemon Order open and later replies remain visible; existing `--timeout` and Ctrl-C cancel behavior remain unchanged.
5. Recovery restores more than 1,000 open Orders, preserving their Order IDs and absolute deadlines.
6. A serial bridge reports concurrency one. A configuration that would spawn duplicate same-identity/same-directory workers either runs one worker with a clear warning or fails before spawning; it does not claim unsafe parallel capacity.
7. Parent detail/list projections report `working`, `awaiting_report`, `done`, `failed`, `cancelled`, or `unknown` from children of the exact parent Order and its report event, while the underlying Order status and direct reply count remain unchanged.
8. A follow-up on a linked child Thread is accepted only from its authenticated creator, a prior delivered target, or the parent human owner; thread ID alone or a changed parent link is insufficient. MCP retains agent attribution and cannot use human ownership to bypass the registered peer check.
9. A delivered target may ack, heartbeat, reply, and decline. A registered non-target cannot alter the Order. A late final reply from a delivered target never reopens a closed Order or clears a newer active Order.
10. A forged/nonexistent parent ID or mismatched parent Thread is rejected; a valid legacy parent ID remains provenance only; a linked task additionally requires delivery proof and is not treated as escalation unless `escalate: true`.
11. The HTTP `replyAs` path is labeled as an operator override and is not presented as an authenticated Barista reply. Caller authentication remains a release gate.
12. No production Root restart, npm publication, external ledger edit, or physical second-Host claim is part of local code verification.
