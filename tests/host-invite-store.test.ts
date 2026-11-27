import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostIdentity } from "@cafe/protocol";
import { Store, type HostInviteRecord } from "../packages/daemon/src/store.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "cafe-host-invite-"));
}

const hostId = "01J22222222222222222222222";
const invite: HostInviteRecord = {
  inviteDigest: "invite-digest",
  createdAt: 100,
  expiresAt: 200,
  hostId,
  host: "child-host",
  state: "issued",
};
const redemption = {
  inviteDigest: invite.inviteDigest,
  now: 150,
  requestId: "request-1",
  publicKeyFingerprint: "AA:BB:CC",
  sansHash: "sans-hash",
  certificate: "HOST CERTIFICATE PEM",
  replacementHostOnline: false,
};

describe("Store Root Host invite redemption", () => {
  it("commits one enrollment and replays the same result after the redemption window", () => {
    const path = home();
    const store = new Store(path);
    store.createHostInvite(invite);

    const first = store.commitHostEnrollment(redemption);
    expect(first.retry).toBe(false);
    expect(first.identity).toMatchObject({ hostId, host: "child-host", keyFingerprint: "AA:BB:CC", state: "enrolled" });
    expect(first.redemption.certificate).toBe("HOST CERTIFICATE PEM");

    const reloaded = new Store(path);
    const retry = reloaded.commitHostEnrollment({ ...redemption, now: 500 });
    expect(retry.retry).toBe(true);
    expect(retry.redemption.certificate).toBe("HOST CERTIFICATE PEM");
  });

  it("rejects first redemption after expiry and rejects changed request, key, or SAN on replay", () => {
    const expired = new Store(home());
    expired.createHostInvite(invite);
    expect(() => expired.commitHostEnrollment({ ...redemption, now: 201 })).toThrow(/expired/i);

    const store = new Store(home());
    store.createHostInvite(invite);
    store.commitHostEnrollment(redemption);
    expect(() => store.commitHostEnrollment({ ...redemption, requestId: "different-request" })).toThrow(/already|request/i);
    expect(() => store.commitHostEnrollment({ ...redemption, publicKeyFingerprint: "FF:EE:DD" })).toThrow(/already|key/i);
    expect(() => store.commitHostEnrollment({ ...redemption, sansHash: "changed-sans" })).toThrow(/already|SAN/i);
  });

  it("compare-and-swaps replacement against the old Host binding and requires it offline", () => {
    const store = new Store(home());
    const oldHost: HostIdentity = { hostId, host: "child-host", keyFingerprint: "OLD:KEY", state: "enrolled", revision: 4 };
    store.putHostIdentity(oldHost);
    store.createHostInvite({ ...invite, expectedHostRevision: 4, expectedKeyFingerprint: "OLD:KEY" });

    expect(() => store.commitHostEnrollment({ ...redemption, publicKeyFingerprint: "NEW:KEY", replacementHostOnline: true })).toThrow(/offline/i);
    expect(store.getHostIdentity(hostId)).toEqual(oldHost);
    const changed = store.commitHostEnrollment({ ...redemption, publicKeyFingerprint: "NEW:KEY", replacementHostOnline: false });
    expect(changed.identity).toMatchObject({ hostId, keyFingerprint: "NEW:KEY", revision: 5 });

    const stale = new Store(home());
    stale.putHostIdentity(oldHost);
    stale.createHostInvite({ ...invite, expectedHostRevision: 4, expectedKeyFingerprint: "OLD:KEY" });
    stale.putHostIdentity({ ...oldHost, keyFingerprint: "CHANGED:KEY", revision: 5 });
    expect(() => stale.commitHostEnrollment({ ...redemption, publicKeyFingerprint: "NEW:KEY", replacementHostOnline: false })).toThrow(/revision|fingerprint/i);
  });

  it("keeps a non-secret credential-superseded tombstone after a later rekey", () => {
    const store = new Store(home());
    store.createHostInvite(invite);
    store.commitHostEnrollment(redemption);
    store.markInviteSuperseded(invite.inviteDigest, "01J33333333333333333333333", 2);

    const staleRetry = store.commitHostEnrollment({ ...redemption, now: 500 });
    expect(staleRetry.retry).toBe(false);
    expect(staleRetry.redemption).toMatchObject({ state: "superseded", supersededByHostId: "01J33333333333333333333333" });
    expect(staleRetry.redemption.certificate).toBeUndefined();
  });
});
