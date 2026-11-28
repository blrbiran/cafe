# Team and observer runtime guidance

## User-visible behavior

The assigned front door can explicitly submit its active Order's final task result from Pi/OMP. The tool uses the registered Agent session and the active Order's identifiers. It posts the final answer so the normal Order reaches its terminal state, then records the result on that Order. The tool reports submitted, waiting for confirmation, or failed truthfully. If a front door replied early, the existing exact-Order reporting tool remains available after the conversation round ends. The human sees the front door's final summary in the original conversation. Child answers remain available separately. Parent and child timing has no authority to classify a reply as a report.

The standalone CLI and MCP continue as caller surfaces. A CLI human owner can link work they own. Standalone MCP documents the capabilities of a Customer and keeps provenance-only IDs distinct from a linked Order. Error text and playbook route Agents to their registered runtime tools. An operator override stays a separately attributed action.

Pi/OMP observers automatically inspect terminal failures from their channel digests. Ordinary activity is displayed without starting a model turn. Failure notifications coalesce by Thread and closed time across channels and publisher changes. Wait until the runtime is idle and service explicit Orders first. At most one automatic observation turn starts in any 60-second window per extension session. Keep a bounded queue and process it at the end of an active turn or on a timer. Only closed failures are triggers in this increment. Stalled duration and waiting-for-report notifications require richer progress evidence than the current digest carries.

## Approaches

Use the explicit final-result tool so an Agent can reliably communicate its intent. An inferred result based on timestamps could misidentify a status update. The existing late report provides recovery after a first answer. Keep observation rules inside Pi/OMP where turn state is available. The digest remains suitable for other clients to read without automatically executing a model turn.

## Review decisions

- `cafe_reply({ finalResult: true, text })` uses the current, observed, unfrozen original human Order in Pi/OMP. It excludes explicit report IDs and attachments. Track one in-session finalization attempt per Order and suppress automatic replies once the explicit reply succeeds. If report confirmation fails after the reply, identify the committed reply and give the exact IDs needed to retry the report. Report retries use the same text and original IDs. An extension restart can use the existing explicit reporting form if it can prove the original Agent identity.
- New digests include the exact failed Order ID. Only entries with an Order ID and terminal failure qualify for automatic observation. Older digests remain readable. Bound the pending and recent sets and deduplicate by Order ID. An observation message asks the Agent to inspect and summarize failures. It does not grant authority to intervene.
- Keep standalone caller behavior compatible. Remove instructions implying the CLI or stdio MCP can act as a Barista. Label parent-only input as provenance and explain what it does.
- A lost reply acknowledgement leaves the reply outcome unknown. The extension suppresses another final reply and gives the exact IDs for checking the result and retrying the report. An explicit rejection before a write preserves the existing automatic reply path. Slow close confirmation can still require a separate exact-ID report.
- The current observer reads the bounded channel digest. Coverage of entries omitted by the digest and durable automatic result reporting are follow-up work.

## Acceptance

Exercise a report from an active Order with the regular tool and validate exact Order identity, result projection, and no duplicate automatic final reply at turn end. Cover the existing late-report path. Verify actionable errors for a standalone caller requesting Agent delegation. Observe no wake-up for normal activity, one wake-up for multiple failures, no interruption of a running Order, and no duplicate wake-up for an already seen failure. Use the isolated test harness for these cases.
