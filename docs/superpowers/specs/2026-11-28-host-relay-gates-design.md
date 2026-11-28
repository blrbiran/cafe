# Host Relay Gates

This checkpoint completes the next defensive layer of the [assignment privacy contract](2026-11-28-assignment-privacy-and-authority-design.md). It keeps the capabilities reserved pending the physical Host and mixed-build acceptance pass. Plaintext development networks and historical journals remain readable.

## Lifecycle authority

Authenticated route, cancellation, closure, assignment, replacement, skip, override, and final acceptance events require the original Order owner's bound Host ID and Host name. An event ahead of its canonical creation enters the existing pending journal. Replay uses the authority recorded at admission and applies valid transitions to active local tracking. Closure is terminal. A proven owner final acceptance issued before closure may project after a delayed source reply arrives. Recheck closure after relay proof hydration. Creation on an existing Thread retains its original owner, with the existing owner-attested clarification path as the exception. Strict recipients can report delivery failure through `order.dispatch-failed` with an exact assignment reference. Compatibility peers use `order.failed` for recipient-side failures. Verify its exact assignment reference when supplied and require a unique matching public assignment for the sender and Agent when it is absent. Other `order.failed` events require the owner. Historical journals remain readable.

A strict relay sends an acknowledged request on each hop. Before a replacement commit, check the selected paths without carrying private content, then recheck that the previous Order is current and open. Repeat authorization at send and at final Agent delivery. The tracked owner settles delivery failure only for its still-pending assignment. Retries keep the mode of the committed assignment across restart.

## Capability negotiation

The existing `order/relay` method is a compatibility path for already deployed Host Auth builds. The negotiated route uses the reserved `assignment-relay-v1` on every authenticated hop and a distinct RPC method for the private payload. Queue support is derived on the recipient from its actual durable Agent registration and is advertised as `assignment-receipt-v1` only with the strict Host contract. The Root maps Host capabilities to admitted live peers and selects the actual recipient from its registry. A child considers a Root-provided capability snapshot only on its active authenticated uplink. Direct delivery checks hello from the actual authenticated link. Canonical target ID, reference verification, and exact local durable registration are required before exposing the payload to an Agent. Unsupported or changed routes return a visible failure. A strict transfer must never retry using the compatibility method.

The reserved production names stay out of the normal feature list. Use a test-only RunOptions fixture to exercise strict and mixed-version routes. This checkpoint does not treat a successful compatibility relay as evidence that the strict route is ready for rollout.

## Acceptance

Use scratch TLS networks and normal Agent clients to cover valid Root and direct dispatch, unsupported link or target before strict transfer, a legitimately early owner close applied only after creation, historical journal reads, and existing final acceptance and replacement. Keep receipt and inbox reclamation verification separate.
