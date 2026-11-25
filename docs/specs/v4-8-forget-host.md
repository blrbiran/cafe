# v4-8 — Remove an offline machine ("forget a Host")

Status: **implemented** (2026-11-25; reviewed and revised before implementation). Owner decision Q125 A: build this. Origin: Q119 B (#93 follow-up).
An independent review found that TLS pins live on the children (not the Root), a race with the background
address probe, and several wrong claims about the code; §1, §3 and §4 below are the revised version (§6 lists the changes).

## 1. Problem

A machine that left the network for good (retired laptop, deleted container, a test child) stays visible
on the Root, and nothing a person can do removes it short of hand-editing `config.yml` and restarting:

| Where it lingers | Why | Lifetime |
|---|---|---|
| Network page card "offline · lost N h ago" | `daemonRecords` keeps the record after the child disconnects | until the Root restarts (weeks under launchd) |
| `cafe doctor` → `machines: warn offline: ssh9` | `doctor()` lists every offline record | same; doctor is never all-green |
| Agents page / sidebar: its Agents as offline | the Root upserts them as `offline` on disconnect; children replicate | until the Root restarts (the Root does not restore its Registry from disk; the next snapshot replaces the children's copies) |
| `knownDaemons[host]` in the Root's `config.yml` | `announceRoot()` probes it on every Root start | forever (a failed 1.5 s probe and a log line per start) |
| `pinnedDaemons[host]`, `hostNames[host]` on the Root | config | forever |
| Children: `peerUrls[host]` (kv), open direct link, `security.tls.pins[<its TLS endpoint>]` | children merge peer lists and never prune (`learnPeers`); pins are recorded by `linkOptions` on direct links | forever |

The person's intent is simple: "this machine is gone; stop showing it." The current answer ("restart the Root,
edit config") contradicts the conversation-first, plain-language Web rule.

## 2. Scope and non-goals

In scope: a Root-only action that forgets one **offline** Host everywhere the network remembers it.

Not in scope:
- **Revoking access.** Forgetting is not banning. The machine still has the network token and the CA; if it
  comes back it re-joins and reappears. Blocking a machine means rotating the token (drops every machine) —
  the UI says so in one line. A per-Host credential is TLS phase 2 (mTLS), not this spec.
- Deleting history. Threads, events and attachments that mention the Host or its Agents are kept; old
  Threads show the stable address (`agent@host`) as they do for any Agent no longer in the Registry.
- Forgetting an online Host, the Root itself, or this machine.
- A child forgetting things on its own (children follow the Root).

## 3. Behaviour

### 3.1 Entry points

| Surface | Form |
|---|---|
| Web (Root) | Network page: an offline Host card gets a **Remove** button (zh「移除」). Two-step inline confirm: the button becomes **Remove ssh9?** + **Cancel** with the one-line explanation (§3.4). No modal. Hidden on online cards, on this machine and on a child's Network page. |
| CLI | `cafe host forget <host>` (accepts the host id, display name or alias, like `cafe host address`). Prints what was removed. No `--yes`: everything it removes is re-learned if the machine returns (§3.3), and nothing in it is user data. |
| API | `POST /api/hosts/forget {host}` → `200 {host, agents: n, config: string[]}`. Same auth as other writes (loopback same-origin, LAN token). |
| doctor | the existing `machines` warn keeps listing offline Hosts and adds `next: cafe host forget <host>` (or "Network → Remove") when a Host has been offline for more than 24 h. |

### 3.2 Resolving the name and the preconditions (on the Root)

1. This Daemon is the Root, else `400 not_root` ("only the hub can remove a machine; open the hub's Network page").
2. Resolve the name to a host id: a `daemonRecords` key, or a display name / alias / legacy alias of a record,
   or a key of `knownDaemons` / `pinnedDaemons` / `hostNames` (a "stale-only" Host left in config after a Root
   restart — it has no Network card, so the CLI is its entry point). Else `404 not_found`. (This is new:
   `setHostAddress` today matches only the internal id.)
3. Not this machine, else `400 bad_request`.
4. Offline: either no `children` entry, or a `children` entry whose `uplinkAlive()` round-trip fails (a dead
   socket the Root has not noticed). Else `409 host_online` — "ssh9 is connected right now. Stop cafe on it
   first (cafe daemon stop), then remove it."
5. A record with `refused` set (a plaintext Host still retrying, #93) is not offered in the Web (its next
   attempt recreates the card at once; refusals age out by themselves in 24 h). The API still accepts it.

**No await between the final check and the removal.** `uplinkAlive` waits up to 1.5 s; a child can reconnect
meanwhile (`onChildDaemon`). After the await, re-read `children.get(host)`: if it is a different peer than the
one pinged (or one appeared), answer `409 host_online` and remove nothing. A dead peer that is being removed
is closed and deleted from `children` first, so if the machine is in fact alive it reconnects and re-sends
its Agents.

### 3.3 What is removed

On the Root, synchronously:
- `daemonRecords[host]`, `reportedUrls[host]`, its `refusedPlaintext` entry, the routing hints cache entries of
  its Agents.
- Registry Agents with `r.host === host` → `registry.remove(ids)`; the delta is broadcast as usual (UIs and
  children drop them; the version stays continuous).
- config: `knownDaemons[host]`, `pinnedDaemons[host]`, `hostNames[host]`; saved once. The Daemon edits its own
  running config and saves it, as `setHostAddress` does; these keys stay restart-required for `cafe config set`.
- **Forgotten mark**: `forgotten.set(host, now)`. The two async writers that could resurrect it after an
  in-flight probe — `rememberChildUrl` (writes `knownDaemons`) and `setHostAddress`'s probe — skip the write
  when the host was forgotten after their probe started. The mark is cleared when the host connects again
  (`onChildDaemon`), so a returning machine is learned normally.
- emits `daemons` (Web) and notifies every child `cafe/hostForgotten {host}`.
- TLS pins: **the Root holds none for its children** (pins are recorded only by `linkOptions`, used for direct
  links and a child's uplink). The Root touches no pins.

On each child receiving `cafe/hostForgotten {host}` (ignored if `host` is itself or its Root):
- close and drop `links[host]`; delete `peerUrls[host]` and persist it;
- delete `security.tls.pins[k]` for the keys `k` derived from that peer's address (its `host:port` and the
  learned `tlsEndpoints` value), **unless** another `peerUrls` value or the Root's address maps to the same key
  (a reused DHCP address must not lose a live peer's pin — clearing a live pin would silently re-trust its next
  key on first contact).
An older child ignores the unknown notification and keeps a stale `peerUrls` entry: harmless (a direct dial to
it fails closed, and only while the Root is offline).

Freed names: the Host's display name and aliases become free, so another Host may take them later; old Threads
keep showing the stable address. This is stated, not guarded.

If the machine comes back: it reconnects with its token, `onChildDaemon` recreates the record (with the display
name it keeps in its own config), its Agents re-register, `rememberChildUrl` re-learns `knownDaemons`, and
children re-pin it on first contact.

### 3.4 Copy (plain language, zh/en)

- Button: 移除 / Remove. Confirm: 「移除 ssh9？」 / "Remove ssh9?"
- One line under it: 「从网络里忘掉这台离线机器和它的 Agent；对话记录保留。它若再连上来会重新出现——要彻底挡住它，需更换网络 token（cafe config set token <新值>，之后每台机器都要用新 token 重连）。」 /
  "Forgets this offline machine and its agents; conversations are kept. If it connects again it reappears — to
  keep it out for good, change the network token (cafe config set token <new>; every machine then reconnects
  with it)."
- Success: 「已移除 ssh9（2 个 Agent）」 / "Removed ssh9 (2 agents)". `host_online`: the §3.2 message.
- doctor: unchanged except that a forgotten Host no longer appears (no new hint; review advice).

## 4. Tests (write first)

`tests/forget-host.test.ts` (plaintext Root + children):
1. Child connected → forget → 409 `host_online`; nothing removed.
2. Child stopped → forget → 200 `{agents: n}`; `/api/daemons` lacks it; Registry lacks its Agents; `config.yml`
   has no `knownDaemons` / `pinnedDaemons` / `hostNames` entry; `doctor` `machines` no longer names it.
3. A second connected child gets `cafe/hostForgotten`: its `peerUrls` (kv) lacks the host, its direct link is
   closed, its Registry replica lacks the Agents.
4. The forgotten child starts again → reappears online with its Agents.
5. Resolves by display name / alias; 404 unknown; 400 this machine; 409 `not_root` on a child.
6. Stale-only Host (only `knownDaemons` / `hostNames` keys) is forgettable and those keys go.
7. Race: an address probe for the host still running when it is forgotten does not write `knownDaemons` back.
8. Race: a child that reconnects while the `uplinkAlive` check waits is not removed (409).

Child pins (in `tests/forget-host.test.ts`; the handler only edits config, so no TLS daemon is needed): a child's pin
for the forgotten peer is removed; its pin for another live peer (shared key) and for the Root are kept.

Web: `canForget()` (offline, not self, not refused, Root view) and copy unit test; CLI `cafe host forget` prints
the summary (async spawn).

## 5. Decisions (defaults taken; owner may override at review)

- Verb: **Remove** in the Web, `cafe host forget` in the CLI (says it is not a ban).
- doctor 24 h hint: **dropped** (review).
- A `children` entry whose ping fails counts as offline; it is closed and removed first.

## 6. Changes after the independent review

Pins moved from the Root to the children with a shared-key guard; the forgotten mark against in-flight probes;
the no-await re-check; refused cards excluded; corrected claims (Registry is not restored on the Root; the
config keys are restart-required for `config set`; `setHostAddress` resolves only ids; a returning Host keeps its
own display name); token command named in the copy; doctor hint dropped; race and TLS tests added.

## 7. Implementation plan

1. Protocol: `Methods.hostForgotten = "cafe/hostForgotten"` (`packages/protocol`).
2. Tests first: `tests/forget-host.test.ts` cases 1–8, then `tests/forget-host-tls.test.ts`; watch them fail.
3. Daemon (`daemon.ts`): `resolveHostId(name)`; `forgetHost(name)` with the §3.2 checks and the no-await re-check;
   `forgotten` map checked in `rememberChildUrl` / `setHostAddress` (probe start time vs mark), cleared in
   `onChildDaemon`; child handler for `hostForgotten` (links, `peerUrls`, pins with the shared-key guard).
4. Server: `POST /api/hosts/forget` (write auth as the other `/api/hosts/*`).
5. CLI: `cafe host forget <host>` (summary line; `--json`).
6. Web: `api.forgetHost`, `canForget()` + i18n copy in a small module, Network card two-step Remove.
7. Docs: README / README_zh / SKILL; handoff. Gate ×2; restart the daemon; screenshots at 1440/390.
