import { useEffect, useState } from "react";
import { api, type TeamView } from "../api.ts";
import { useT } from "../i18n.ts";
import { navigate } from "../route.ts";
import { openComposer, setChannel, useStore } from "../store.ts";
import { Dot, Empty, PageHeader, Pill } from "../ui/bits.tsx";

/** Teams page (v4-11): one card per team, a roster drawer, and channel-scoped actions. */
export function TeamsPage() {
  const t = useT();
  const registryVersion = useStore((s) => s.registryVersion);
  const connected = useStore((s) => s.connected);
  const threads = useStore((s) => s.threads);
  const [teams, setTeams] = useState<TeamView[]>();
  const [selected, setSelected] = useState<string>();
  const activity = threads.reduce((n, m) => Math.max(n, m.lastActivityAt ?? m.createdAt), 0);

  useEffect(() => {
    let alive = true;
    api
      .teams()
      .then((list) => alive && setTeams(list))
      .catch(() => alive && setTeams([]));
    return () => {
      alive = false;
    };
  }, [registryVersion, connected, activity]);

  const team = teams?.find((x) => `${x.host}/${x.team}` === selected);

  useEffect(() => {
    if (!team) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(undefined);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [team]);

  const openChannel = (x: TeamView) => {
    setChannel(x.channel);
    navigate({ page: "feed", filter: "all", channel: x.channel });
  };
  const askOrchestrator = (x: TeamView) => {
    const orch = x.roster.find((m) => m.duty === "orchestrator" && m.address);
    setChannel(x.channel);
    navigate({ page: "feed", filter: "all", channel: x.channel });
    openComposer(orch?.address ?? `${x.team}@${x.host}`);
  };

  return (
    <>
      <PageHeader title={t.teamsTitle} sub={t.teamsSub} />
      {teams && teams.length === 0 && <Empty>{t.noTeams}</Empty>}
      {!teams && <div className="hint">{t.loading}</div>}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]">
        {teams?.map((x) => {
          const key = `${x.host}/${x.team}`;
          return (
            <button
              key={key}
              type="button"
              className="card flex flex-col gap-2.5 p-4 text-left hover:border-line-strong"
              onClick={() => setSelected(key)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-base font-semibold text-fg-strong">{x.team}</span>
                <span className="text-xs text-muted">
                  <Dot tone={x.online > 0 ? "ok" : "warn"} /> {x.online}/{x.total} {t.onlineOf}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="mono">#{x.channel}</span>
                <span>{x.openThreads} {t.openThreads}</span>
                {x.partial && <span>{t.partialTeam}</span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {x.roster.slice(0, 6).map((m) => (
                  <Pill key={m.name} tone={m.status && m.status !== "offline" ? "info" : "warn"} dot={false}>
                    {m.name}
                    {m.observer ? " 👁" : ""}
                  </Pill>
                ))}
                {x.roster.length > 6 && <span className="text-xs text-muted">+{x.roster.length - 6}</span>}
              </div>
            </button>
          );
        })}
      </div>

      {team && (
        <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
          <div className="absolute inset-0 bg-black/35" onClick={() => setSelected(undefined)} />
          <section
            role="dialog"
            aria-modal="true"
            aria-label={team.team}
            className="relative z-10 flex h-full w-[min(620px,94vw)] flex-col gap-3 overflow-y-auto border-l border-line bg-card p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="m-0 text-xl text-fg-strong">{team.team}</h2>
                <div className="text-sm text-muted">
                  <span className="mono">#{team.channel}</span> · {team.online}/{team.total} {t.onlineOf} · {team.openThreads} {t.openThreads}
                  {team.partial ? ` · ${t.partialTeam}` : ""}
                </div>
              </div>
              <button type="button" className="linkbtn" onClick={() => setSelected(undefined)} aria-label={t.cancel}>
                ✕
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={() => openChannel(team)}>
                {t.openChannel}
              </button>
              <button type="button" className="btn" onClick={() => askOrchestrator(team)}>
                {t.askOrchestrator}
              </button>
            </div>
            <div className="well overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="cap">
                  <tr>
                    <th className="py-1 pr-3">{t.member}</th>
                    <th className="py-1 pr-3">{t.duty}</th>
                    <th className="py-1 pr-3">{t.mode}</th>
                    <th className="py-1">status</th>
                  </tr>
                </thead>
                <tbody>
                  {team.roster.map((m) => (
                    <tr key={m.name} className="border-t border-line">
                      <td className="mono py-1.5 pr-3">
                        {m.name}
                        {m.observer ? " 👁" : ""}
                        {m.currentThread && <div className="text-[11px] text-muted">{t.currentThread}: {m.currentThread}</div>}
                      </td>
                      <td className="py-1.5 pr-3">{m.duty ?? "-"}</td>
                      <td className="py-1.5 pr-3">{m.mode}</td>
                      <td className="py-1.5">
                        <span className="mono text-xs">{m.status ?? "offline"}</span>
                        {m.address && <div className="mono text-[11px] text-muted">{m.address}</div>}
                        <div className="text-[11px] text-muted" title={m.dir}>{t.dir}: {m.dir}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}