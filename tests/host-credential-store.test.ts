import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostIdentity } from "@cafe/protocol";
import { Store, type CallerPrincipalRecord, type InviteRedemptionRecord } from "../packages/daemon/src/store.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "cafe-identity-store-"));
}

const host: HostIdentity = {
  hostId: "01J22222222222222222222222",
  host: "laptop",
  keyFingerprint: "AA:BB:CC",
  state: "enrolled",
  revision: 1,
};

const redemption: InviteRedemptionRecord = {
  inviteDigest: "invite-digest",
  requestId: "request-1",
  publicKeyFingerprint: "AA:BB:CC",
  sansHash: "sans-hash",
  hostId: host.hostId,
  certificate: "CERTIFICATE PEM",
  state: "current",
};

const principal: CallerPrincipalRecord = {
  kind: "human",
  credentialDigest: "owner-digest",
  principalId: "principal-1",
};

describe("Store Host and caller identity persistence", () => {
  it("persists stable Host identity mappings across Store instances", () => {
    const path = home();
    const store = new Store(path);
    store.putHostIdentity(host);

    const reloaded = new Store(path);
    expect(reloaded.getHostIdentity(host.hostId)).toEqual(host);
    expect(reloaded.getHostIdentityByHost("laptop")).toEqual(host);
    expect(reloaded.getHostIdentityByKeyFingerprint("AA:BB:CC")).toEqual(host);
  });

  it("replays an invite redemption for the same key and keeps a certificate-free superseded tombstone", () => {
    const path = home();
    const store = new Store(path);
    store.putInviteRedemption(redemption);

    const reloaded = new Store(path);
    expect(reloaded.getInviteRedemption("invite-digest")).toEqual(redemption);
    reloaded.markInviteSuperseded("invite-digest", "01J33333333333333333333333", 2);
    expect(reloaded.getInviteRedemption("invite-digest")).toEqual({
      ...redemption,
      certificate: undefined,
      state: "superseded",
      supersededByHostId: "01J33333333333333333333333",
      supersededByRevision: 2,
    });
  });

  it("maps one credential digest to the same opaque actor principal after restart", () => {
    const path = home();
    const store = new Store(path);
    expect(store.putCallerPrincipal(principal)).toBe("principal-1");

    const reloaded = new Store(path);
    expect(reloaded.getCallerPrincipal("human", "owner-digest")).toBe("principal-1");
    expect(reloaded.putCallerPrincipal({ ...principal, principalId: "principal-2" })).toBe("principal-1");
  });
});
