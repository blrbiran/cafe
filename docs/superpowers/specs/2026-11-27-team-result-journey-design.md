# Team result journey

The acceptance path for #120, #121, #194, #197, #199, #208 and #210 starts with a person asking a team and ends with that person reading the result in the original conversation. Existing Order status, linked work and delivery authority remain the foundation.

## Approaches

Automatically copying child answers to the parent could expose unfinished or contradictory results as the team's answer. Using a link alone would still make the requester search for the outcome. Keep an explicit report by the assigned front door and show progress and an entry to linked work in the parent, including after a clarification answer.

## Behavior

- Pi and OMP use their registered extension tools for linked delegation and reports. Client help describes available tools by runtime. A separate CLI/MCP process without the original Agent identity fails with an actionable message when asked to act as that Agent. Exact parent identifiers identify the task but confer no authority. A verified human owner retains the existing path for linking their own Orders.
- The parent separates confirmed receipt, work under way, a request for clarification, and waiting for a result report. An unanswered clarification remains visibly pending. After the answer is accepted, the linked continuation is reachable directly from the parent. Finishing it may move the parent to waiting for a report. The report is attributable to an authorized recipient of the exact parent Order and is visible from the original conversation.
- If a worker process restarts, it can resume reporting only through a durable identity that proves the original assignment. The existing process-local resume proof covers reconnects by that process. Implement restart continuity after Task 4's persistent Agent receipt and identity binding. A worker claiming a similar display name never inherits report rights.
- Keep the hard deadline distinction from #181. Until a runtime exposes a separate execution-start signal, an acknowledgement indicates receipt. CLI may be rerun after the report and does not need a new journey-level stream.
- In a normal team unicast, the front door is the original protected recipient. Preserve existing rules for multicast and fallback. A developer assigned only a child may report to the front door through that child. The developer cannot report against the human grandparent solely by being linked to it.
- An unanswered clarification has an explicit pending question in the parent UI. The parent may have a closed Order while it still needs an answer. An accepted continuation participates in parent work projection for the exact parent Order. While it is open show work underway. When it closes show waiting for report if the original parent was successful and remains unreported. A failed or cancelled original parent retains its terminal state. Partial child visibility cannot establish completion. A report for an earlier parent Order cannot finish the current Order.

## Acceptance

Use isolated agents and one scratch Root first. Exercise direct final answers, developer work plus a front-door report, and clarification before answer, after answer, after continuation and after report. Repeat CLI wait at each relevant state and verify the parent page has the report. Cover same-process reconnect and repeated identical reports. Reject a distinct Agent with the same display name. Cross-process report recovery is gated by Host and Caller Authorization Task 4. Test both restart before first report and restart after a committed report. Authenticated cross-Host acceptance depends on Host and Caller Authorization Tasks 3–4 and uses Task 5's transport boundary for any remote HTTP caller credentials. Real Pi/OMP smoke is a separate acceptance case using a supported access mode.
