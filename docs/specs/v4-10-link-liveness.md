# v4-10 — Link liveness and Root address failover (#99, #104)

Status: implemented (2026-11-25); the design was reviewed by an independent subagent before the
implementation was finalised and the amendments below are folded in. Scope: two permanent-disconnection
paths reported by the tester. Not in scope: mutual TLS (a client certificate per peer), mDNS
authentication, protocol version bumps.

## 1. The problem, in two different shapes

Both show up the same way — a machine silently stops existing for the network, and only a person can
fix it — but they are different failures:

- **#99 half-open link.** The Root restarts (or a NAT/VPN path stops delivering FIN/RST). The child's
  socket stays `ESTABLISHED` forever, it never receives `close`, so it never reconnects. Observed for
  20+ minutes; container `tcp_keepalive_time=7200` widens the window. The child prints `root: (online)`
  while the Root has already forgotten it. The only liveness today is an application-level `cafe/ping`
  request used on demand (`uplinkAlive()`); no control-frame ping exists.
- **#104 the Root's address changed.** `config.root` is one hard-coded `host:port`. Discovery only runs
  when `config.root` is empty (`index.ts`: `else if (discovery && !config.root)`), reconnect only dials
  `config.root`, and `root/moved` exists in the protocol but has no implementation. A Root whose DHCP or
  VPN address changes therefore needs a person on every child.

## 2. Decisions

D1. **Liveness is transport-level, on Daemon↔Daemon links only.** A child's uplink, the Root's side of a
    child link, and a direct peer link each send a WebSocket `ping` every `linkPingMs` (default 30 s;
    test hook `CAFE_LINK_PING_MS` / `timing.linkPingMs`) and expect a `pong`; any inbound frame also
    counts as proof of life. The first ping goes out when the socket is **open**, a missing pong counts
    as a miss, and two misses call `terminate()` — so a half-open link is noticed within two intervals
    of the last answer (≤ ~60 s at the default; the tests allow three to stay robust under load). A dial
    that is still CONNECTING is never pinged and never killed: `ws.ping()` throws there, and a black-
    holed SYN or slow TLS discovery must not be mistaken for a dead peer.
    Agent and browser (`kind: agent|ui`) sockets are deliberately **not** pinged: their clients are
    different, long-lived implementations and dropping one by heuristic would fail an in-flight Order
    and deregister the agent for no benefit. SSE already sends its own `: ping` comment; this does not
    touch it. No new RPC methods and no Thread events: an idle `/api/health` `eventsSinceStart` must
    not move.

