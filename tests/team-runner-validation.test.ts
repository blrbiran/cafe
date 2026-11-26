import { describe, expect, it } from "vitest";
import { CafeDocument } from "@cafe/protocol";

const document = (runner: object) => ({ name: "repo", team: { members: [{ name: "orch", duty: "orchestrator", ...runner }] } });

describe("team runner configuration", () => {
  it.each(["agent", "bin"])("rejects an unsupported member %s", (field) => {
    const parsed = CafeDocument.safeParse(document({ [field]: "unsupported-runner" }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["team", "members", 0, field]);
  });

  it("accepts a built-in runner and the legacy omp alias", () => {
    expect(CafeDocument.safeParse(document({ agent: "claude" })).success).toBe(true);
    expect(CafeDocument.safeParse(document({ bin: "omp" })).success).toBe(true);
  });
});
