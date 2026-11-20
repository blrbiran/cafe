import { useEffect, useState } from "react";
import type { AgentRecord, ThreadMeta } from "@cafe/protocol";
import type { RoutingHint } from "@cafe/protocol";
import { api } from "../api.ts";
import { agentAddress, agentLabel, hostLabel, removableAgentAliases } from "../display.ts";
import { useT, type Dict } from "../i18n.ts";
import { hashFor, navigate } from "../route.ts";
import { openComposer, refreshStore, useStore } from "../store.ts";
import { Dot, Empty, Facts, KindTag, PageHeader, Pill, type Tone } from "../ui/bits.tsx";

const WEEK = 7 * 24 * 3600 * 1000;

export function AgentsPage() {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const host = useStore((s) => s.host);
  const isRoot = useStore((s) => s.isRoot);
  const daemons = useStore((s) => s.daemons);
  const threads = useStore((s) => s.threads);

  const all = Object.values(agents);
  const baristas = all.filter((a) => a.role === "barista");
  const customers = all.filter((a) => a.role !== "barista" && a.status !== "offline").length;
  const byHost = new Map<string, AgentRecord[]>();
  for (const a of baristas.sort((x, y) => x.name.localeCompare(y.name) || x.address.localeCompare(y.address))) {
    byHost.set(a.host, [...(byHost.get(a.host) ?? []), a]);
  }
  const hosts = [...byHost.keys()].sort((a, b) => (a === host ? -1 : b === host ? 1 : a.localeCompare(b)));

  // 7-day counts per identity (`name@host`, so they survive restarts); refreshed when traffic changes.
  const [hints, setHints] = useState<Record<string, RoutingHint>>();
  const activity = threads.reduce((n, m) => Math.max(n, m.lastActivityAt ?? m.createdAt), 0);
  useEffect(() => {
    let alive = true;
    api
      .routingHints()
      .then((r) => alive && setHints(r.hints))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activity]);
  // Fallback for older daemons without the hints endpoint: approximate from thread records.
  const since = Date.now() - WEEK;
  const recent = threads.filter((m) => (m.lastActivityAt ?? m.createdAt) >= since);

  return (
    <>
      <PageHeader title={t.agentsTitle} sub={t.agentsSub} />
      {hosts.length === 0 && <Empty>{t.agentsEmpty}</Empty>}
      {hosts.map((h) => {
        const list = byHost.get(h)!;
        const rec = daemons.find((d) => d.host === h);
        const online = rec ? rec.online : list.some((a) => a.status !== "offline");
        const note = h === host ? (isRoot ? t.hostHubThis : t.hostThis) : !online ? t.hostOffline : rec?.isRoot ? t.hostHub : "";
        return (
          <section key={h} className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Dot tone={online ? "ok" : undefined} />
              <h2 className="mono m-0 text-base text-fg-strong">{hostLabel(h, daemons)}</h2>
              {rec?.displayName && rec.displayName !== h && <span className="mono text-[11px] text-muted">{h}</span>}
              {note && <span className="hint">{note}</span>}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
              {list.map((a) => (
                <AgentCard key={a.agentId} a={a} daemons={daemons} threads={threads} recent={recent} stats={hints?.[`${a.name}@${a.host}`] ?? (hints ? { identity: "", answered: 0, declined: 0, failed: 0, declinedTopics: {} } : undefined)} t={t} />
              ))}
            </div>
          </section>
        );
      })}
      {customers > 0 && <div className="hint">{t.customersOnly(customers)}</div>}
    </>
  );
}

