import { useSyncExternalStore } from "react";

export type Filter = "all" | "active" | "answered" | "unanswered";

export type Route =
  | { page: "feed"; filter: Filter; channel: string }
  | { page: "thread"; threadId: string; from?: Filter; channel?: string }
  | { page: "agents" }
  | { page: "network" }
  | { page: "live" }
  | { page: "teams" };

const FILTERS: Filter[] = ["all", "active", "answered", "unanswered"];

function filterOf(value: string | null): Filter | undefined {
  return value && FILTERS.includes(value as Filter) ? (value as Filter) : undefined;
}

function channelOf(value: string | null): string {
  return value && /^[a-z0-9_-]{1,64}$/.test(value) ? value : "default";
}

export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case "agents":
      return { page: "agents" };
    case "network":
      return { page: "network" };
    case "live":
      return { page: "live" };
    case "teams":
      return { page: "teams" };
    case "threads":
      if (parts[1]) return { page: "thread", threadId: decodeURIComponent(parts[1]), from: filterOf(q.get("filter")), channel: channelOf(q.get("channel")) };
      break;
  }
  return { page: "feed", filter: filterOf(q.get("filter")) ?? "all", channel: channelOf(q.get("channel")) };
}

export function hashFor(r: Route): string {
  switch (r.page) {
    case "agents":
      return "#/agents";
    case "network":
      return "#/network";
    case "live":
      return "#/live";
    case "teams":
      return "#/teams";
    case "thread": {
      const q = new URLSearchParams();
      if (r.from && r.from !== "all") q.set("filter", r.from);
      if (r.channel && r.channel !== "default") q.set("channel", r.channel);
      const s = q.toString();
      return `#/threads/${encodeURIComponent(r.threadId)}${s ? `?${s}` : ""}`;
    }
    case "feed": {
      const q = new URLSearchParams();
      if (r.filter !== "all") q.set("filter", r.filter);
      if (r.channel !== "default") q.set("channel", r.channel);
      const s = q.toString();
      return `#/${s ? `?${s}` : ""}`;
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