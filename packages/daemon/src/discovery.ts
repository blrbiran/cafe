import makeMdns from "multicast-dns";

/**
 * LAN discovery of the Root Daemon over mDNS (docs/specs/v2-3-discovery-autostart.md).
 * The Root answers PTR queries for `_cafe._tcp.local` with a TXT record carrying
 * its address. Discovery only finds the address: the shared token is still needed.
 */

/** Overridable so tests do not meet real Roots on the LAN. */
const service = () => process.env.CAFE_MDNS_SERVICE ?? "_cafe._tcp.local";

export interface FoundRoot {
  host: string;
  /** `ip:port` to put in `root`. */
  addr: string;
}

function txt(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of Array.isArray(data) ? data : [data]) {
    const s = Buffer.isBuffer(b) ? b.toString() : String(b);
    const i = s.indexOf("=");
    if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

/** Answer discovery queries as the Root. Returns a stop function. */
export function advertiseRoot(info: { host: string; addr: () => string }): () => void {
  const mdns = makeMdns();
  const SERVICE = service();
  const instance = `${info.host}.${SERVICE}`;
  mdns.on("query", (q) => {
    if (!q.questions.some((x) => x.name === SERVICE && ((x.type as string) === "PTR" || (x.type as string) === "ANY"))) return;
    mdns.respond({
      answers: [{ name: SERVICE, type: "PTR", ttl: 120, data: instance }],
      additionals: [{ name: instance, type: "TXT", ttl: 120, data: [`host=${info.host}`, `addr=${info.addr()}`, "v=1"] }],
    });
  });
  mdns.on("error", () => {});
  return () => mdns.destroy();
}

/** Ask the LAN for Roots and collect answers for `timeoutMs`. */
export function discoverRoots(timeoutMs = 2000): Promise<FoundRoot[]> {
  return new Promise((resolve) => {
    const SERVICE = service();
    const found = new Map<string, FoundRoot>();
    let mdns: ReturnType<typeof makeMdns>;
    try {
      mdns = makeMdns();
    } catch {
      return resolve([]);
    }
    mdns.on("error", () => {});
    mdns.on("response", (r) => {
      for (const rec of [...r.answers, ...r.additionals]) {
        if (rec.type !== "TXT" || !rec.name.endsWith(SERVICE)) continue;
        const t = txt(rec.data);
        if (t.host && t.addr) found.set(t.addr, { host: t.host, addr: t.addr });
      }
    });
    const ask = () => mdns.query({ questions: [{ name: SERVICE, type: "PTR" }] });
    ask();
    const again = setTimeout(ask, Math.min(500, timeoutMs / 2));
    setTimeout(() => {
      clearTimeout(again);
      mdns.destroy();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
