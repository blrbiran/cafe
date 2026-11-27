/**
 * Transport scheme helpers (v4-6 #61). One place decides `ws:`/`wss:` and `http:`/`https:` so no
 * caller hard-codes a scheme. Defaults to plaintext for callers that have not opted into TLS
 * (the Web UI on 4777 never dials the TLS port).
 */

export interface SchemeOptions {
  tls?: boolean;
  /** Path appended for the WebSocket endpoint; `/ws` for a Daemon. */
  path?: string;
}

/** `ws://host:port/ws` or `wss://host:port/ws`. */
export function daemonWsUrl(addr: string, opts: SchemeOptions = {}): string {
  const scheme = opts.tls ? "wss" : "ws";
  const path = opts.path ?? "/ws";
  return `${scheme}://${addr}${path.startsWith("/") ? path : `/${path}`}`;
}

/** `http://host:port` or `https://host:port`. */
export function daemonHttpUrl(addr: string, opts: SchemeOptions = {}): string {
  return `${opts.tls ? "https" : "http"}://${addr}`;
}

/** Transport allowed for owner, connector, and operator capabilities. */
export function callerCredentialTransport(target: string): "loopback" | "verified-tls" | "remote-plaintext" {
  try {
    const url = new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`);
    if (url.protocol === "https:") return "verified-tls";
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)) return "loopback";
  } catch {
    return "remote-plaintext";
  }
  return "remote-plaintext";
}