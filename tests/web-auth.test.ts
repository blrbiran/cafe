import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authHeaders, bootToken, takeTokenFromUrl, tokenStore } from "../packages/web/src/auth.ts";

// #97: the daemon accepts only `Authorization: Bearer` from a non-loopback caller, so the Web UI
// must never put the token in a URL. A link may still carry it once (`#token=` or the old
// `?token=`); the page keeps it in this browser and removes it from the address bar.

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe("takeTokenFromUrl (#97)", () => {
  it("reads #token= and leaves the Feed route", () => {
    expect(takeTokenFromUrl("http://10.0.0.5:4777/#token=abc")).toEqual({ token: "abc", url: "/#/" });
  });
  it("reads the old ?token= and keeps the route hash", () => {
    expect(takeTokenFromUrl("http://10.0.0.5:4777/?token=abc#/agents")).toEqual({ token: "abc", url: "/#/agents" });
  });
  it("reads a token inside a hash route's query and keeps the other parameters", () => {
    expect(takeTokenFromUrl("http://h:4777/#/?filter=active&token=abc")).toEqual({ token: "abc", url: "/#/?filter=active" });
  });
  it("keeps other query parameters", () => {
    expect(takeTokenFromUrl("http://h:4777/?lang=zh&token=abc#/live")).toEqual({ token: "abc", url: "/?lang=zh#/live" });
  });
  it("returns no token and no rewrite when the URL has none", () => {
    expect(takeTokenFromUrl("http://h:4777/#/threads/t1")).toEqual({ url: undefined });
  });
});

describe("token storage (#97)", () => {
  it("a link's token is saved and the address bar is cleaned", () => {
    const s = memoryStorage();
    const boot = bootToken("http://h:4777/#token=abc", s);
    expect(boot).toEqual({ token: "abc", cleanUrl: "/#/" });
    expect(tokenStore(s).get()).toBe("abc");
  });
  it("without a link the saved token is used", () => {
    const s = memoryStorage();
    tokenStore(s).set("saved");
    expect(bootToken("http://h:4777/#/agents", s)).toEqual({ token: "saved", cleanUrl: undefined });
  });
  it("forget removes it", () => {
    const s = memoryStorage();
    const store = tokenStore(s);
    store.set("x");
    store.clear();
    expect(store.get()).toBeUndefined();
  });
  it("works when storage is unavailable (private window, blocked site data)", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } } as unknown as Storage;
    expect(bootToken("http://h:4777/#token=abc", broken)).toEqual({ token: "abc", cleanUrl: "/#/" });
    expect(tokenStore(undefined).get()).toBeUndefined();
  });
});

describe("requests carry the token in a header only (#97)", () => {
  it("authHeaders", () => {
    expect(authHeaders("abc")).toEqual({ authorization: "Bearer abc" });
    expect(authHeaders(undefined)).toEqual({});
  });
  it("no Web source builds a token= URL", () => {
    const dir = join(import.meta.dirname, "../packages/web/src");
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f));
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/token=\$\{/);
      expect(src, f).not.toMatch(/withToken/);
    }
  });
});
