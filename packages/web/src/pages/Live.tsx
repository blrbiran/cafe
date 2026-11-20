import { useState } from "react";
import type { ThreadEnvelope } from "@cafe/protocol";
import { ago, useT, type Dict } from "../i18n.ts";
import { clock, useNow } from "../format.ts";
import { navigate } from "../route.ts";
import { useStore } from "../store.ts";
import { hostLabel as displayHost } from "../display.ts";
import { Empty, PageHeader } from "../ui/bits.tsx";

const FAILED = new Set(["order.failed", "order.declined"]);

function eventText(t: Dict, agents: Record<string, { address: string }>, env: ThreadEnvelope): string {
  const name = (id?: string) => (id ? (agents[id]?.address ?? id.slice(-8)) : t.someone);
  const ev = env.event;
  switch (ev.type) {
    case "order.created":
      return t.eventCreated(ev.order.from.address);
    case "order.routed": {
      const who = ev.decision.targets.map((id) => name(id)).join(", ") || "—";
      const how = t.router[ev.decision.router] ?? ev.decision.router;
      return ev.decision.mode === "broadcast" ? t.eventRoutedAll(who) : t.eventRouted(who, how, ev.decision.reason);
    }
    case "order.delivered":
      return t.eventDelivered(name(ev.agentId));
    case "order.acked":
      return t.eventAcked(name(ev.agentId));
    case "order.replied":
      return t.eventReplied(name(ev.agentId), ev.final);
    case "order.declined":
      return t.eventDeclined(name(ev.agentId));
    case "order.failed":
      return t.eventFailed(name(ev.agentId), t.failReason[ev.reason] ?? ev.reason);
    case "order.closed":
      return t.eventClosed(t.stepClosed[ev.status] ?? ev.status);
    case "order.cancelled":
      return t.eventCancelled;
    case "order.heartbeat":
      return `${name(ev.agentId)}${ev.note ? ` · ${ev.note}` : ""}`;
  }
}

function tagClass(type: string): string {
  if (type === "order.acked" || type === "order.replied") return "text-ok bg-ok-subtle border-ok";
  if (type === "order.failed") return "text-danger bg-danger-subtle border-danger";
  if (type === "order.declined" || type === "order.cancelled") return "text-warn bg-warn-subtle border-warn";
  if (type === "order.routed" || type === "order.delivered") return "text-info bg-info-subtle border-info";
  return "text-muted bg-well border-line-strong";
}

export function LivePage() {
  const t = useT();
  const events = useStore((s) => s.events);
  const agents = useStore((s) => s.agents);
  const daemons = useStore((s) => s.daemons);
  const [host, setHost] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<ThreadEnvelope[]>([]);
  const now = useNow(1_000);

  const shown = paused ? frozen : events;
  const rows = shown.filter((e) => (!host || e.host === host) && (!failedOnly || FAILED.has(e.event.type)));
  const latest = shown[0]?.at;
  const hosts = [...new Set(daemons.map((d) => d.host))].sort();
  const hostLabel = (h: string) => displayHost(h, daemons);

  const togglePause = () => {
    if (!paused) setFrozen(events);
    setPaused((v) => !v);
  };

  return (
    <>
      <PageHeader title={t.liveTitle} sub={t.liveSub} />
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t.liveTitle} className="flex flex-wrap gap-2">
          <button type="button" className="chip" aria-pressed={!host && !failedOnly} onClick={() => { setHost(""); setFailedOnly(false); }}>
            {t.liveAll}
          </button>
          {hosts.map((h) => (
            <button key={h} type="button" className="chip" aria-pressed={host === h} onClick={() => setHost(host === h ? "" : h)}>
              {hostLabel(h)}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={failedOnly} onClick={() => setFailedOnly((v) => !v)}>
            {t.liveFailed}
          </button>
        </div>
        <div className="grow" />
        <span className="hint flex items-center gap-1.5">
          <span className="dot" data-dot={paused ? undefined : "ok"} />
          {t.liveSynced(latest ? ago(t, latest, now) : t.justNow)}
        </span>
        <button type="button" className="btn-sm" onClick={togglePause}>
          {paused ? t.liveResume : t.livePause}
        </button>
      </div>

      {rows.length === 0 ? (
        <Empty>{t.liveEmpty}</Empty>
      ) : (
        <div className={`mt-3 overflow-hidden rounded-card border border-line bg-card ${paused ? "opacity-70" : ""}`}>
          {rows.map((env) => (
            <button
              key={`${env.threadId}-${env.eventId}`}
              type="button"
              className="grid w-full grid-cols-[72px_92px_1fr] items-baseline gap-2.5 rounded-none border-0 border-b border-line bg-transparent px-3.5 py-2.5 text-left shadow-none last:border-b-0 hover:bg-hover max-md:grid-cols-[60px_1fr]"
              onClick={() => navigate({ page: "thread", threadId: env.threadId })}
            >
              <span className="mono text-[11px] text-muted">{clock(env.at)}</span>
              <span className={`justify-self-start rounded-[5px] border px-1.5 text-[10px] font-semibold ${tagClass(env.event.type)} max-md:hidden`}>
                {t.eventType[env.event.type] ?? env.event.type}
              </span>
              <span className="min-w-0 text-sm text-fg max-md:col-start-2">
                <span className="mono mr-2 text-[11px] text-muted">{env.threadId.slice(-6)}</span>
                {eventText(t, agents, env)}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="hint">{t.liveHiddenBeat}</div>
    </>
  );
}