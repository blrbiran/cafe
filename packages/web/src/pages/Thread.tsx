import { useState, type ReactNode } from "react";
import type { AgentRecord, ThreadEnvelope } from "@cafe/protocol";
import { api } from "../api.ts";
import { hashFor } from "../route.ts";
import { addressOf, useStore } from "../store.ts";
import { clock, duration, stamp } from "../format.ts";
import { Badge, PageHeader, StatusBadge, type Tone } from "../ui/bits.tsx";
import { Markdown } from "../ui/Markdown.tsx";

/** Consecutive heartbeats from the same agent collapse into one row. */
type Item = { env: ThreadEnvelope; count: number; last: ThreadEnvelope };

function collapse(events: ThreadEnvelope[]): Item[] {
  const out: Item[] = [];
  for (const env of events) {
    const prev = out.at(-1);
    if (
      prev &&
      env.event.type === "order.heartbeat" &&
      prev.env.event.type === "order.heartbeat" &&
      prev.env.event.agentId === env.event.agentId
    ) {
      prev.count++;
      prev.last = env;
      continue;
    }
    out.push({ env, count: 1, last: env });
  }
  return out;
}

export function ThreadPage({ threadId }: { threadId: string }) {
  const detail = useStore((s) => s.detail);
  const agents = useStore((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  if (!detail || detail.meta.threadId !== threadId) {
    return (
      <>
        <a href={hashFor({ page: "threads" })} className="meta">
          ← threads
        </a>
        <div className="meta mt-4">loading thread…</div>
      </>
    );
  }
  const { meta, events } = detail;
  const active = meta.status === "routing" || meta.status === "delivering" || meta.status === "working";

  return (
    <>
      <a href={hashFor({ page: "threads" })} className="meta mb-2 inline-block">
        ← threads
      </a>
      <PageHeader
        title={meta.kind === "notice" ? "Notice" : "Order"}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <span>thread {meta.threadId}</span>
            <span>· {stamp(meta.createdAt)}</span>
            {meta.firstReplyAt && <span>· first reply {duration(meta.firstReplyAt - meta.createdAt)}</span>}
            {meta.closedAt && <span>· closed after {duration(meta.closedAt - meta.createdAt)}</span>}
          </span>
        }
        actions={
          <>
            <StatusBadge status={meta.status} />
            {active && (
              <button
                aria-busy={busy}
                onClick={async () => {
                  setBusy(true);
                  setErr(undefined);
                  try {
                    await api.cancel(meta.threadId);
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Cancel
              </button>
            )}
          </>
        }
      />
      {err && (
        <div role="alert" className="well mb-3 text-sm" data-tone="danger">
          {err}
        </div>
      )}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {collapse(events).map((it) => (
          <EventRow key={it.env.eventId} item={it} agents={agents} />
        ))}
        {detail.loading && <li className="meta">loading events…</li>}
      </ol>
    </>
  );
}

function EventRow({ item, agents }: { item: Item; agents: Record<string, AgentRecord> }) {
  const { env, count, last } = item;
  const ev = env.event;
  const who = (id?: string) => (id ? <span className="font-data text-xs text-fg-strong">{addressOf(agents, id)}</span> : null);
  let tone: Tone;
  let label: string = ev.type;
  let body: ReactNode = null;
  let compact = false;

  switch (ev.type) {
    case "order.created":
      label = "order";
      body = (
        <>
          <div className="meta mb-2">
            from <span className="text-fg-strong">{ev.order.from.address}</span>
            {ev.order.to && <> · to {ev.order.to}</>}
            {ev.order.depth > 0 && <> · depth {ev.order.depth}</>}
            {ev.order.parentOrderId && <> · parent {ev.order.parentOrderId.slice(-8)}</>}
          </div>
          <Markdown text={ev.order.body} />
        </>
      );
      break;
    case "order.routed":
      label = "routed";
      tone = "info";
      body = (
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{ev.decision.mode}</Badge>
            <Badge>{ev.decision.router}</Badge>
            {ev.decision.targets.map((t) => (
              <span key={t}>{who(t)}</span>
            ))}
            {ev.decision.targets.length === 0 && <span className="text-muted">no targets</span>}
          </div>
          {ev.decision.reason && <div className="text-muted">{ev.decision.reason}</div>}
          {ev.decision.candidates.length > 0 && (
            <div className="meta">fallbacks: {ev.decision.candidates.map((c) => addressOf(agents, c)).join(", ")}</div>
          )}
        </div>
      );
      break;
    case "order.delivered":
      label = "delivered";
      compact = true;
      body = <>to {who(ev.agentId)}</>;
      break;
    case "order.acked":
      label = "acked";
      compact = true;
      body = <>by {who(ev.agentId)}</>;
      break;
    case "order.heartbeat":
      label = count > 1 ? `heartbeat ×${count}` : "heartbeat";
      compact = true;
      body = (
        <>
          {who(ev.agentId)}
          {last.event.type === "order.heartbeat" && last.event.note && <span className="ml-2 text-muted">{last.event.note}</span>}
          {count > 1 && <span className="meta ml-2">until {clock(last.at)}</span>}
        </>
      );
      break;
    case "order.replied":
      label = ev.final ? "reply" : "partial reply";
      tone = "ok";
      body = (
        <>
          <div className="meta mb-2">{who(ev.agentId)}</div>
          <Markdown text={ev.text} />
        </>
      );
      break;
    case "order.declined":
      label = "declined";
      tone = "warn";
      body = (
        <>
          {who(ev.agentId)} <span className="ml-2">{ev.reason}</span>
        </>
      );
      break;
    case "order.failed":
      label = "failed";
      tone = "danger";
      body = (
        <>
          {who(ev.agentId)} <span className="ml-2">{ev.reason}</span>
        </>
      );
      break;
    case "order.cancelled":
      label = "cancelled";
      tone = "warn";
      body = <>by {ev.by}</>;
      break;
    case "thread.closed":
      label = "closed";
      tone = ev.status === "done" ? "ok" : ev.status === "failed" ? "danger" : "warn";
      compact = true;
      body = <>status {ev.status}</>;
      break;
  }

  return (
    <li className={compact ? "flex items-baseline gap-3 px-3 text-sm" : "well"} data-tone={compact ? undefined : tone}>
      <div className={compact ? "contents" : "mb-1 flex items-baseline gap-3"}>
        <span className="meta w-28 flex-none num" title={stamp(env.at)}>
          {clock(env.at)}
        </span>
        <span className={`w-28 flex-none text-xs font-semibold uppercase tracking-wide ${toneText(tone)}`}>{label}</span>
        {compact && <span className="min-w-0 text-fg">{body}</span>}
        <span className="meta ml-auto">@{env.host}</span>
      </div>
      {!compact && <div className="min-w-0 pl-31 max-md:pl-0">{body}</div>}
    </li>
  );
}

function toneText(t: Tone): string {
  switch (t) {
    case "ok":
      return "text-ok";
    case "warn":
      return "text-warn";
    case "danger":
      return "text-danger";
    case "info":
      return "text-info";
    default:
      return "text-muted";
  }
}
