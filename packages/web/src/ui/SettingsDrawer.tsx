import { useEffect, useState } from "react";
import { api, type BaristaInfo } from "../api.ts";
import { useT } from "../i18n.ts";
import { refreshStore, useStore } from "../store.ts";
import { Pill } from "./bits.tsx";

export function SettingsDrawer({ onClose, closing = false }: { onClose: () => void; closing?: boolean }) {
  const t = useT();
  const host = useStore((s) => s.host);
  const isRoot = useStore((s) => s.isRoot);
  const daemons = useStore((s) => s.daemons);
  const agents = useStore((s) => s.agents);
  const self = daemons.find((d) => d.host === host);

  const [name, setName] = useState(self?.displayName ?? host);
  const [aliases, setAliases] = useState<string[]>(self?.aliases ?? []);
  const [alias, setAlias] = useState("");
  const [models, setModels] = useState<string[]>();
  const [model, setModel] = useState("");
  const [router, setRouter] = useState<{ router: string; model?: string; error?: string }>();
  const [baristas, setBaristas] = useState<BaristaInfo[]>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [hostEdits, setHostEdits] = useState<Record<string, string>>({});
  const [dir, setDir] = useState("");
  const [agentKind, setAgentKind] = useState("pi");
  const [write, setWrite] = useState(false);
  const [conn, setConn] = useState<{ root?: string; tokenHint?: string; tokenSet: boolean }>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setName(self?.displayName ?? host);
    setAliases(self?.aliases ?? []);
  }, [self?.displayName, self?.aliases?.join("|"), host]);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setRouter(h);
        setModel(h.model ?? "");
      })
      .catch((e) => setError(t.settingsLoadFailed((e as Error).message)));
    api
      .routerModels()
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
    api
      .baristas()
      .then((b) => setBaristas(b))
      .catch(() => setBaristas([]));
    api
      .settings()
      .then(setConn)
      .catch(() => setConn(undefined));
  }, []);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await refreshStore();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const saveHost = () =>
    void run("host", async () => {
      await api.setHostIdentity(name.trim() || host, aliases);
      return t.settingsSaved;
    });

  const applyModel = () =>
    void run("router", async () => {
      const r = await api.setRouterModel(model.trim() || null);
      setRouter(r);
      if (!r.ok) throw new Error(r.error ?? "router was not applied");
      return t.settingsApplied(`router: ${r.router}${r.model ? ` (${r.model})` : ""}`);
    });

  const renameAgent = (address: string, aliasOnly: boolean) =>
    void run(`agent:${address}`, async () => {
      const value = (edits[address] ?? "").trim();
      if (!value) return;
      if (aliasOnly) await api.aliasAgent(address, value);
      else await api.renameAgent(address, value);
      setEdits((e) => ({ ...e, [address]: "" }));
      return t.settingsSaved;
    });

  const stopBarista = (dir: string) =>
    void run(`barista:${dir}`, async () => {
      await api.stopBarista(dir);
      setBaristas(await api.baristas());
      return t.settingsSaved;
    });

  const startBarista = () =>
    void run("startBarista", async () => {
      const target = dir.trim();
      if (!target) return;
      if (agentKind === "pi") await api.startBarista({ dir: target });
      else if (agentKind === "omp") await api.startBarista({ dir: target, bin: "omp" });
      else await api.startBarista({ dir: target, agent: agentKind as "codex" | "claude", ...(write ? { access: "workspace-write" as const } : {}) });
      setBaristas(await api.baristas());
      return t.settingsStarted;
    });

  const renameHost = (host: string) =>
    void run(`host:${host}`, async () => {
      const value = (hostEdits[host] ?? "").trim();
      if (!value) return;
      await api.renameHost(host, value);
      setHostEdits((x) => ({ ...x, [host]: "" }));
      return t.settingsSaved;
    });

  const agentList = Object.values(agents).sort((a, b) => a.address.localeCompare(b.address));
  const routerText = router ? `${router.router}${router.model ? ` (${router.model})` : ""}` : "…";

  return (
    <aside aria-label={t.settingsTitle} className={`settings-drawer fixed inset-y-0 right-0 z-40 flex w-[min(430px,100vw)] flex-col border-l border-line bg-page shadow-float ${closing ? "is-closing" : ""}`}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <button type="button" className="iconbtn" aria-label={t.settingsTitle} onClick={onClose}>
          ✕
        </button>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg-strong">{t.settingsTitle}</div>
          <div className="mono text-[11px] text-muted">{t.settingsSub}</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {notice && (
          <div role="status" className="well mb-3 text-sm" data-tone="ok">
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="well mb-3 text-sm" data-tone="danger">
            {error}
          </div>
        )}

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsThisMachine}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsThisMachineDesc}</p>
          <div className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
              {t.settingsDisplayName}
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="button" className="btn-sm" aria-busy={busy === "host"} disabled={!name.trim()} onClick={saveHost}>
              {t.settingsSave}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {aliases.map((a) => (
              <span key={a} className="kind-tag">
                {a}
                <button type="button" className="ml-1 text-muted" aria-label={`remove ${a}`} onClick={() => setAliases((xs) => xs.filter((x) => x !== a))}>
                  ×
                </button>
              </span>
            ))}
            <input
              className="!min-h-0 w-24 !py-0.5 !text-xs"
              placeholder={t.settingsAliasPh}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && alias.trim()) {
                  e.preventDefault();
                  setAliases((xs) => [...new Set([...xs, alias.trim()])]);
                  setAlias("");
                }
              }}
            />
            <button
              type="button"
              className="btn-sm"
              disabled={!alias.trim()}
              onClick={() => {
                setAliases((xs) => [...new Set([...xs, alias.trim()])]);
                setAlias("");
              }}
            >
              {t.settingsAddAlias}
            </button>
          </div>
        </section>

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsMachines}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsMachinesDesc}</p>
          {daemons.map((d) => (
            <div key={d.host} className="flex flex-col gap-1.5 border-t border-line py-2 first:border-t-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <b className="truncate text-sm text-fg-strong">{d.displayName ?? d.host}</b>
                  <span className="mono truncate text-[11px] text-muted">{d.host}</span>
                </div>
                <span className={`text-[11px] ${d.online ? "text-ok" : "text-muted"}`}>{d.online ? t.online : t.mOffline}</span>
              </div>
              {d.host !== host && isRoot && (
                <div className="flex items-center gap-1.5">
                  <input
                    className="!min-h-0 min-w-0 flex-1 !py-1 !text-xs"
                    placeholder={t.settingsNewName}
                    value={hostEdits[d.host] ?? ""}
                    onChange={(e) => setHostEdits((x) => ({ ...x, [d.host]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        renameHost(d.host);
                      }
                    }}
                  />
                  <button type="button" className="btn-sm" aria-busy={busy === `host:${d.host}`} disabled={!(hostEdits[d.host] ?? "").trim()} onClick={() => renameHost(d.host)}>
                    {t.settingsRename}
                  </button>
                </div>
              )}
              {d.host !== host && !isRoot && <span className="hint">{t.settingsRootOnly}</span>}
            </div>
          ))}
        </section>

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsStartBarista}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsStartDesc}</p>
          <div className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
              {t.settingsDir}
              <input value={dir} placeholder={t.settingsDirPh} onChange={(e) => setDir(e.target.value)} />
            </label>
            <label className="flex w-24 flex-col gap-1 text-xs text-muted">
              {t.settingsAgent}
              <select value={agentKind} onChange={(e) => setAgentKind(e.target.value)}>
                <option value="pi">pi</option>
                <option value="omp">omp</option>
                <option value="codex">codex</option>
                <option value="claude">claude</option>
              </select>
            </label>
            <button type="button" className="btn-sm" aria-busy={busy === "startBarista"} disabled={!dir.trim()} onClick={startBarista}>
              {t.settingsStart}
            </button>
          </div>
          {(agentKind === "codex" || agentKind === "claude") && (
            <label className="mt-2 flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" className="!min-h-0" checked={write} onChange={(e) => setWrite(e.target.checked)} />
              {t.settingsAllowWrite}
            </label>
          )}
        </section>

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsRouting}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsRoutingDesc}</p>
          <div className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
              {t.settingsModel}
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">rules</option>
                {models === undefined && <option disabled>{t.loading}</option>}
                {models?.length === 0 && <option disabled>{t.settingsNoModels}</option>}
                {models?.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {model && !models?.includes(model) && <option value={model}>{model}</option>}
              </select>
            </label>
            <button type="button" className="btn-sm" aria-busy={busy === "router"} onClick={applyModel}>
              {t.settingsApply}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Pill tone={router?.error ? "warn" : "ok"}>{t.settingsRunning(routerText)}</Pill>
            {router?.error && <span className="text-warn">{t.settingsRouterError(router.error)}</span>}
          </div>
        </section>

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsAgents}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsAgentsDesc}</p>
          {agentList.map((a) => (
            <div key={a.agentId} className="flex flex-col gap-1.5 border-t border-line py-2 first:border-t-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <b className="truncate text-sm text-fg-strong">{a.displayName ?? a.name}</b>
                  <span className="mono truncate text-[11px] text-muted">{a.address}</span>
                </div>
                {a.host !== host && !isRoot && <span className="hint">{t.settingsRootOnly}</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  className="!min-h-0 min-w-0 flex-1 !py-1 !text-xs"
                  placeholder={t.settingsNewName}
                  value={edits[a.address] ?? ""}
                  onChange={(e) => setEdits((x) => ({ ...x, [a.address]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      renameAgent(a.address, false);
                    }
                  }}
                />
                <button type="button" className="btn-sm" aria-busy={busy === `agent:${a.address}`} disabled={!(edits[a.address] ?? "").trim()} onClick={() => renameAgent(a.address, false)}>
                  {t.settingsRename}
                </button>
                <button type="button" className="btn-sm" disabled={!(edits[a.address] ?? "").trim()} onClick={() => renameAgent(a.address, true)}>
                  {t.settingsAlias}
                </button>
              </div>
            </div>
          ))}
        </section>

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsBaristas}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsBaristasDesc}</p>
          {baristas === undefined ? (
            <div className="hint">{t.loading}</div>
          ) : baristas.length === 0 ? (
            <div className="hint">{t.settingsNoBaristas}</div>
          ) : (
            baristas.map((b) => (
              <div key={b.dir} className="flex items-center gap-2 border-t border-line py-2 first:border-t-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <b className="truncate text-sm text-fg-strong">{b.dir}</b>
                  <span className="text-[11px] text-muted">
                    {b.agent} · {b.running ? t.online : t.mOffline}
                  </span>
                </div>
                <button type="button" className="btn-sm btn-danger" aria-busy={busy === `barista:${b.dir}`} disabled={!b.running} onClick={() => stopBarista(b.dir)}>
                  {t.settingsStop}
                </button>
              </div>
            ))
          )}
        </section>

        <section>
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsConnection}</h3>
          <p className="mt-1 mb-2 text-xs text-muted">{t.settingsRestartDesc}</p>
          <div className="well flex flex-col gap-1.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">{t.settingsRoot}</span>
              <span className="mono truncate text-fg-strong">{conn ? (isRoot ? "self" : (conn.root ?? "mDNS")) : t.settingsLoading}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">{t.settingsToken}</span>
              <span className="mono truncate text-fg-strong">{conn ? (conn.tokenSet ? conn.tokenHint : t.settingsTokenNotSet) : t.settingsLoading}</span>
            </div>
          </div>
          <div className="mono mt-2 text-xs text-warn">cafe daemon restart</div>
        </section>
      </div>

      <div className="flex justify-end gap-2 border-t border-line bg-card px-4 py-3">
        <button type="button" onClick={onClose}>
          {t.cancel}
        </button>
        <button type="button" className="btn-primary" onClick={onClose}>
          {t.settingsDone}
        </button>
      </div>
    </aside>
  );
}