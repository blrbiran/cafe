import { useState, type ReactNode } from "react";
import { isActive, useStore } from "./store.ts";
import { hashFor, type Route } from "./route.ts";
import { setLang, useLang, useT } from "./i18n.ts";
import { applyTheme, readTheme, type Theme } from "./theme.ts";
import { Dot, Pill } from "./ui/bits.tsx";

function CafeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z" />
      <path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3" />
    </svg>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
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

  const active = threads.filter((x) => isActive(x.status)).length;
  const nav: { page: Route["page"]; label: string; count: number; live?: boolean; route: Route }[] = [
    { page: "feed", label: t.navFeed, count: active, live: active > 0, route: { page: "feed", filter: "all" } },
    { page: "agents", label: t.navAgents, count: Object.values(agents).filter((a) => a.role === "barista" && a.status !== "offline").length, route: { page: "agents" } },
    { page: "network", label: t.navNetwork, count: daemons.filter((d) => d.online).length, route: { page: "network" } },
  ];
  const current = route.page === "thread" ? "feed" : route.page;
  const liveText = !connected ? t.reconnecting : isRoot ? t.liveIsHub : rootOnline ? t.liveHubOnline : t.liveHubOffline;
  const liveTone = !connected ? "danger" : isRoot || rootOnline ? "ok" : "warn";

  return (
    <div className="flex min-h-screen flex-wrap items-stretch">
      <nav aria-label="cafe" className="box-border flex max-w-full flex-[1_1_240px] flex-col gap-4.5 border-r border-line bg-card px-3.5 py-5 md:max-w-[280px]">
        <div className="flex flex-col gap-2.5 px-1">
          <div className="flex items-center gap-2 text-fg-strong">
            <CafeIcon />
            <span className="text-lg font-bold">cafe</span>
          </div>
          <div className="well flex flex-col gap-1.5">
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
        <div className="flex flex-col gap-1">
          {nav.map((n) => (
            <a
              key={n.page}
              href={hashFor(n.route)}
              aria-current={current === n.page ? "page" : undefined}
              className={`flex min-h-10 items-center justify-between rounded-control px-3 text-base no-underline ${
                current === n.page ? "bg-hover text-fg-strong shadow-nav-bar" : "text-fg hover:bg-hover"
              }`}
            >
              <span>{n.label}</span>
              <span className="nav-count" data-live={n.live ? "true" : undefined}>
                {n.count}
              </span>
            </a>
          ))}
        </div>
        <div className="grow" />
        <div className="flex flex-col gap-2.5 px-1">
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
      <main className="box-border min-w-0 flex-[999_1_560px] px-8 pt-7 pb-12 max-md:px-4">
        <div className="mx-auto flex max-w-[980px] flex-col gap-5">{children}</div>
      </main>
    </div>
  );
}
