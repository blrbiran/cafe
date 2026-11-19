import { useSyncExternalStore } from "react";

export type Filter = "all" | "active" | "answered" | "unanswered";

export type Route =
  | { page: "feed"; filter: Filter }
  | { page: "thread"; threadId: string; from?: Filter }
  | { page: "agents" }
  | { page: "network" }
  | { page: "live" };

const FILTERS: Filter[] = ["all", "active", "answered", "unanswered"];

function filterOf(value: string | null): Filter | undefined {
  return value && FILTERS.includes(value as Filter) ? (value as Filter) : undefined;
}

export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  switch (parts[0]) {
    case "agents":
      return { page: "agents" };
    case "network":
      return { page: "network" };
    case "live":
      return { page: "live" };
    case "threads":
      if (parts[1]) return { page: "thread", threadId: decodeURIComponent(parts[1]), from: filterOf(new URLSearchParams(query).get("filter")) };
      break;
  }
  return { page: "feed", filter: filterOf(new URLSearchParams(query).get("filter")) ?? "all" };
}

export function hashFor(r: Route): string {
  switch (r.page) {
    case "agents":
      return "#/agents";
    case "network":
      return "#/network";
    case "live":
      return "#/live";
    case "thread": {
      const q = r.from && r.from !== "all" ? `?filter=${r.from}` : "";
      return `#/threads/${encodeURIComponent(r.threadId)}${q}`;
    }
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