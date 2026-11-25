import { describe, expect, it } from "vitest";
import { pageSecurity } from "../packages/web/src/security.ts";

// v4-9: the Web says whether the page it is on is encrypted, and where the encrypted address is.
// The daemon lists only addresses its leaf names (`/api/tls.web`), so a link always validates.
const TLS = { tlsPort: 4778, https: ["https://192.168.1.10:4778/", "https://10.8.0.2:4778/"] };

describe("pageSecurity (v4-9)", () => {
  it("https is encrypted", () => {
    expect(pageSecurity({ protocol: "https:", hostname: "192.168.1.10" }, TLS)).toEqual({ encrypted: true, loopback: false });
  });
  it("loopback http never leaves the machine and gets no encrypted link", () => {
    for (const hostname of ["127.0.0.1", "127.0.1.1", "localhost", "cafe.localhost", "[::1]", "::1"]) {
      expect(pageSecurity({ protocol: "http:", hostname }, TLS), hostname).toEqual({ encrypted: false, loopback: true });
    }
  });
  it("LAN http points at the same host when the leaf names it", () => {
    expect(pageSecurity({ protocol: "http:", hostname: "10.8.0.2" }, TLS).httpsUrl).toBe("https://10.8.0.2:4778/");
  });
  it("a host the leaf does not name (mac.local, IPv6) gets the first listed address instead", () => {
    expect(pageSecurity({ protocol: "http:", hostname: "mac.local" }, TLS).httpsUrl).toBe("https://192.168.1.10:4778/");
    expect(pageSecurity({ protocol: "http:", hostname: "[fe80::1]" }, TLS).httpsUrl).toBe("https://192.168.1.10:4778/");
  });
  it("carries the token in the fragment so the encrypted page does not ask again", () => {
    expect(pageSecurity({ protocol: "http:", hostname: "10.8.0.2" }, TLS, "a b").httpsUrl).toBe("https://10.8.0.2:4778/#token=a%20b");
  });
  it("no list (TLS off, or not on the network yet) means no link, still a warning", () => {
    expect(pageSecurity({ protocol: "http:", hostname: "192.168.1.10" }, { tlsPort: undefined })).toEqual({ encrypted: false, loopback: false });
    expect(pageSecurity({ protocol: "http:", hostname: "192.168.1.10" }, { tlsPort: 4778, https: [] })).toEqual({ encrypted: false, loopback: false });
  });
});
