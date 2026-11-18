import { useState } from "react";
import { onlineVersions } from "@cafe/protocol/version";
import { ago, useT } from "../i18n.ts";
import { useNow } from "../format.ts";
import { useStore } from "../store.ts";
import { Disclosure, Empty, Facts, PageHeader, Pill } from "../ui/bits.tsx";

export function NetworkPage() {
  const t = useT();
  const now = useNow();
  const daemons = useStore((s) => s.daemons);
  const host = useStore((s) => s.host);
  const isRoot = useStore((s) => s.isRoot);
  const router = useStore((s) => s.router);
  const version = useStore((s) => s.registryVersion);
  const rootOnline = useStore((s) => s.rootOnline);
  const agents = useStore((s) => s.agents);
  const threads = useStore((s) => s.threads);
  const [debug, setDebug] = useState(false);

  const sorted = [...daemons].sort((a, b) => Number(b.host === host) - Number(a.host === host) || Number(b.isRoot) - Number(a.isRoot) || a.host.localeCompare(b.host));
  const self = daemons.find((d) => d.host === host);
  const anyFile = threads.find((m) => m.file)?.file;
  const dataDir = anyFile ? anyFile.replace(/\/[^/]+\/[^/]+$/, "/") : "~/.cafe/sessions/";
  // Reference release: the hub's, else this machine's. Machines on another release are marked.
  const target = (daemons.find((d) => d.isRoot && d.online) ?? self)?.version;
  const mixed = onlineVersions(daemons).length > 1;
  const versionList = daemons
    .filter((d) => d.online)
    .map((d) => `${!d.isRoot || d.host !== "root" ? d.host : t.hub} ${d.version ?? t.versionUnknown}`)
    .join(" · ");
  const count = (h: string) => Object.values(agents).filter((a) => a.host === h && a.role === "barista" && a.status !== "offline").length;

  return (
    <>
      <PageHeader title={t.networkTitle} sub={t.networkSub} />
      <div className="well px-4 py-3 text-sm leading-relaxed text-fg">{t.networkExplain}</div>
      {!isRoot && !rootOnline && (
        <div role="status" className="well text-sm" data-tone="warn">
          {t.hubOfflineWarn}
        </div>
      )}
      {mixed && (
        <div role="status" className="well flex flex-col gap-1 text-sm" data-tone="warn">
          <b>{t.versionsDiffer}</b>
          <span>{t.versionsDifferBody(versionList, target ?? "latest")}</span>
        </div>
      )}
      {!isRoot && <div className="hint">{t.childView}</div>}
      {sorted.length === 0 ? (
        <Empty>—</Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {sorted.map((d) => {
            const isThis = d.host === host;
            // A child daemon only knows the hub as a synthetic "root" record.
            const name = !isThis && d.isRoot && d.host === "root" ? t.hub : d.host;
            const badges = [d.isRoot || (isThis && isRoot) ? t.hub : undefined, isThis ? t.thisMachine : undefined].filter(Boolean) as string[];
            return (
              <article key={`${d.host}-${d.isRoot}`} className="card flex flex-col gap-2.5 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="mono truncate text-base text-fg-strong">{name}</span>
                  <Pill tone={d.online ? "ok" : undefined}>{d.online ? t.online : t.mOffline}</Pill>
                </div>
                {badges.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {badges.map((b) => (
                      <Pill key={b} dot={false}>
                        {b}
                      </Pill>
                    ))}
                  </div>
                )}
                <Facts
                  rows={[
                    [t.address, <span className="mono">{d.url.replace(/^wss?:\/\//, "") || "—"}</span>],
                    ["Agents", d.host === "root" && !isThis ? "—" : String(count(d.host))],
                    [t.since, d.online ? ago(t, d.connectedAt, now) : t.lostAt(ago(t, d.lastSeenAt, now))],
                    [
                      t.version,
                      <span className={`mono ${mixed && d.online && d.version !== target ? "font-semibold text-warn" : ""}`}>{d.version ?? t.versionUnknown}</span>,
                    ],
                  ]}
                />
              </article>
            );
          })}
        </div>
      )}
      <Disclosure show={t.dbgShow} hide={t.dbgHide} open={debug} onToggle={() => setDebug((v) => !v)}>
        <div className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1.5 text-xs">
          <span className="text-muted">{t.dbgRole}</span>
          <span className="mono">{isRoot ? "root (hub)" : "daemon"}</span>
          <span className="text-muted">{t.dbgRouter}</span>
          <span className="mono">{router}</span>
          <span className="text-muted">{t.dbgRegistry}</span>
          <span className="mono">v{version}</span>
          <span className="text-muted">{t.dbgUrl}</span>
          <span className="mono">{self?.url ?? "—"}</span>
          <span className="text-muted">{t.dbgData}</span>
          <span className="mono">{dataDir}</span>
        </div>
      </Disclosure>
    </>
  );
}