D2. **A dead link is killed locally, not negotiated.** A half-open peer will never read a close frame,
    so the watcher calls `terminate()`. The existing handlers do the state work they already do: the
    child logs `root connection lost` and calls `scheduleReconnect()`; the Root's `onPeerClosed()` runs
    the same path as a real disconnect (that Host's agents go offline, a registry delta is broadcast).
    This keeps one code path, and the cost of a false positive is stated: it is a network-wide flap for
    that Host, which is why the default is 30 s and two misses, not something tighter.

D3. **Both ends of a Daemon link check**, because either side can be the one that is forgotten: the
    accepted socket is watched as soon as `initialize` says `kind: daemon|peer`; the dialled socket is
    watched from creation but starts pinging only on `open`. Watchers stop on `close`, and `Daemon.stop()`
    stops every watcher, so no timer outlives its socket or the process shutdown.

D4. **`root/moved` carries addresses.** The Root sends `{ addresses: string[] }` — its `joinAddresses()`
    set, with the `127.0.0.1` fallback removed when real addresses exist — to each child as soon as the
    link is registered and on each `emitDaemons()` (renames, pins and refusal aging reuse the same small
    payload; no change-detection cache is kept, and it is a notification so an older child ignores it).
    Children merge it into `rootAddresses` (bounded to 8, persisted in the store kv).

D5. **Reconnect rotates candidates, and the person's `config.root` is not rewritten.** Candidates are,
    in order: `config.root`, the last address that actually worked (`lastRoot`, kv), then the learned
    ones. Each failed dial — resolve failure, dial throw, handshake failure — and each dropped working
    link advances the index, so the first retry after boot still uses `config.root`. A success resets the
    index and records `lastRoot`; `config.root` stays as the person set it (it may be an ssh tunnel that
    is right even when a probe from the Root's side fails). A host with an empty `root:` but remembered
    candidates still dials them: `connectRoot()` is gated on the candidate list, not on `config.root`.
    The in-flight dial is tracked by target (`dialTarget`), not compared to `config.root`, so rotation
    is not cancelled by its own bookkeeping.
    **Identity check:** a rotated candidate that answers `initialize` with a host name different from the
    stored `rootHost` is refused (`root handshake failed: this address answers as root 'x', but the Root
    was 'y'`) and never dialled again in that round. Only an address the person set — `target ===
    config.root` — may change which Root this Host belongs to; that keeps `cafe root set` usable when a
    Root genuinely moved while a same-token sibling network or a spoofed discovery answer cannot take it
    over.

D6. **mDNS is a last resort, with a ceiling.** After every candidate has failed at least twice,
    discovery runs again (respecting `discovery` and `CAFE_DISCOVERY=0`), starting at 30 s and doubling
    to 5 min, and gives up after 6 tries: an orphaned child must not multicast forever. Discovery is no
    longer conditional on `config.root` being empty. The boot-time "no root configured" search in
    `index.ts` is left as it is (it sets the root once, with its own multi-root guard); the reconnect
    path does not change which Root a Host belongs to — see the identity check above.

D7. **Say which address is in use.** `GET /api/health` now carries, for a child, `root`, `rootOnline`,
    `rootConnected` (the address the current uplink was dialled at; undefined while offline) and
    `rootLastSeenAt` (updated by each pong or inbound frame). `cafe status` / `cafe daemon status` print
    `root: <configured> (online via <connected>)` when they differ, and `(offline, last heard Ns ago)`
    otherwise.

D8. **Honest boundaries.**
    - A Root that moved to an address the child has never learned and that is not on the same LAN cannot
      be found from the child. The child logs the address it tried and the fix (`cafe root set
      <host:port>`, or an `ssh -R` tunnel) instead of silently retrying forever. `cafe doctor` already
      ends its root failure with `next: cafe root set …`; no new doctor check is added.
    - **TLS failover costs time.** A learned candidate is a plaintext main address, so each dial pays a
      `discoverTls()` probe (≈5 s worst case), and a Root whose IP changed needs its leaf renewed to name
      the new address (checked every 5 min, `leafCheckIntervalMs`) plus a fresh TOFU pin for the new
      `host:port`. So a TLS network heals in minutes, and a candidate whose CA/leaf does not match is
      rejected before it can be adopted. Only a test with two isolated TLS daemons covers the first hop;
      the leaf-renewal window is not automated.
    - The candidate set is not a replacement for network reachability: a VPN route that disappeared is
      still gone.

## 3. Wire

No new methods except the already-defined `root/moved` (now implemented, as a notification):

```
root/moved  { addresses: ["192.168.3.129:4777", "10.5.20.232:4777", ...] }
```

`initialize` unchanged; protocol version unchanged.

## 4. Behaviour details

- Watcher (`packages/daemon/src/liveness.ts`): one interval per open socket, `unref()`ed, removed on
  `close`; `stop()` is also called from `Daemon.stop()`.
- `root/moved` payload excludes loopback when the machine has a routable address; `rememberRootAddresses`
  also rejects malformed entries, dedupes, keeps at most 8, newest first.
- The Root's own last-seen time for a child is unchanged (connect time), as before; this spec only adds
  the child-side reading.

## 5. Tests

1. `tests/link-liveness.test.ts`
   - a socket still CONNECTING is never counted as dead (black-holed handshake);
   - a child link whose peer never answers pings is terminated; the child logs `root connection lost`
     and starts reconnecting (fake Root with `autoPong: false`);
   - the Root side drops a child that stops answering pings and marks it offline;
   - a healthy idle link survives several intervals and creates no Thread events
     (`eventsSinceStart` unchanged).
2. `tests/root-failover.test.ts`
   - a child configured with a dead `root` reconnects via a remembered candidate; `config.root` is left
     untouched and `lastRoot` (kv) plus `rootConnected` show the working address;
   - a learned address that answers as a different Root is refused, and an explicit `cafe root set`
     (i.e. `target === config.root`) is honoured;
   - candidates are deduped, bounded, and `config.root` stays first;
   - the Root sends `root/moved` to a newly connected child with its reachable addresses.
3. Not automated: mDNS re-discovery end to end (needs `CAFE_DISCOVERY=1` and a unique mDNS service; the
   unit path is rate-limit + merge only), TLS failover across a leaf renewal, and the Root-side
   last-seen display.

## 6. Verification

`npm run typecheck`, `npm test` (twice), `npm run routing:eval`, `build:web`, `test:release`,
`test:claude-plugin`; restart the Root and check `cafe daemon status` still prints `root: self` and that
a child connects.
