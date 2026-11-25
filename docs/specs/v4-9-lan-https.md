# v4-9 — Encrypted Web from another device (follow-up to #97, Q120)

Status: implemented 2026-11-25 (decided by the agent on the owner's standing instruction "proceed on your
recommendations, report at the end"). Size: small change. Section 7 records the review and what changed.

## 1. Why

#97 made the Web UI usable from another device: the page asks for the token once and sends it as
`Authorization: Bearer`. On `http://<address>:4777/` that header — a token with full write access —
and every conversation travel over the network in clear text. The tester's #61 notes list "LAN Web is
plaintext" as one of the two open items, and Q120 deferred "show which link is encrypted" to this
round.

**Found while looking:** the TLS port already serves the same Web UI and API. Since v4-6 both
listeners share one request handler, so `https://<address>:4778/` returns the page today, the API
there still needs the token, and the page picks `wss:` for its socket on `https:`. The leaf names
every IPv4 address of the machine (#91). What is missing is that:

1. a browser does not trust the cafe CA, so it shows a full-page warning with no explanation;
2. nothing tells a person the encrypted address exists or how to make the browser trust it;
3. the page never says whether the connection it is on is encrypted.

## 2. Goals, non-goals, anti-goals

- **Goal:** someone opening cafe from a laptop or phone can see whether the page is encrypted,
  find the encrypted address, and make their browser trust it in a few steps.
- **Goal:** the Web says plainly which part is encrypted (Q120): this page, and — already shown
  elsewhere — the Daemon links (Network page "Refused: not encrypted", `cafe doctor` tls-links).
- **Non-goal:** a publicly trusted certificate (no public CA signs a LAN IP or a `.local` name);
  installing the CA into the OS automatically (changing a system trust store needs the person);
  HSTS; client certificates.
- **Anti-goal:** the plain-HTTP path must keep working. A phone that has not installed the CA still
  has to be able to use cafe; it gets a clear warning, not a dead end. Loopback (`127.0.0.1:4777`,
  never leaves the machine) must get no warning at all.

## 3. Approaches

- **A. Guide + CA download + encryption indicator (chosen).** Keep both ports as they are. Serve
  the CA as an installable file, tell the page its encrypted address(es), and show an indicator and
  a one-time warning on a non-loopback plain-HTTP page. Cheapest; no transport change; nothing
  breaks for a device that has not trusted the CA.
- **B. Redirect non-loopback 4777 → 4778.** Forces encryption, but a device without the CA lands on
  the browser's untrusted-certificate page with no cafe explanation in front of it, and the person
  cannot reach the instructions that would fix it. Rejected for now; it can become an opt-in once A
  has taught people how to trust the CA.
- **C. TLS on 4777 with protocol sniffing.** v4-6 §4 rejected sniffing (one port, two protocols,
  silent downgrade risk). Rejected.

## 4. Design (A)

### 4.1 Daemon

- `GET /ca.crt` — public, both listeners, only when TLS is on (404 otherwise). Body is the CA PEM,
  `content-type: application/x-x509-ca-cert`, `content-disposition: attachment; filename="cafe-ca.crt"`,
  `cache-control: no-cache`. It is the same certificate `GET /api/tls` already publishes; the private
  key never appears. The loopback Host check (#65) applies as for every other path.
- `GET /api/tls` gains nothing new; the page uses its `tlsPort` and `fingerprint256` (it is public,
  so the token prompt can use it before the person has a token).
- `GET /api/settings` gains `web: { https: string[] }` when TLS is on: one
  `https://<address>:<tlsPort>/` per address from `joinAddresses()` (all non-internal IPv4, or only
  `advertise` when set) — the same list #95 uses, so the two never disagree. Available on every
  Daemon, not only the Root (each Daemon has its own leaf).
- `cafe daemon status` prints one more line when TLS is on:
  `web:       http://127.0.0.1:4777/ (this machine) · https://<address>:4778/ (other devices, encrypted)`
  (first address; `+N more` when there are several).

### 4.2 Web

A pure helper `pageSecurity({ protocol, hostname, port }, tls)` returns
`{ encrypted: boolean, loopback: boolean, httpsUrl?: string }`; `httpsUrl` is
`https://<same hostname>:<tlsPort>/` when the page is plain HTTP, not loopback, and TLS is on.
`loopback` covers `127.0.0.1`, `::1`/`[::1]` and `localhost`.

- **Warning banner** (non-loopback plain HTTP with TLS on): one line above the content —
  "This page is not encrypted: the token and conversations cross the network in clear text.
  [Open the encrypted address] · [How to trust it]". Dismissable per browser
  (localStorage, wrapped in try/catch); the Settings indicator stays.
- **Token prompt** on the same condition shows the same one-line warning with the encrypted link
  above the input, so a person can switch before typing the token.
- **Settings → Connection**: a row "This page" with one of
  - "Encrypted (https)",
  - "This machine only (not encrypted, does not leave the machine)",
  - "Not encrypted (crosses the network)" in the warning tone;
  then "Encrypted addresses for other devices" (the `web.https` list, each copyable), a
  "Download the cafe certificate" link to `/ca.crt`, its SHA-256 fingerprint (to compare with
  `cafe root show`), and a short how-to-trust list: macOS (open → Keychain → Always Trust),
  iOS/iPadOS (install profile, then Settings → General → About → Certificate Trust Settings),
  Windows (Trusted Root Certification Authorities), Android (Settings → Security → Install a
  certificate → CA certificate), Firefox (its own store: Settings → Certificates → Import).
- The token is per origin: `http://x:4777` and `https://x:4778` are different origins, so moving
  to the encrypted address asks for the token once more. The `#token=` link still works there.
  Said in the docs; not worked around (copying a token across origins would need it in a URL).

### 4.3 Docs

README / README_zh / SKILL: the "Web from another device" paragraph leads with the encrypted
address and the trust steps, keeps plain HTTP as "works, with a warning". v4-6 spec: link here.

## 5. Tests

- `tests/web-security.test.ts`: `pageSecurity` for https / loopback http (127.0.0.1, localhost,
  [::1]) / LAN http with and without TLS on.
- `tests/lan-https.test.ts` (daemon, TLS on, port 0): `GET /ca.crt` on both ports returns the CA
  PEM with the attachment headers and equals `/api/tls.ca`; plaintext mode → 404;
  `/api/settings.web.https` lists `https://<addr>:<tlsPort>/` for each join address, and only the
  advertised one when `advertise` is set; absent in plaintext mode; the HTTPS listener serves `/`
  and still answers `/api/snapshot` 401 without a token (guards the "already works" fact).
- `cafe daemon status` line: extend the existing status test if one prints the TLS line.

## 6. Left to the builder

Exact copy (zh/en), the banner's look (reuse the existing `well` + warn tone), where the dismiss
state key lives, and whether the status line shows `+N more`.

## 7. Review and as built (2026-11-25)

An independent subagent reviewed this spec against the code before implementation. It confirmed
the "already works" facts (shared handler, `originAllowed` takes the scheme from the socket so an
`https://addr:4778` page passes the write and `wss` checks, CSP allows `wss:`, `tlsPort` is the
bound port) and raised 11 points, all adopted:

1. **The trust anchor arrives over plain HTTP**, so a fingerprint on that page proves nothing. The
   trust steps now say: compare the fingerprint the device shows with `cafe root show` in a
   terminal on the cafe machine. The fingerprint is shown in the colon form devices use.
2. **What trusting means**: one line — whoever holds `ca.key` can impersonate any https site to
   that device (the CA has no name constraints) — and to remove it where it was installed.
3. **A Host not on the network yet** runs on a temporary CA that enrolment replaces: no `/ca.crt`,
   no address list, Settings says "not joined yet" (`tlsContext.network` gate).
4. **The page's own hostname may not be in the leaf** (`mac.local`, IPv6, a DHCP change): the
   daemon lists only addresses the current leaf names (`sanCovers`), the address list moved into the
   public `GET /api/tls` as `web` (so the token prompt has it), and the page links to its own host
   only when listed, otherwise to the first listed address.
5. **No loopback address** is ever listed for other devices.
6. **Trust steps corrected**: iOS needs General → VPN & Device Management before Certificate Trust
   Settings; Android installs a CA only from Settings (not from the browser), Firefox for Android
   needs "Use third-party CA certificates"; desktop Firefox uses the OS store on macOS/Windows and
   needs a manual import only on Linux.
7. **Token carried across**: "Open the encrypted address" is `https://…/#token=<token>` when this
   browser has one. A fragment never reaches a server and travels inside TLS; the page there saves
   and strips it (#97). So moving to https does not ask again.
8. Plaintext mode: the banner still warns on a LAN plain-HTTP page; Settings says TLS is off.
9. Loopback covers `127.0.0.0/8`, `localhost`, `*.localhost`, `::1`.
10. **Host allow-list cache**: an address that appears after start (VPN up, DHCP) was refused with
    403 until restart; the cache is now rebuilt on a miss, at most once a second.
11. Tests added (below).

`GET /api/settings` keeps `web.https` (the CLI's `cafe daemon status` uses it); the Web reads
`/api/tls.web`.

Tests: `tests/web-security.test.ts` (6), `tests/lan-https.test.ts` (9: `/ca.crt` on both ports and
its headers, TLS listener routes `/api`, list = every LAN address on the TLS port, advertise-only,
non-loopback TLS needs the token and accepts a same-origin https write but not an `http:` Origin,
`/ca.crt` with a foreign Host from loopback → 403, no loopback entry, not-on-network → nothing,
plaintext → nothing), `tests/web-line.test.ts` (3). Browser check against a scratch TLS daemon on
the LAN address: token prompt warns and links to `https://<addr>:<tls>/`; after the token the
banner links with `#token=`; the https page loads without asking and without the banner; Settings
shows the addresses, fingerprint and steps (1440 and 390 wide).

Not verified on real devices: the iOS profile prompt with `content-disposition: attachment`, and
Android's install flow. Listed for the owner.
