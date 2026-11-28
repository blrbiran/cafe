# TUI roster compatibility (#224 and #225)

## Goal

A team can sync its roster, register its terminals, and start supported headless members when its TUI orchestrator works at the roster root and its other TUI members work in separate in-repository worktrees. Upgrades preserve the roster file and keep terminals connected when only an ignored TUI `access` field changes.

## Approaches

- Default to a narrow exception for the root TUI orchestrator and same-roster TUI descendants. This supports the existing layout without an extra setup step. The user selected this approach.
- Require a Host-local opt-in before allowing the same nesting. It adds an operator decision and a migration step to an existing layout.

## Directory rule

Allow an overlap between the current roster's root TUI orchestrator and another current TUI member whose canonical directory is a strict descendant of that root. Apply the pairwise rule regardless of member order, including when bootstrapping saved authoritative rosters. The pair must come from the same roster being prepared. Continue to reject same-directory TUI members, overlaps between other TUI members, cross-roster overlaps, and conflicts with managed writers or retiring worker groups. When a terminal is removed, keep its stale reservation until explicit release. An unchanged TUI can retain an already committed overlap so that removing a nested member and syncing again both work. New or moved scopes cannot overlap an existing stale reservation. Keep the existing path-grant, canonical directory, and launch checks. The terminal controls actual TUI permissions.

## Launch identity

Treat legacy TUI `access` as ignored at both parsing and hashing boundaries. Retain the existing null slot in the hash so fingerprints from supported, already-normalized TUI rosters stay stable. The original shipped code that introduced TUI launch hashes already rejected TUI `access`, so the synthetic legacy hash from the ledger does not establish a released upgrade path. Preserve the committed-hash check and verify that genuine launch changes still require a terminal reload.

## Acceptance

- Exercise `team sync`, a selected supported headless start, and TUI registration with a supervisor enabled. Test first boot with a saved roster and no write-scope file in a scratch home.
- Exercise both member orders and retain the rejection cases for unrelated overlaps, including stale reservations. Confirm that roster bytes stay intact.
- Verify hash equality for TUI declarations with and without `access`, and verify that a live TUI survives sync and can reconnect using its startup hash. Check rejection after a real directory change.
- Keep the Pi/OMP production read-only gate and Root roster protocol unchanged. Validate real runtime behavior separately.

This design amends the TUI overlap and access-hash rules in the [worker permissions design](2026-11-27-team-worker-permissions-design.md) and specifies how to preserve the [upgrade safeguards](2026-11-28-dogfooding-upgrade-safeguards-design.md).
