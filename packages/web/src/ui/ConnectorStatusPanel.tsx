import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ConnectorStatusRow } from "@cafe/protocol";
import { api, ApiError } from "../api.ts";
import { useT } from "../i18n.ts";
import { Dot, Pill, type Tone } from "./bits.tsx";

const tones: Record<ConnectorStatusRow["state"], Tone> = {
  connected: "ok",
  connecting: "info",
  disconnected: "warn",
  running: undefined,
  stopped: undefined,
  crashed: "danger",
};

const ConnectorStatus = createContext<{ rows?: ConnectorStatusRow[]; error?: "auth" | "unavailable" }>({});

export function ConnectorStatusProvider({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<ConnectorStatusRow[]>();
  const [error, setError] = useState<"auth" | "unavailable">();

  useEffect(() => {
    let disposed = false;
    let request: AbortController | undefined;
    let nextPoll: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (disposed || request || document.hidden) return;
      clearTimeout(nextPoll);
      const current = new AbortController();
      request = current;
      const deadline = setTimeout(() => current.abort(), 5_000);
      try {
        const next = await api.connectors(current.signal);
        if (disposed) return;
        setRows(next);
        setError(undefined);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof ApiError && err.code === "unauthorized" ? "auth" : "unavailable");
      } finally {
        clearTimeout(deadline);
        request = undefined;
        if (!disposed && !document.hidden) nextPoll = setTimeout(refresh, 5_000);
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) clearTimeout(nextPoll);
      else void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();
    return () => {
      disposed = true;
      request?.abort();
      clearTimeout(nextPoll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return <ConnectorStatus.Provider value={{ rows, error }}>{children}</ConnectorStatus.Provider>;
}

function connectorName(name: string): string {
  return name === "discord" ? "Discord Connector" : name;
}

export function ConnectorSidebar() {
  const t = useT();
  const { rows, error } = useContext(ConnectorStatus);
  if (!rows?.length) return null;
  return (
    <div className="mt-1 border-t border-line px-2 pt-1.5">
      <div className="text-[10px] font-semibold text-muted">{t.connectorsTitle}</div>
      <ul role="list" aria-label={t.connectorsTitle} className="m-0 list-none p-0">
        {rows.map(({ name, state }) => {
          const label = connectorName(name);
          const status = error ? t.connectorUnknown : (t.connectorStates[state] ?? t.connectorUnknown);
          return (
            <li key={name} className="flex items-center gap-1.5 py-1 text-xs" title={`${label} · ${status}`}>
              <Dot tone={error ? undefined : tones[state]} />
              <span className="min-w-0 truncate text-fg">{label}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted">{status}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ConnectorStatusPanel() {
  const t = useT();
  const { rows, error } = useContext(ConnectorStatus);
  return (
    <section aria-labelledby="agents-connectors" className="card min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
        <h2 id="agents-connectors" className="m-0 text-base font-semibold text-fg-strong">{t.connectorsTitle}</h2>
        <span className="text-xs text-muted">{t.thisMachine}</span>
      </div>
      <div role="status">
        {error && (
          <p className="m-0 border-t border-line px-4 py-2.5 text-sm text-warn">
            {error === "auth" ? t.connectorsUnauthorized : t.connectorsUnavailable}
            {rows?.length ? ` ${t.connectorsLastKnown}` : null}
          </p>
        )}
        {rows?.length ? (
          <ul role="list" className="m-0 list-none p-0">
            {rows.map(({ name, state }) => (
              <li key={name} className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
                <span title={connectorName(name)} className="min-w-0 truncate text-sm text-fg-strong">{connectorName(name)}</span>
                <Pill tone={error ? undefined : tones[state]}>{t.connectorStates[state] ?? t.connectorUnknown}</Pill>
              </li>
            ))}
          </ul>
        ) : !error && (
          <p className="m-0 border-t border-line px-4 py-3 text-sm text-muted">
            {rows ? t.connectorsEmpty : t.loading}
          </p>
        )}
      </div>
      {rows?.some(({ name }) => name === "discord") && (
        <p className="m-0 border-t border-line px-4 py-2.5 text-xs text-muted">{t.connectorsDiscordHint}</p>
      )}
    </section>
  );
}
