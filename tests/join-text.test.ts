import { describe, expect, it } from "vitest";
import { joinText } from "../packages/cli/src/join-text.ts";

// #95: `cafe root show` on a Root with several addresses prints one command per address and says
// to pick the one the other machine can reach; with one address it reads as before.
describe("cafe root show join text (#95)", () => {
  const fp = "AA:BB";
  it("prints the single command unchanged on a one-address Root", () => {
    const t = joinText({ addresses: ["192.168.3.132:4777"], advertised: false, fingerprint: fp });
    expect(t.commands).toEqual(["cafe connect 192.168.3.132:4777 --token <token> --ca-fingerprint sha256:AA:BB"]);
    expect(t.text).toBe(
      "to add another machine, run there:\n  cafe connect 192.168.3.132:4777 --token <token> --ca-fingerprint sha256:AA:BB\n  (<token>: run `cafe config get token` on this Root)",
    );
  });

  it("prints every candidate and how to pin one on a multi-address Root", () => {
    const t = joinText({ addresses: ["192.168.3.132:4777", "30.251.51.85:4777"], advertised: false, fingerprint: fp });
    expect(t.commands).toHaveLength(2);
    expect(t.text).toContain("this Root has 2 addresses");
    expect(t.text).toContain("cafe connect 30.251.51.85:4777 --token <token>");
    expect(t.text).toContain("cafe config set advertise");
  });

  it("omits the CA flag without a fingerprint", () => {
    expect(joinText({ addresses: ["h:1"], advertised: true }).commands).toEqual(["cafe connect h:1 --token <token>"]);
  });
});
