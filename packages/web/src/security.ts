/**
 * Is the page the person is looking at encrypted, and where is the encrypted address (v4-9)?
 * The TLS port serves the same Web UI as the plaintext port. The daemon lists only addresses its
 * leaf certificate names (`/api/tls.web`), so the link is the page's own host when listed, or the
 * first listed address otherwise (a `mac.local` or IPv6 host is not in the leaf).
 */
export interface PageSecurity {
  encrypted: boolean;
  /** Plain HTTP that never leaves this machine: nothing to warn about. */
  loopback: boolean;
  /** Set for plain HTTP over the network when the daemon offers an encrypted address. */
  httpsUrl?: string;
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function pageSecurity(page: { protocol: string; hostname: string }, tls: { tlsPort?: number | null; https?: string[] }, token?: string): PageSecurity {
  if (page.protocol === "https:") return { encrypted: true, loopback: false };
  if (isLoopback(page.hostname)) return { encrypted: false, loopback: true };
  const list = tls.tlsPort ? (tls.https ?? []) : [];
  const same = `https://${page.hostname}:${tls.tlsPort}/`;
  const target = list.includes(same) ? same : list[0];
  if (!target) return { encrypted: false, loopback: false };
  // A fragment never reaches a server and travels inside TLS; the page there reads and removes it (#97).
  return { encrypted: false, loopback: false, httpsUrl: token ? `${target}#token=${encodeURIComponent(token)}` : target };
}
