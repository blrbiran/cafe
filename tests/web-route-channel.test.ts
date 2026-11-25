import { describe, expect, it } from "vitest";
import { hashFor, parseRoute } from "../packages/web/src/route.ts";

describe("web route channels (v4-11)", () => {
  it("parses the channel from the feed URL and defaults to default", () => {
    expect(parseRoute("#/?channel=team&filter=active")).toEqual({ page: "feed", filter: "active", channel: "team" });
    expect(parseRoute("#/")).toEqual({ page: "feed", filter: "all", channel: "default" });
    expect(parseRoute("#/?channel=not%20valid")).toMatchObject({ page: "feed", channel: "default" });
  });

  it("keeps the channel through hashFor and thread links", () => {
    expect(hashFor({ page: "feed", filter: "all", channel: "team" })).toBe("#/?channel=team");
    expect(hashFor({ page: "feed", filter: "active", channel: "default" })).toBe("#/?filter=active");
    const back = parseRoute(hashFor({ page: "thread", threadId: "t1", from: "active", channel: "team" }));
    expect(back).toEqual({ page: "thread", threadId: "t1", from: "active", channel: "team" });
  });

  it("has a teams page", () => {
    expect(parseRoute("#/teams")).toEqual({ page: "teams" });
    expect(hashFor({ page: "teams" })).toBe("#/teams");
  });
});