import { useSyncExternalStore } from "react";

export type Filter = "all" | "active" | "answered" | "unanswered";

export type Route = { page: "feed"; filter: Filter } | { page: "thread"; threadId: string } | { page: "agents" } | { page: "network" };

const FILTERS: Filter[] = ["all", "active", "answered", "unanswered"];

export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  switch (parts[0]) {
    case "agents":
      return { page: "agents" };
    case "network":
      return { page: "network" };
    case "threads":
      if (parts[1]) return { page: "thread", threadId: decodeURIComponent(parts[1]) };
      break;
  }
  const f = new URLSearchParams(query).get("filter") as Filter | null;
  return { page: "feed", filter: f && FILTERS.includes(f) ? f : "all" };
}

export function hashFor(r: Route): string {
  switch (r.page) {
    case "agents":
      return "#/agents";
    case "network":
      return "#/network";
    case "thread":
      return `#/threads/${encodeURIComponent(r.threadId)}`;
    case "feed":
      return r.filter === "all" ? "#/" : `#/?filter=${r.filter}`;
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
