import { useState } from "react";
import type { AgentRecord } from "@cafe/protocol";
import { api } from "../api.ts";
import { hashFor } from "../route.ts";
import { useStore } from "../store.ts";
import { relTime, useNow } from "../format.ts";
import { Badge, Empty, Led, PageHeader } from "../ui/bits.tsx";

export function AgentsPage() {
  const agents = useStore((s) => s.agents);
  const host = useStore((s) => s.host);
  const version = useStore((s) => s.registryVersion);
  const [showOffline, setShowOffline] = useState(true);
  const list = Object.values(agents).filter((a) => showOffline || a.status !== "offline");
  const byHost = new Map<string, AgentRecord[]>();
  for (const a of list.sort((x, y) => x.address.localeCompare(y.address))) {
    const l = byHost.get(a.host) ?? [];
    l.push(a);
    byHost.set(a.host, l);
  }
  const hosts = [...byHost.keys()].sort((a, b) => (a === host ? -1 : b === host ? 1 : a.localeCompare(b)));

  return (
    <>
      <PageHeader
        title="Agents"
        meta={`registry v${version} · ${Object.keys(agents).length} registered`}
        actions={
          <label className="flex-row items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={showOffline} onChange={(e) => setShowOffline(e.target.checked)} />
            show offline
          </label>
        }
      />
      {hosts.length === 0 && <Empty>No agents registered. Start one with `cafe barista start` or open pi with the cafe extension.</Empty>}
      <div className="flex flex-col gap-4">
        {hosts.map((h) => (
          <section key={h} className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line-strong px-4 py-2">
              <h2 className="m-0 text-base">{h}</h2>
              {h === host && <Badge>this host</Badge>}
              <span className="meta ml-auto">{byHost.get(h)!.length} agents</span>
            </div>
            <div className="table-box">
              <table>
                <thead>
                  <tr>
                    <th>Address</th>
                    <th>Description</th>
                    <th>Scope</th>
                    <th>Mode</th>
                    <th>Role</th>
                    <th>Seen</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {byHost.get(h)!.map((a) => (
                    <AgentRow key={a.agentId} a={a} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function AgentRow({ a }: { a: AgentRecord }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  return (
    <tr className={a.status === "offline" ? "opacity-60" : undefined}>
      <td className="whitespace-nowrap">
        <div className="flex items-center gap-2">
          <Led status={a.status} />
          <a href={hashFor({ page: "threads", agent: a.agentId })} className="font-data text-xs">
            {a.address}
          </a>
        </div>
        <div className="meta pl-4">{a.status}</div>
      </td>
      <td className="min-w-48">
        <div className="text-fg-strong">{a.name}</div>
        {a.description && <div className="text-xs text-muted">{a.description}</div>}
        {a.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {a.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
        )}
      </td>
      <td className="meta">
        {a.scope.length ? a.scope.map((s) => <div key={s}>{s}</div>) : <div>{a.cwd}</div>}
      </td>
      <td>
        <Badge>{a.mode}</Badge>
      </td>
      <td>
        <Badge tone={a.role === "barista" ? "info" : undefined}>{a.role}</Badge>
        {a.role === "barista" && a.accept === "confirm" && <div className="meta mt-1">confirm</div>}
      </td>
      <td className="meta whitespace-nowrap num">{relTime(a.lastSeenAt, now)}</td>
      <td className="text-right">
        {a.status !== "offline" && (
          <button
            className="btn-quiet btn-sm"
            aria-busy={busy}
            title="Disconnect this agent"
            onClick={async () => {
              if (!confirm(`Disconnect ${a.address}?`)) return;
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
            kick
          </button>
        )}
        {err && <div className="text-xs text-danger">{err}</div>}
      </td>
    </tr>
  );
}
