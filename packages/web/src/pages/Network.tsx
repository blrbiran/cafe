import { useState } from "react";
import { hostFailure, savedAddressNote } from "../hostReason.ts";
import { onlineVersions } from "@cafe/protocol/version";
import { ago, useT } from "../i18n.ts";
import { useNow } from "../format.ts";
import { api } from "../api.ts";
import { hostLabel } from "../display.ts";
import { refreshStore, useStore } from "../store.ts";
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
  const [busy, setBusy] = useState<string>();
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [editingAddr, setEditingAddr] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, { text: string; ok: boolean }>>({});

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      setNote((n) => ({ ...n, [key.split(":")[1]!]: { text: (err as Error).message, ok: false } }));
    } finally {
      setBusy(undefined);
    }
  };
  const test = (h: string) =>
    run(`test:${h}`, async () => {
      const r = await api.testHost(h);
      setNote((n) => ({ ...n, [h]: r.online ? { text: `${t.hostReachable}${r.latencyMs !== undefined ? ` · ${r.latencyMs}ms` : ""}`, ok: true } : { text: hostFailure(t, r), ok: false } }));
    });
  const reconnect = (h: string) =>
    run(`reconnect:${h}`, async () => {
      const r = await api.reconnectHost(h);
      await refreshStore();
      setNote((n) => ({ ...n, [h]: r.online ? { text: t.hostReachable, ok: true } : { text: hostFailure(t, r), ok: false } }));
    });
  const rename = (h: string, self: boolean) =>
    run(`rename:${h}`, async () => {
      const name = (editing[h] ?? "").trim();
      if (!name) return;
      if (self) await api.setHostIdentity(name, []);
      else await api.renameHost(h, name);
      setEditing((e) => ({ ...e, [h]: "" }));
      await refreshStore();
      setNote((n) => ({ ...n, [h]: { text: t.settingsSaved, ok: true } }));
    });
  const saveAddress = (h: string) =>
    run(`addr:${h}`, async () => {
      const url = (editingAddr[h] ?? "").trim();
      if (!url) return;
      const saved = await api.setHostAddress(h, url);
      setEditingAddr((e) => ({ ...e, [h]: undefined as unknown as string }));
      await refreshStore();
      setNote((n) => ({ ...n, [h]: savedAddressNote(t, saved) }));
    });
  const copyCli = (h: string, self: boolean) => {
    const cmd = self ? "cafe daemon status" : `cafe root test ${h}`;
    void navigator.clipboard?.writeText(cmd).then(() => setNote((n) => ({ ...n, [h]: { text: `${t.copied}: ${cmd}`, ok: true } })));
  };

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
            const name = !isThis && d.isRoot && d.host === "root" ? t.hub : hostLabel(d.host, daemons);
            const badges = [d.isRoot || (isThis && isRoot) ? t.hub : undefined, isThis ? t.thisMachine : undefined].filter(Boolean) as string[];
            return (
              <article key={`${d.host}-${d.isRoot}`} className="card flex flex-col gap-2.5 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="mono truncate text-base text-fg-strong">{name}</span>
                    {name !== d.host && <span className="mono truncate text-[11px] text-muted">{d.host}</span>}
                  </div>
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" className="btn-sm" aria-busy={busy === `test:${d.host}`} onClick={() => test(d.host)}>
                    {busy === `test:${d.host}` ? t.hostTesting : t.hostTest}
                  </button>
                  {!isThis && isRoot && !d.online && (
                    <button type="button" className="btn-sm" aria-busy={busy === `reconnect:${d.host}`} onClick={() => reconnect(d.host)}>
                      {t.hostReconnect}
                    </button>
                  )}
                  {(isThis || isRoot) && (
                    <button type="button" className="btn-sm" onClick={() => setEditing((e) => ({ ...e, [d.host]: e[d.host] ?? "" }))}>
                      {t.settingsRename}
                    </button>
                  )}
                  {!isThis && isRoot && (
                    <button type="button" className="btn-sm" onClick={() => setEditingAddr((e) => ({ ...e, [d.host]: e[d.host] ?? d.url.replace(/^wss?:\/\//, "") }))}>
                      {t.hostAddressEdit}
                    </button>
                  )}
                  <button type="button" className="btn-sm" onClick={() => copyCli(d.host, isThis)}>
                    {t.copyCommand}
                  </button>
                </div>
                {editing[d.host] !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <input
                      className="!min-h-0 min-w-0 flex-1 !py-1 !text-xs"
                      placeholder={t.settingsNewName}
                      value={editing[d.host]}
                      onChange={(e) => setEditing((x) => ({ ...x, [d.host]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void rename(d.host, isThis);
                        }
                      }}
                    />
                    <button type="button" className="btn-sm" aria-busy={busy === `rename:${d.host}`} disabled={!(editing[d.host] ?? "").trim()} onClick={() => rename(d.host, isThis)}>
                      {t.settingsSave}
                    </button>
                  </div>
                )}
                {editingAddr[d.host] !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <input
                      className="!min-h-0 min-w-0 flex-1 !py-1 !text-xs"
                      placeholder={t.hostAddressHint}
                      value={editingAddr[d.host]}
                      onChange={(e) => setEditingAddr((x) => ({ ...x, [d.host]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void saveAddress(d.host);
                        }
                      }}
                    />
                    <button type="button" className="btn-sm" aria-busy={busy === `addr:${d.host}`} disabled={!(editingAddr[d.host] ?? "").trim()} onClick={() => saveAddress(d.host)}>
                      {t.settingsSave}
                    </button>
                  </div>
                )}
                {!isThis && !isRoot && <span className="hint">{t.settingsRootOnly}</span>}
                {note[d.host] && <div className={`text-xs ${note[d.host]!.ok ? "text-ok" : "text-danger"}`}>{note[d.host]!.text}</div>}
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
