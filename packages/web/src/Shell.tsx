import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { isActive, useStore } from "./store.ts";
import { hashFor, type Route } from "./route.ts";
import { setLang, useLang, useT } from "./i18n.ts";
import { applyTheme, readTheme, type Theme } from "./theme.ts";
import { Dot, KindTag, Pill } from "./ui/bits.tsx";
import { SettingsDrawer } from "./ui/SettingsDrawer.tsx";

function CafeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z" />
      <path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-.44-1.16 1.7 1.7 0 0 0-1.87-.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.16-.44 1.7 1.7 0 0 0 .34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 .44 1.16 1.7 1.7 0 0 0 1.87.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.25.37.63.63 1.06.72H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5.88z" />
    </svg>
  );
}

const AGENTS_OPEN_KEY = "cafe.nav.agentsOpen";

function readAgentsOpen(): boolean {
  try {
    const saved = localStorage.getItem(AGENTS_OPEN_KEY);
    if (saved !== null) return saved === "1";
  } catch {
    // ignore
  }
  return typeof window === "undefined" || !window.matchMedia("(max-width: 760px)").matches;
}

export function Shell({
  route,
  children,
  detail,
  detailOpen,
  settingsOpen,
  settingsClosing,
  onOpenSettings,
  onCloseSettings,
  onBlankClick,
  onScrim,
}: {
  route: Route;
  children: ReactNode;
  detail?: ReactNode;
  detailOpen: boolean;
  settingsOpen: boolean;
  settingsClosing: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onBlankClick: (e: ReactMouseEvent<HTMLElement>) => void;
  onScrim: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const host = useStore((s) => s.host);
  const isRoot = useStore((s) => s.isRoot);
  const rootOnline = useStore((s) => s.rootOnline);
  const connected = useStore((s) => s.connected);
  const agents = useStore((s) => s.agents);
  const threads = useStore((s) => s.threads);
  const daemons = useStore((s) => s.daemons);
  const [theme, setTheme] = useState<Theme>(readTheme);
  // Open by default on desktop so the registered Baristas are visible at a glance;
  // on a narrow screen it would cover the page, so it starts collapsed there.
  const [agentsOpen, setAgentsOpen] = useState(readAgentsOpen);
  const toggleAgents = () =>
    setAgentsOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(AGENTS_OPEN_KEY, next ? "1" : "0");
      } catch {
        // private mode / storage disabled: the toggle still works for this visit
      }
      return next;
    });

  const active = threads.filter((x) => isActive(x.status)).length;
  const baristas = Object.values(agents)
    .filter((a) => a.role === "barista")
    .sort((a, b) => a.host.localeCompare(b.host) || a.address.localeCompare(b.address));
  const nav: { page: Route["page"]; label: string; count: number; live?: boolean; route: Route }[] = [
    { page: "feed", label: t.navFeed, count: active, live: active > 0, route: { page: "feed", filter: "all" } },
    { page: "network", label: t.navNetwork, count: daemons.filter((d) => d.online).length, route: { page: "network" } },
    { page: "live", label: t.navLive, count: 0, route: { page: "live" } },
  ];
  const current = route.page === "thread" ? "feed" : route.page;
  const liveText = !connected ? t.reconnecting : isRoot ? t.liveIsHub : rootOnline ? t.liveHubOnline : t.liveHubOffline;
  const liveTone = !connected ? "danger" : isRoot || rootOnline ? "ok" : "warn";

  return (
    <div className={`app flex h-dvh overflow-hidden max-md:block max-md:h-auto max-md:overflow-visible ${detailOpen ? "detail-open" : ""} ${settingsOpen ? "settings-open" : ""}`}>
      <nav
        aria-label="cafe"
        className="box-border flex h-full w-[240px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-card px-3.5 py-5 max-md:sticky max-md:top-0 max-md:z-20 max-md:h-auto max-md:w-auto max-md:flex-row max-md:items-center max-md:gap-2 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-r-0 max-md:px-3 max-md:py-2"
      >
        <div className="flex flex-col gap-2.5 px-1 max-md:shrink-0 max-md:px-0">
          <div className="flex items-center gap-2 text-fg-strong">
            <CafeIcon />
            <span className="text-lg font-bold">cafe</span>
          </div>
          <div className="well flex flex-col gap-1.5 max-md:hidden">
            <div className="cap">{t.thisMachine}</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-sm text-fg-strong">{host || "…"}</span>
              {isRoot && (
                <Pill tone="info" dot={false}>
                  {t.hub}
                </Pill>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Dot tone={liveTone} />
              {liveText}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1 max-md:flex-row">
          {nav.slice(0, 1).map((n) => (
            <a
              key={n.page}
              href={hashFor(n.route)}
              aria-current={current === n.page ? "page" : undefined}
              className={`navitem ${current === n.page ? "is-current" : ""}`}
            >
              <span>{n.label}</span>
              <span className="nav-count" data-live={n.live ? "true" : undefined}>
                {n.count}
              </span>
            </a>
          ))}

          <div className="flex flex-col gap-1 max-md:relative max-md:flex-row">
            <button type="button" className="navitem" aria-expanded={agentsOpen} aria-controls="agents-sub" onClick={toggleAgents}>
              <span>{t.navAgents}</span>
              <span className="flex items-center gap-1.5">
                <span className="nav-count">{baristas.length}</span>
                <span className={`chev ${agentsOpen ? "open" : ""}`} aria-hidden="true">
                  ▸
                </span>
              </span>
            </button>
            <div id="agents-sub" className="nav-sublist" hidden={!agentsOpen}>
              {baristas.length === 0 && <div className="hint px-2 py-1">{t.agentsEmpty}</div>}
              {baristas.map((a) => (
                <div key={a.agentId} className="nav-subagent">
                  <Dot tone={a.status === "offline" ? undefined : a.status === "busy" ? "info" : "ok"} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-fg-strong">{a.displayName ?? a.name}</span>
                      <KindTag a={a} />
                    </div>
                    <div className="mono truncate text-[10px] text-muted">{a.address}</div>
                  </div>
                  <span className={`text-[10px] ${a.status === "offline" ? "text-muted" : a.status === "busy" ? "text-info" : "text-ok"}`}>
                    {a.status === "offline" ? t.offline : a.status === "busy" ? t.busy : t.idle}
                  </span>
                </div>
              ))}
              <a className="nav-sublink" href={hashFor({ page: "agents" })} onClick={() => setAgentsOpen(false)}>
                <span>{t.agentsAll}</span>
                <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>

          {nav.slice(1).map((n) => (
            <a
              key={n.page}
              href={hashFor(n.route)}
              aria-current={current === n.page ? "page" : undefined}
              className={`navitem ${current === n.page ? "is-current" : ""}`}
            >
              <span>{n.label}</span>
              {n.page === "live" ? <span className="nav-live" aria-hidden="true" /> : <span className="nav-count">{n.count}</span>}
            </a>
          ))}
        </div>

        <div className="grow max-md:hidden" />

        <button type="button" className="navitem max-md:shrink-0" onClick={onOpenSettings}>
          <span className="flex items-center gap-2">
            <GearIcon />
            {t.settingsTitle}
          </span>
        </button>

        <div className="flex flex-col gap-2.5 px-1 max-md:hidden">
          <div className="flex items-center justify-between gap-2">
            <span className="cap">{t.language}</span>
            <div className="seg" role="group" aria-label={t.language}>
              <button type="button" aria-pressed={lang === "zh"} onClick={() => setLang("zh")}>
                中文
              </button>
              <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>
                EN
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="cap">{t.theme}</span>
            <div className="seg" role="group" aria-label={t.theme}>
              {(
                [
                  ["dark", t.themeDark],
                  ["light", t.themeLight],
                  ["system", t.themeSystem],
                ] as [Theme, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={theme === k}
                  onClick={() => {
                    setTheme(k);
                    applyTheme(k);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>

      <main onClick={onBlankClick} className="box-border min-w-0 flex-1 overflow-y-auto px-8 pt-7 pb-12 max-md:overflow-visible max-md:px-4 max-md:pb-16">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-5 min-[1600px]:max-w-[1360px] min-[2000px]:max-w-[1560px]">{children}</div>
      </main>

      {detail}
      {settingsOpen && <SettingsDrawer closing={settingsClosing} onClose={onCloseSettings} />}
      <div className="scrim" onClick={onScrim} aria-hidden="true" />
    </div>
  );
}