import { describe, expect, it } from "vitest";
import { joinCommands } from "../packages/web/src/join.ts";

// #95: the Web "Add another machine" block lists one command per candidate address; an older
// daemon that only sends `address` still gives one command.
describe("Web join commands (#95)", () => {
  it("one command per address", () => {
    expect(joinCommands({ address: "a:1", addresses: ["a:1", "b:1"], advertised: false, caFingerprint: "sha256:F" })).toEqual([
      "cafe connect a:1 --token <token> --ca-fingerprint sha256:F",
      "cafe connect b:1 --token <token> --ca-fingerprint sha256:F",
    ]);
  });
  it("includes an invitation placeholder for a Root that supports enrollment", () => {
    expect(joinCommands({ address: "a:4778", rootHostId: "01M8CXVTWBGJQ894H04RG79N6F", caFingerprint: "sha256:F" })).toEqual([
      "cafe connect a:4778 --token <token> --invite <code> --ca-fingerprint sha256:F",
    ]);
  });
  it("falls back to address from an older daemon", () => {
    expect(joinCommands({ address: "a:1" })).toEqual(["cafe connect a:1 --token <token>"]);
  });
});
