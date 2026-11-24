import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { describeFetchError } from "../packages/daemon/src/net-errors.ts";

// #83: Node's fetch puts the real reason in err.cause; reading only err.message turned
// "connection refused", "no such host" and "timed out" into the same "fetch failed".
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as any).port as number;
  await new Promise((r) => s.close(r));
  return port;
}

async function failure(url: string, timeoutMs = 2500): Promise<unknown> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return err;
  }
  throw new Error("expected the fetch to fail");
}

describe("describeFetchError (#83)", () => {
  it("names a refused connection and hints at an unpublished port", async () => {
    const port = await closedPort();
    const d = describeFetchError(await failure(`http://127.0.0.1:${port}/api/health`), `127.0.0.1:${port}`);
    expect(d.code).toBe("ECONNREFUSED");
    expect(d.error).toContain("ECONNREFUSED");
    expect(d.error).toMatch(/Docker/);
    expect(d.error).not.toBe("fetch failed");
  });

  // Built by hand: a resolver that answers every name (a fake-IP proxy) never fails a lookup live.
  it("names a host that does not resolve", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND no-such-host.invalid"), { code: "ENOTFOUND" }) });
    const d = describeFetchError(err, "no-such-host.invalid:4777");
    expect(d.code).toBe("ENOTFOUND");
    expect(d.error).toContain("ENOTFOUND");
  });

  it("names a timeout", async () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(describeFetchError(err, "10.255.255.1:4777").code).toBe("ETIMEDOUT");
  });

  it("names a certificate problem", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }) });
    const d = describeFetchError(err, "pc1:4778");
    expect(d.code).toBe("SELF_SIGNED_CERT_IN_CHAIN");
    expect(d.error).toMatch(/certificate/);
  });

  it("names a connection the other side closed", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    const d = describeFetchError(err, "pc1:4777");
    expect(d.code).toBe("ECONNRESET");
    expect(d.error).toContain("closed");
  });

  it("falls back to the message for anything else", () => {
    expect(describeFetchError(new Error("boom"), "x:1")).toEqual({ error: "boom" });
  });
});
