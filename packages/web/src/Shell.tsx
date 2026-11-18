import { useState, type ReactNode } from "react";
import { useStore } from "./store.ts";
import { hashFor, type Route } from "./route.ts";
import { applyTheme, readTheme, type Theme } from "./theme.ts";
import { Badge, Led } from "./ui/bits.tsx";

const NAV: { page: Route["page"]; label: string; route: Route }[] = [
  { page: "threads", label: "Threads", route: { page: "threads" } },
  { page: "agents", label: "Agents", route: { page: "agents" } },
  { page: "network", label: "Network", route: { page: "network" } },
];

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const host = useStore((s) => s.host);
  const isRoot = useStore((s) => s.isRoot);
  const rootOnline = useStore((s) => s.rootOnline);
  const connected = useStore((s) => s.connected);
  const agents = useStore((s) => s.agents);
  const threads = useStore((s) => s.threads);
  const daemons = useStore((s) => s.daemons);
  const [theme, setTheme] = useState<Theme>(readTheme);

  const onlineAgents = Object.values(agents).filter((a) => a.status !== "offline").length;
  const activeThreads = threads.filter((t) => t.status === "routing" || t.status === "delivering" || t.status === "working").length;
  const counts: Record<string, ReactNode> = {
    threads: activeThreads ? <span className="nav-count bg-info text-on-accent">{activeThreads}</span> : <span className="nav-count">{threads.length}</span>,
    agents: <span className="nav-count">{onlineAgents}</span>,
    network: <span className="nav-count">{daemons.filter((d) => d.online).length}</span>,
  };
  const current = route.page === "thread" ? "threads" : route.page;

  return (
    <div className="flex min-h-screen max-md:flex-col md:h-screen">
      <aside className="flex w-nav flex-none flex-col border-r border-line bg-card max-md:w-full max-md:border-r-0 max-md:border-b">
        <div className="border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-fg-strong">☕ cafe</span>
            {isRoot && <Badge tone="info">root</Badge>}
          </div>
          <div className="meta mt-1 flex items-center gap-2">
            <Led status={connected ? "idle" : "danger"} />
            <span>{host || "…"}</span>
          </div>
          {!isRoot && (
            <div className="meta mt-1 flex items-center gap-2">
              <Led status={rootOnline ? "idle" : "warn"} />
              <span>root {rootOnline ? "online" : "unreachable"}</span>
            </div>
          )}
        </div>
        <nav className="flex flex-col py-2 max-md:flex-row max-md:overflow-x-auto">
          {NAV.map((n) => (
            <a
              key={n.page}
              href={hashFor(n.route)}
              aria-current={current === n.page ? "page" : undefined}
              className={`flex items-center justify-between gap-2 px-4 py-2 text-sm no-underline ${
                current === n.page ? "bg-hover font-semibold text-fg-strong shadow-nav-bar" : "text-fg hover:bg-hover"
              }`}
            >
              <span>{n.label}</span>
              {counts[n.page]}
            </a>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-2 border-t border-line px-4 py-3 max-md:hidden">
          <span className="meta">theme</span>
          <select
            aria-label="Theme"
            className="min-h-control-sm py-0 text-xs"
            value={theme}
            onChange={(e) => {
              const t = e.target.value as Theme;
              setTheme(t);
              applyTheme(t);
            }}
          >
            <option value="dark">dark</option>
            <option value="light">light</option>
            <option value="system">system</option>
          </select>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6 max-md:p-4">{children}</main>
    </div>
  );
}
