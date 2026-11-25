import { describe, expect, it } from "vitest";
import { webLine } from "../packages/cli/src/web-line.ts";

// v4-9: `cafe daemon status` says where to open the Web on this machine and, encrypted, from others.
describe("webLine (v4-9)", () => {
  it("this machine only when TLS is off", () => {
    expect(webLine("http://127.0.0.1:4777", undefined)).toBe("http://127.0.0.1:4777/ (this machine)");
  });
  it("adds the first encrypted address for other devices", () => {
    expect(webLine("http://127.0.0.1:4777", ["https://192.168.1.10:4778/"])).toBe(
      "http://127.0.0.1:4777/ (this machine) · https://192.168.1.10:4778/ (other devices, encrypted)",
    );
  });
  it("counts the rest", () => {
    expect(webLine("http://127.0.0.1:4777/", ["https://a:4778/", "https://b:4778/", "https://c:4778/"])).toBe(
      "http://127.0.0.1:4777/ (this machine) · https://a:4778/ (other devices, encrypted; +2 more in Settings)",
    );
  });
});
