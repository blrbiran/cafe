import { useEffect, useState } from "react";
import { EncryptedAccess } from "./Security.tsx";
import { api, forgetToken, token, type BaristaInfo, type DoctorCheck, type RuntimeConfig } from "../api.ts";
import { agentAddress, agentLabel, removableAgentAliases, removableHostAliases } from "../display.ts";
import { useT } from "../i18n.ts";
import { joinCommands } from "../join.ts";
import { refreshStore, useStore } from "../store.ts";
import { Pill } from "./bits.tsx";

const show = (v: unknown) => (v === undefined ? "(not set)" : typeof v === "string" ? v : JSON.stringify(v));

export function SettingsDrawer({ onClose, closing = false }: { onClose: () => void; closing?: boolean }) {
  const t = useT();
  const host = useStore((s) => s.host);
  const isRoot = useStore((s) => s.isRoot);
  const daemons = useStore((s) => s.daemons);
  const agents = useStore((s) => s.agents);
  const self = daemons.find((d) => d.host === host);

  const [name, setName] = useState(self?.displayName ?? host);
  const [alias, setAlias] = useState("");
  const hostAliases = removableHostAliases(self);
  const [models, setModels] = useState<string[]>();
  const [model, setModel] = useState("");
  const [router, setRouter] = useState<{ router: string; model?: string; error?: string }>();
  const [baristas, setBaristas] = useState<BaristaInfo[]>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [hostEdits, setHostEdits] = useState<Record<string, string>>({});
  const [remoteAliases, setRemoteAliases] = useState<Record<string, string>>({});
  const [dir, setDir] = useState("");
  const [agentKind, setAgentKind] = useState("pi");
  const [write, setWrite] = useState(false);
  const [conn, setConn] = useState<Awaited<ReturnType<typeof api.settings>>>();
  const [joinCopied, setJoinCopied] = useState<string | null>(null);
  const [rt, setRt] = useState<RuntimeConfig>();
  const [advertise, setAdvertise] = useState("");
  const [retention, setRetention] = useState("");
  const [checks, setChecks] = useState<DoctorCheck[]>();
  const [upd, setUpd] = useState<Awaited<ReturnType<typeof api.update>>>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setName(self?.displayName ?? host);
  }, [self?.displayName, host]);

  useEffect(() => {
    if (!rt) return;
    setAdvertise(rt.advertise ?? "");
    setRetention(rt.retention?.days ? String(rt.retention.days) : "");
  }, [rt?.advertise, rt?.retention?.days]);

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
    api
      .config()
      .then(setRt)
      .catch(() => setRt(undefined));
    api
      .doctor()
      .then((d) => setChecks(d.checks))
      .catch(() => setChecks(undefined));
    api
      .update()
      .then(setUpd)
      .catch(() => setUpd(undefined));
  }, []);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await refreshStore();
      api.config().then(setRt).catch(() => {});
      api.doctor().then((d) => setChecks(d.checks)).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const saveHost = () =>
    void run("host", async () => {
      await api.setHostIdentity(name.trim() || host, []);
      return t.settingsSaved;
    });

  const addHostAlias = () =>
    void run("host", async () => {
      const a = alias.trim();
      if (!a) return;
      await api.setHostIdentity(name.trim() || host, [a]);
      setAlias("");
      return t.settingsSaved;
    });

  const removeHostAlias = (a: string) =>
    void run("host", async () => {
      await api.setHostIdentity(name.trim() || host, [], [a]);
      return t.settingsSaved;
    });

  const removeAgentAlias = (address: string, a: string) =>
    void run(`agent:${address}`, async () => {
      await api.removeAgentAlias(address, a);
      return t.settingsSaved;
    });

  const addRemoteHostAlias = (d: { host: string; displayName?: string }, a: string) =>
    void run(`host:${d.host}`, async () => {
      const x = a.trim();
      if (!x) return;
      await api.renameHost(d.host, d.displayName ?? d.host, [x]);
      setRemoteAliases((m) => ({ ...m, [d.host]: "" }));
      return t.settingsSaved;
    });

  const removeRemoteHostAlias = (d: { host: string; displayName?: string }, a: string) =>
    void run(`host:${d.host}`, async () => {
      await api.renameHost(d.host, d.displayName ?? d.host, [], [a]);
      return t.settingsSaved;
    });

  const saveNetwork = () =>
    void run("config", async () => {
      const days = retention.trim() ? Number(retention) : null;
      if (days !== null && (!Number.isInteger(days) || days < 1)) throw new Error(t.settingsRetentionInvalid);
      await api.saveConfig({ advertise: advertise.trim() || null, retentionDays: days });
      return t.settingsRestartRequired;
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
            {hostAliases.map((a) => (
              <span key={a} className="kind-tag">
                {a}
                <button type="button" className="ml-1 text-muted" aria-label={`${t.removeAlias} ${a}`} disabled={busy === "host"} onClick={() => removeHostAlias(a)}>
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
                  addHostAlias();
                }
              }}
            />
            <button type="button" className="btn-sm" disabled={!alias.trim() || busy === "host"} onClick={addHostAlias}>
              {t.settingsAddAlias}
            </button>
            <span className="hint w-full">{t.settingsAliasKept}</span>
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
              {d.host !== host && isRoot && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {removableHostAliases(d).map((a) => (
                    <span key={a} className="kind-tag">
                      {a}
                      <button type="button" className="ml-1 text-muted" aria-label={`${t.removeAlias} ${a}`} disabled={busy === `host:${d.host}`} onClick={() => removeRemoteHostAlias(d, a)}>
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className="!min-h-0 w-24 !py-0.5 !text-xs"
                    placeholder={t.settingsAliasPh}
                    value={remoteAliases[d.host] ?? ""}
                    onChange={(e) => setRemoteAliases((m) => ({ ...m, [d.host]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (remoteAliases[d.host] ?? "").trim()) {
                        e.preventDefault();
                        addRemoteHostAlias(d, remoteAliases[d.host] ?? "");
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={!(remoteAliases[d.host] ?? "").trim() || busy === `host:${d.host}`}
                    onClick={() => addRemoteHostAlias(d, remoteAliases[d.host] ?? "")}
                  >
                    {t.settingsAddAlias}
                  </button>
                </div>
              )}
              {d.host !== host && !isRoot && <span className="hint">{t.settingsRootOnly}</span>}
            </div>
          ))}
        </section>

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsUpdate}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsUpdateDesc}</p>
          <div className="well flex flex-col gap-1 p-2 text-xs">
            <div>{t.updateCurrent}: {upd?.current ?? "—"}</div>
            <div>{t.updateLastGood}: {upd?.lastGood ?? "—"}</div>
            <div>{t.updatePending}: {upd?.pending ?? "—"}</div>
            <div>running: {upd?.running?.version ?? "—"}</div>
            {upd?.log?.length ? (
              <div className={upd.log.at(-1)!.ok ? "text-ok" : "text-danger"}>
                last: {upd.log.at(-1)!.action} {upd.log.at(-1)!.ok ? "ok" : (upd.log.at(-1)!.error ?? "failed")}
              </div>
            ) : null}
            <div className="hint">cafe update status · cafe update apply --file &lt;tgz&gt; · cafe update rollback</div>
          </div>
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

        {rt && rt.pending.length > 0 && (
          <section className="mb-5 border-b border-line pb-4" data-testid="pending-config">
            <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsPending}</h3>
            <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsPendingDesc}</p>
            <div className="well flex flex-col gap-2 text-xs">
              {rt.pending.map((p) => (
                <div key={p.key} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <b className="mono text-fg-strong">{p.key}</b>
                    <span className="mono text-muted">{t.settingsPendingValue(show(p.running), show(p.file))}</span>
                  </div>
                  <div className="mono text-warn">{p.mode === "hot" ? t.settingsPendingHot : t.settingsPendingRestart}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {checks && checks.length > 0 && (
          <section className="mb-5 border-b border-line pb-4">
            <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsHealth}</h3>
            <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsHealthDesc}</p>
            <div className="well flex flex-col gap-2 text-xs">
              {checks.map((c) => (
                <div key={c.name} className="flex flex-col gap-0.5 border-t border-line py-1.5 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <b className="mono text-fg-strong">{c.name}</b>
                    <Pill tone={c.level === "ok" ? "ok" : c.level === "warn" ? "warn" : "danger"}>
                      {c.level === "ok" ? t.settingsHealthOk : c.level === "warn" ? t.settingsHealthWarn : t.settingsHealthFail}
                    </Pill>
                  </div>
                  <div className="text-muted">{c.detail}</div>
                  {c.next && <div className="mono text-warn">{c.next}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsAgents}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsAgentsDesc}</p>
          {agentList.map((a) => (
            <div key={a.agentId} className="flex flex-col gap-1.5 border-t border-line py-2 first:border-t-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <b className="truncate text-sm text-fg-strong">{agentLabel(a, daemons)}</b>
                  <span className="mono truncate text-[11px] text-muted" title={a.address}>
                    {agentAddress(a, daemons)}
                  </span>
                  {removableAgentAliases(a).length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {removableAgentAliases(a).map((x) => (
                        <span key={x} className="kind-tag">
                          {x}
                          <button type="button" className="ml-1 text-muted" aria-label={`${t.removeAlias} ${x}`} disabled={busy === `agent:${a.address}`} onClick={() => removeAgentAlias(a.address, x)}>
                            ×
                          </button>
                        </span>
                      ))}
                    </span>
                  )}
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

        <section className="mb-5 border-b border-line pb-4">
          <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsNetwork}</h3>
          <p className="mt-1 mb-2.5 text-xs text-muted">{t.settingsNetworkDesc}</p>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              {t.settingsAdvertise}
              <input value={advertise} placeholder={t.settingsAdvertisePh} onChange={(e) => setAdvertise(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              {t.settingsRetention}
              <input type="number" min={1} value={retention} placeholder={t.settingsRetentionPh} onChange={(e) => setRetention(e.target.value)} />
            </label>
            <button type="button" className="btn-sm self-start" aria-busy={busy === "config"} onClick={saveNetwork}>
              {t.settingsSave}
            </button>
          </div>
        </section>

        <EncryptedAccess />

        {conn?.join && (
          <section className="mb-5 border-b border-line pb-4">
            <h3 className="m-0 text-sm font-semibold text-fg-strong">{t.settingsJoinTitle}</h3>
            <p className="mt-1 mb-2 text-xs text-muted">{t.settingsJoinDesc}</p>
            {(() => {
              const cmds = joinCommands(conn.join);
              return (
                <div className="flex flex-col gap-2 text-xs">
                  {cmds.length > 1 && <p className="m-0 text-muted">{t.settingsJoinMany(cmds.length)}</p>}
                  {cmds.map((cmd) => (
                    <div key={cmd} className="well flex flex-col gap-2">
                      <code className="mono break-all text-fg-strong">{cmd}</code>
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          className="btn-sm shrink-0 whitespace-nowrap"
                          onClick={() => {
                            void navigator.clipboard?.writeText(cmd).then(() => setJoinCopied(cmd), () => {});
                          }}
                        >
                          {joinCopied === cmd ? t.copied : t.settingsJoinCopy}
                        </button>
                      </div>
                    </div>
                  ))}
                  <span className="text-muted">{t.settingsJoinToken}</span>
                  {conn.join?.rootHostId && <span className="text-muted">{t.settingsJoinInvite}</span>}
                  {cmds.length > 1 && <span className="text-muted">{t.settingsJoinAdvertise}</span>}
                </div>
              );
            })()}
          </section>
        )}

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
          {token && (
            <div className="mt-3 flex flex-col gap-1.5">
              <p className="m-0 text-xs text-muted">{t.settingsForgetTokenDesc}</p>
              <button type="button" className="btn-sm self-start" onClick={forgetToken}>
                {t.settingsForgetToken}
              </button>
            </div>
          )}
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