function AgentCard({ a, daemons, threads, recent, stats, t }: { a: AgentRecord; daemons: import("@cafe/protocol").DaemonRecord[]; threads: ThreadMeta[]; recent: ThreadMeta[]; stats?: RoutingHint; t: Dict }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [menu, setMenu] = useState(false);
  const aliases = removableAgentAliases(a);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
      await refreshStore();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    setMenu(false);
    const v = prompt(t.settingsNewName, a.displayName ?? a.name);
    if (v?.trim()) void act(() => api.renameAgent(a.address, v.trim()));
  };
  const addAlias = () => {
    setMenu(false);
    const v = prompt(t.settingsAliasPh);
    if (v?.trim()) void act(() => api.aliasAgent(a.address, v.trim()));
  };
  const current = threads.find((m) => (m.status === "working" || m.status === "delivering") && m.targets.includes(a.agentId));
  const status: "idle" | "busy" | "offline" = a.status === "offline" ? "offline" : current || a.status === "busy" ? "busy" : "idle";
  const tone: Tone = status === "busy" ? "info" : status === "idle" ? "ok" : undefined;
  const answered = stats?.answered ?? recent.reduce((n, m) => n + m.replies.filter((r) => r.agentId === a.agentId).length, 0);
  const declined = stats?.declined ?? recent.reduce((n, m) => n + m.declines.filter((d) => d.agentId === a.agentId).length, 0);
  const topics = Object.keys(stats?.declinedTopics ?? {}).slice(0, 3);
  const runsAs =
    a.agent === "command" && a.command ? (
      t.runsCommand(a.command)
    ) : (
      <>
        {{ tui: t.modeTui, headless: t.modeHeadless, cli: t.modeCli, web: t.modeWeb }[a.mode]}
        {a.access && " · "}
        {a.access === "read-only" && <span className="text-muted">{t.readOnly}</span>}
        {a.access === "write" && <span className="text-warn">{t.canWrite}</span>}
      </>
    );

  return (
    <article className={`card flex flex-col gap-2.5 p-4 ${status === "offline" ? "opacity-70" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-2 text-lg font-semibold text-fg-strong">
            {agentLabel(a, daemons)}
            <KindTag a={a} />
          </span>
          <span className="mono truncate text-xs text-muted" title={a.address}>
            {agentAddress(a, daemons)}
          </span>
          {aliases.length > 0 && (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {aliases.map((x) => (
                <span key={x} className="kind-tag">
                  {x}
                  <button type="button" className="ml-1 text-muted" aria-label={`${t.removeAlias} ${x}`} disabled={busy} onClick={() => void act(() => api.removeAgentAlias(a.address, x))}>
                    ×
                  </button>
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Pill tone={tone}>{t[status]}</Pill>
          <button type="button" className="btn-sm" aria-label={t.actions} aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            ⋯
          </button>
        </div>
      </div>
      {menu && (
        <div className="well flex flex-wrap gap-1.5 p-2 text-xs">
          <button type="button" className="btn-sm" onClick={rename}>
            {t.rename}
          </button>
          <button type="button" className="btn-sm" onClick={addAlias}>
            {t.addAlias}
          </button>
          <button type="button" className="btn-sm" onClick={() => void navigator.clipboard?.writeText(a.address).catch(() => {})}>
            {t.copyAddress}
          </button>
        </div>
      )}
      {current && (
        <a className="well block text-sm no-underline hover:border-line-strong" href={hashFor({ page: "thread", threadId: current.threadId })}>
          <span className="text-muted">{t.nowAnswering}</span> <span className="text-fg-strong">“{current.summary.slice(0, 80)}{current.summary.length > 80 ? "…" : ""}”</span>
        </a>
      )}
      {a.description && <div className="text-sm text-fg">{a.description}</div>}
      <Facts
        rows={[
          [t.dir, <span className="mono" title={(a.scope.length ? a.scope : [a.cwd]).join("\n")}>{a.scope[0] ?? a.cwd}</span>],
          [t.runsAs, runsAs],
          [t.last7d, t.stats(answered, declined)],
        ]}
      />
      {topics.length > 0 && <div className="hint">{t.oftenDeclines(t.list(topics))}</div>}
      <div className="mt-0.5 flex gap-2">
        <button
          type="button"
          className="btn-sm"
          disabled={status === "offline"}
          onClick={() => {
            openComposer(a.address);
            navigate({ page: "feed", filter: "all" });
          }}
        >
          {t.askIt}
        </button>
        {status !== "offline" && (
          <button
            type="button"
            className="btn-sm"
            title={t.disconnectHint}
            aria-busy={busy}
            onClick={async () => {
              if (!confirm(t.disconnectConfirm(a.address))) return;
              setBusy(true);
              setErr(undefined);
              try {
                await api.kick(a.agentId);
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.disconnect}
          </button>
        )}
      </div>
      {err && <div className="text-xs text-danger">{err}</div>}
    </article>
  );
}
