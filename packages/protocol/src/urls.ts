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