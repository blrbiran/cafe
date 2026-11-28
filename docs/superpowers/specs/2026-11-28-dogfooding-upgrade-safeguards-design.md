# Dogfooding upgrade safeguards

## Intended behavior

- **#223.** Fresh Agent-authored acknowledgements, heartbeats, replies, declines and reports on authenticated Host links require the exact assignment and delivery evidence. The target Agent and Host, actor principal and Thread/Order match the recorded assignment. Missing prerequisites for events with assignment IDs use the existing pending journal. Keep historical journal reads and previously authenticated pending replay. Root and direct-link ingestion use the same check. A trusted Root relay retains the author Host recorded by Root. Local registered legacy clients can omit the assignment ID when the receiving daemon has their exact local delivery record. Carry that assignment ID into the shared event. Coordinator-generated skips, failures and operator notes retain their separate authority rules. This checkpoint addresses Agent results. The broader relay negotiation and owner-event authority acceptance in the Host authorization design remains a release gate.
- **#218.** A valid legacy TUI `access` declaration is accepted as input and stripped from the effective roster. The original YAML is preserved. Doctor and sync guidance name affected members and explain that the terminal controls their permissions. Team status identifies TUI members as terminal-managed. Headless `access` keeps its current meaning. The daemon still enforces canonical TUI working directory and launch binding. Keep hard errors for malformed YAML and invalid member settings.
- **#203.** `init --force` can replace a valid standalone identity after successfully creating a unique, exclusive, byte-for-byte sibling backup. The resulting CLI output names the backup. Team, malformed, symlink and non-regular files are refused. Candidate validation and the existing concurrent-change guard apply before replacement. Doctor continues to suggest repair in place for invalid files.
- **#221.** Resolve bare Pi/OMP runtime names using the daemon PATH. Distinguish missing executable from unavailable isolation verification, with guidance for each. Production read-only Pi/OMP remains blocked until a real, packaged preflight can prove both the full permitted tool registry and rejection of an actual write invocation. A fixture protocol or a matching command listing alone is insufficient. Scratch tests can inject an isolation probe. This batch does not change write grants or enable a production probe.

## Approaches

- Enforce Agent result authority at authenticated ingress using durable evidence. A live registry check alone loses the identity evidence needed after disconnect or restart.
- Normalize the old TUI field at the YAML input boundary. A migration command could clean the file but would leave whole teams unavailable until users run it.
- Keep explicit standalone replacement with a backup. Removing replacement would simplify the contract but remove a supported recovery action.
- Improve the runtime lookup and user diagnosis now. Real runtime support requires an independent demonstration of effective isolation before enabling that path.

## Review decisions

- Use the existing authenticated delivery record to validate previously issued reports without an assignment ID. Report retries keep the original event and can sync after a worker disconnects. Heartbeats require available evidence and do not enter the pending journal. Mixed-daemon backfill, relay negotiation, and pending-journal retirement require additional acceptance before rollout.
- Reader compatibility applies to all YAML consumers. Changing an ignored TUI field leaves its effective launch hash unchanged. Older readers require an upgrade or removal of the obsolete field.
- Backup creation uses private permissions and exclusive creation. Back up the same bytes parsed as the standalone identity. If replacement fails after backup, retain the copy and report its path.
- Resolve the binary using the supervisor's environment and make a failed preflight visible in normal worker status. A launch request can return while a worker is starting.

## Acceptance

Existing local and cross-Host positive receipt, reply, and reporting paths remain green. Add a positive compatibility case for a registered legacy client whose daemon can supply the exact assignment. Cover the authenticated precondition as a local validation contract. Verify the TUI and headless fields together, Doctor output, original file bytes, repeated replacements and distinct backups, and PATH lookup with the production gate disabled. Run the isolated suite and core and Web TypeScript checks. Track physical second Host and packaged runtime verification separately.
