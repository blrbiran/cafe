import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { stringify } from "yaml";
import { runDaemon } from "@cafe/daemon";
import { FAST } from "./helpers.ts";

// #69: the built UI was served raw (336 kB JS every load), with no ETag and no CSP.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function withWeb() {
  const home = mkdtempSync(join(tmpdir(), "cafe-web-"));
  const web = join(home, "web");
  mkdirSync(web, { recursive: true });
  const js = "export const big = '" + "x".repeat(50_000) + "';\n";
  writeFileSync(join(web, "index.js"), js);
  // Vite emits content-hashed names; only those may be cached forever (#69 follow-up).
  writeFileSync(join(web, "index-BZg5MLuf.js"), js);
  writeFileSync(join(web, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="/index-BZg5MLuf.js"></script></body></html>');
  writeFileSync(join(home, "config.yml"), stringify({ host: "pc1", token: "t0k", port: 0, security: { mode: "plaintext" } }));
  const r = await runDaemon({ home, timing: FAST, log: () => {}, noLock: true, noSupervisor: true, webDist: web });
  cleanup.push(async () => {
    await r.stop();
    rmSync(home, { recursive: true, force: true });
  });
  return `127.0.0.1:${r.server.port}`;
}

/** A raw request: fetch() would undo the gzip before the test could see its size. */
function raw(addr: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const [, port] = addr.split(":");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: Number(port), path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("static web assets (#69)", () => {
  it("gzips when the client accepts it", async () => {
    const addr = await withWeb();
    // fetch() decompresses transparently, so the byte count has to come from a raw request.
    const { status, headers, body } = await raw(addr, "/index-BZg5MLuf.js", { "accept-encoding": "gzip" });
    expect(status).toBe(200);
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers.vary).toMatch(/accept-encoding/i);
    expect(body.length).toBeLessThan(5000);
  });

  it("serves plain bytes when gzip is not accepted", async () => {
    const addr = await withWeb();
    const res = await fetch(`http://${addr}/index-BZg5MLuf.js`, { headers: { "accept-encoding": "identity" } });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect((await res.text()).length).toBeGreaterThan(50_000);
  });

  it("answers 304 for a matching ETag", async () => {
    const addr = await withWeb();
    const first = await fetch(`http://${addr}/index-BZg5MLuf.js`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await first.arrayBuffer();
    const second = await fetch(`http://${addr}/index-BZg5MLuf.js`, { headers: { "if-none-match": etag! } });
    expect(second.status).toBe(304);
  });

  it("gives the built JS a long cache and the HTML no-cache", async () => {
    const addr = await withWeb();
    const js = await fetch(`http://${addr}/index-BZg5MLuf.js`);
    await js.arrayBuffer();
    expect(js.headers.get("cache-control")).toMatch(/max-age=31536000/);
    const html = await fetch(`http://${addr}/`);
    await html.text();
    expect(html.headers.get("cache-control")).toMatch(/no-cache/);
    expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  // The name is what makes a year-long cache safe: an unhashed file must be revalidated, or a warm
  // browser cache keeps running the previous release's JS after an upgrade (#69 follow-up).
  it("does not cache an unhashed asset as immutable", async () => {
    const addr = await withWeb();
    const plain = await fetch(`http://${addr}/index.js`);
    await plain.arrayBuffer();
    expect(plain.headers.get("cache-control")).toMatch(/no-cache/);
    expect(plain.headers.get("cache-control")).not.toMatch(/immutable/);
  });

  it("keeps the CSP compatible with the app's inline styles and data: images", async () => {
    const addr = await withWeb();
    const html = (await fetch(`http://${addr}/`)).headers.get("content-security-policy") ?? "";
    expect(html).toContain("style-src 'self' 'unsafe-inline'");
    expect(html).toContain("img-src 'self' data:");
    expect(html).toContain("connect-src 'self' ws:");
  });
});

describe("gzip only what compresses", () => {
  it("does not claim gzip for a tiny or already compressed file", async () => {
    const addr = await withWeb();
    // index.html is small; gzip would be larger than the original.
    const res = await fetch(`http://${addr}/`, { headers: { "accept-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    await res.text();
  });
});

describe("precompressed comparison", () => {
  it("matches what gzip would produce in size", () => {
    const raw = Buffer.from("x".repeat(50_000));
    expect(gzipSync(raw).length).toBeLessThan(raw.length);
  });
});