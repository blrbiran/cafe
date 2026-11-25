/**
 * The daemon token for a browser on another machine (#97).
 *
 * A non-loopback caller must send `Authorization: Bearer <token>`; the daemon never reads a token
 * from a URL (it would land in logs, history and proxies). A link may still carry it once —
 * `#token=…` (never sent to the server) or the older `?token=…` — and the page saves it in this
 * browser and removes it from the address bar. Without a link, the page asks for it on a 401.
 */

const KEY = "cafe.token";

/** The token a URL carries, and the same URL (path + query + hash) without it; `url` is undefined when nothing changes. */
export function takeTokenFromUrl(href: string): { token?: string; url?: string } {
  const u = new URL(href);
  let token: string | undefined;
  const search = new URLSearchParams(u.search);
  if (search.has("token")) {
    token = search.get("token") || undefined;
    search.delete("token");
  }
  let hash = u.hash.replace(/^#/, "");
  if (/^token=/.test(hash)) {
    token = new URLSearchParams(hash).get("token") || token;
    hash = "/";
  } else {
    const [path = "", query] = hash.split("?");
    if (query !== undefined) {
      const q = new URLSearchParams(query);
      if (q.has("token")) {
        token = q.get("token") || token;
        q.delete("token");
        const rest = q.toString();
        hash = rest ? `${path}?${rest}` : path;
      }
    }
  }
  if (token === undefined && !u.searchParams.has("token")) return { url: undefined };
  const qs = search.toString();
  return { token, url: `${u.pathname}${qs ? `?${qs}` : ""}#${hash || "/"}` };
}

export interface TokenStore {
  get(): string | undefined;
  set(token: string): void;
  clear(): void;
}

/** localStorage may be missing or throw (private window, blocked site data); the page still works for this load. */
export function tokenStore(storage: Storage | undefined): TokenStore {
  return {
    get() {
      try {
        return storage?.getItem(KEY) || undefined;
      } catch {
        return undefined;
      }
    },
    set(token) {
      try {
        storage?.setItem(KEY, token);
      } catch {
        // Not remembered; this load still uses it.
      }
    },
    clear() {
      try {
        storage?.removeItem(KEY);
      } catch {
        // Nothing to forget.
      }
    },
  };
}

/** The token for this page load; `cleanUrl` is what the address bar should show instead. */
export function bootToken(href: string, storage: Storage | undefined): { token?: string; cleanUrl?: string } {
  const store = tokenStore(storage);
  const fromUrl = takeTokenFromUrl(href);
  if (fromUrl.token) store.set(fromUrl.token);
  return { token: fromUrl.token ?? store.get(), cleanUrl: fromUrl.url };
}

export function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Set once a request was refused for the token; the app shows the token prompt. */
let required = false;
const listeners = new Set<() => void>();

export const authState = {
  get required(): boolean {
    return required;
  },
  markRequired(): void {
    if (required) return;
    required = true;
    for (const l of listeners) l();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
