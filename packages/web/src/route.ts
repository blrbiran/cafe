import { useSyncExternalStore } from "react";

export type Route =
  | { page: "agents" }
  | { page: "threads"; status?: string; agent?: string }
  | { page: "thread"; threadId: string }
  | { page: "network" };

export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case "agents":
      return { page: "agents" };
    case "network":
      return { page: "network" };
    case "threads":
      if (parts[1]) return { page: "thread", threadId: decodeURIComponent(parts[1]) };
      return { page: "threads", status: q.get("status") ?? undefined, agent: q.get("agent") ?? undefined };
    default:
      return { page: "threads" };
  }
}

export function hashFor(r: Route): string {
  switch (r.page) {
    case "agents":
      return "#/agents";
    case "network":
      return "#/network";
    case "thread":
      return `#/threads/${encodeURIComponent(r.threadId)}`;
    case "threads": {
      const q = new URLSearchParams();
      if (r.status) q.set("status", r.status);
      if (r.agent) q.set("agent", r.agent);
      const s = q.toString();
      return s ? `#/threads?${s}` : "#/threads";
    }
  }
}

function subscribe(l: () => void): () => void {
  window.addEventListener("hashchange", l);
  return () => window.removeEventListener("hashchange", l);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parseRoute(hash);
}

export function navigate(r: Route): void {
  location.hash = hashFor(r);
}
