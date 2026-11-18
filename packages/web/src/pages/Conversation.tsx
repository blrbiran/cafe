import { useState } from "react";
import type { AgentRecord, Order, RoutingDecision, ThreadEnvelope, ThreadMeta, ThreadStatus } from "@cafe/protocol";
import { api, ApiError } from "../api.ts";
import { ago, useT, type Dict } from "../i18n.ts";
import { useNow } from "../format.ts";
import { whoAddress, whoName, whyText } from "../outcome.ts";
import { hashFor } from "../route.ts";
import { isActive, useStore } from "../store.ts";
import { Disclosure, Pill, type Tone } from "../ui/bits.tsx";
import { Markdown } from "../ui/Markdown.tsx";

interface Turn {
  orderId: string;
  order?: Order;
  startedAt: number;
  decision?: RoutingDecision;
  replies: { agentId: string; text: string; final: boolean; at: number }[];
  declines: { agentId: string; reason: string; at: number }[];
  failures: { agentId?: string; reason: string; at: number }[];
  acked: Set<string>;
  closed?: { status: ThreadStatus; at: number };
}

/** Group a Thread's events into turns (one per Order), oldest first. */
function buildTurns(events: ThreadEnvelope[]): Turn[] {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  for (const env of events) {
    let turn = byId.get(env.orderId);
    if (!turn) {
      turn = { orderId: env.orderId, startedAt: env.at, replies: [], declines: [], failures: [], acked: new Set() };
      byId.set(env.orderId, turn);
      turns.push(turn);
    }
    const ev = env.event;
    switch (ev.type) {
      case "order.created":
        turn.order = ev.order;
        turn.startedAt = ev.order.createdAt;
        break;
      case "order.routed":
        turn.decision = ev.decision;
        break;
      case "order.acked":
        turn.acked.add(ev.agentId);
        break;
      case "order.replied":
        turn.replies.push({ agentId: ev.agentId, text: ev.text, final: ev.final, at: env.at });
        break;
      case "order.declined":
        turn.declines.push({ agentId: ev.agentId, reason: ev.reason, at: env.at });
        break;
      case "order.failed":
        turn.failures.push({ agentId: ev.agentId, reason: ev.reason, at: env.at });
        break;
      case "order.closed":
        turn.closed = { status: ev.status, at: env.at };
        break;
    }
  }
  return turns.sort((a, b) => (a.order?.turn ?? 0) - (b.order?.turn ?? 0) || a.startedAt - b.startedAt);
}

function turnOutcome(t: Dict, turn: Turn, active: boolean, agents: Record<string, AgentRecord>, meta: ThreadMeta, now: number): { tone: Tone; text: string } {
  const names = (ids: string[]) => t.list([...new Set(ids.map((id) => whoName(id, agents, meta)))]);
  const finals = turn.replies.filter((r) => r.final);
  if (active) {
    const targets = turn.decision?.targets ?? [];
    if (!turn.decision || targets.length === 0) return { tone: "info", text: t.routing };
    const pending = targets.filter((id) => !finals.some((r) => r.agentId === id) && !turn.declines.some((d) => d.agentId === id));
    if (turn.acked.size === 0) return { tone: "info", text: t.delivering(names(pending.length ? pending : targets)) };
    return { tone: "info", text: t.working(names(pending.length ? pending : targets), t.dur(now - turn.startedAt)) };
  }
  if (turn.closed?.status === "cancelled") return { tone: undefined, text: t.cancelled };
  if (finals.length > 0) return { tone: "ok", text: t.answeredBy(names(finals.map((r) => r.agentId)), t.dur(finals[0]!.at - turn.startedAt)) };
  if (turn.declines.length > 0) return { tone: "warn", text: t.nobody(turn.declines.length) };
  return { tone: "danger", text: t.noAnswer };
}

function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

export function ConversationPage({ threadId }: { threadId: string }) {
  const t = useT();
  const now = useNow();
  const detail = useStore((s) => s.detail);
  const agents = useStore((s) => s.agents);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const back = (
    <div>
      <a className="linkbtn" href={hashFor({ page: "feed", filter: "all" })}>
        {t.back}
      </a>
    </div>
  );
  if (!detail || detail.meta.threadId !== threadId) {
    return (
      <>
        {back}
        <div className="hint">{t.loading}</div>
      </>
    );
  }

  const { meta, events } = detail;
  const turns = buildTurns(events);
  const threadActive = isActive(meta.status);
  const first = turns[0];
  const last = turns.at(-1);

  const stop = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.cancel(meta.threadId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {back}
      {turns.map((turn, i) => {
        const active = threadActive && turn === last;
        const o = turnOutcome(t, turn, active, agents, meta, now);
        const isFirst = i === 0;
        const asker = turn.order?.from.address ?? meta.from.address;
        const why = whyText(t, turn.decision);
        const targets = turn.decision?.targets ?? [];
        return (
          <div key={turn.orderId} className="flex flex-col gap-3.5">
            <div className="card flex flex-col gap-3 px-5.5 py-5">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                {turns.length > 1 && (
                  <Pill tone={undefined} dot={false}>
                    {t.turnLabel(turn.order?.turn ?? i + 1)}
                  </Pill>
                )}
                <span className="mono text-fg">{asker}</span>
                <span>{isFirst ? t.askedVerb : t.followUpLabel}</span>
                <span>· {ago(t, turn.startedAt, now)}</span>
              </div>
              {isFirst ? (
                <h1 className="m-0 text-xl leading-snug text-fg-strong">
                  <span className="prose-text">{turn.order?.body ?? meta.summary}</span>
                </h1>
              ) : (
                <div className="answer">
                  <Markdown text={turn.order?.body ?? ""} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2.5">
                <Pill tone={o.tone}>{o.text}</Pill>
                {active && (
                  <button type="button" className="btn-sm btn-danger" aria-busy={busy} onClick={() => void stop()}>
                    {t.stopWaiting}
                  </button>
                )}
              </div>
              {turn.decision && (
                <div className="well flex flex-col gap-1 px-3.5 py-2.5">
                  <div className="cap">{t.routedTo}</div>
                  <div className="text-base">
                    {targets.length ? (
                      <span className="mono text-fg-strong">{targets.map((id) => whoAddress(id, agents, meta)).join(", ")}</span>
                    ) : (
                      <span className="text-muted">{t.stepNoTarget}</span>
                    )}
                  </div>
                  {why && (
                    <div className="text-sm text-muted">
                      {t.why}
                      {why}
                    </div>
                  )}
                </div>
              )}
              {err && active && (
                <div role="alert" className="well text-sm" data-tone="danger">
                  {err}
                </div>
              )}
            </div>
            <Replies turn={turn} active={active} meta={meta} />
          </div>
        );
      })}
      {first === undefined && <div className="hint">{t.loading}</div>}
      <FollowUp meta={meta} busy={threadActive} />
      <Disclosure show={t.processShow} hide={t.processHide} open={showLog} onToggle={() => setShowLog((v) => !v)}>
        <DeliveryLog events={events} meta={meta} />
      </Disclosure>
    </>
  );
}

function Replies({ turn, active, meta }: { turn: Turn; active: boolean; meta: ThreadMeta }) {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const items = [
    ...turn.replies.map((r) => ({ key: `r-${r.at}-${r.agentId}`, who: r.agentId, at: r.at, tone: (r.final ? "ok" : "info") as Tone, kind: r.final ? t.kAnswer : t.kPartial, text: r.text, md: true })),
    ...turn.declines.map((d) => ({ key: `d-${d.at}-${d.agentId}`, who: d.agentId, at: d.at, tone: "warn" as Tone, kind: t.kDecline, text: d.reason, md: false })),
  ].sort((a, b) => a.at - b.at);
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="section-cap">{t.replies}</h2>
      {items.map((r) => (
        <div key={r.key} className="card flex flex-col gap-2 px-4.5 py-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="mono text-sm text-fg-strong">{whoAddress(r.who, agents, meta)}</span>
            <Pill tone={r.tone} dot={false}>
              {r.kind}
            </Pill>
            <span className="text-xs text-muted">{clockOf(r.at)}</span>
          </div>
          {r.md ? (
            <div className="answer">
              <Markdown text={r.text} />
            </div>
          ) : (
            <div className="answer prose-text">{r.text}</div>
          )}
        </div>
      ))}
      {items.length === 0 && <div className="well hint px-4.5 py-3.5">{active ? t.noRepliesYet : t.noReplyFinal}</div>}
    </section>
  );
}

function FollowUp({ meta, busy }: { meta: ThreadMeta; busy: boolean }) {
  const t = useT();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string>();
  const disabled = busy || sending;

  const send = async () => {
    if (!body.trim() || disabled) return;
    setSending(true);
    setErr(undefined);
    try {
      await api.createOrder({ body, threadId: meta.threadId });
      setBody("");
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "thread_busy" ? t.threadBusy : (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-2.5 px-4.5 py-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label className="cap" htmlFor="cafe-fu">
        {t.followUpTitle}
      </label>
      <div className="flex flex-wrap gap-2">
        <textarea
          id="cafe-fu"
          className="field flex-[1_1_280px]"
          rows={2}
          placeholder={t.followUpPh}
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <button type="submit" className="btn-primary self-end" disabled={disabled || !body.trim()} aria-busy={sending}>
          {sending ? t.sending : t.send}
        </button>
      </div>
      <div className="hint">{busy ? t.followUpBusy : t.followUpHint}</div>
      {err && (
        <div role="alert" className="well text-sm" data-tone="danger">
          {err}
        </div>
      )}
    </form>
  );
}

/** The delivery log in plain words; consecutive check-ins from one agent collapse into one line. */
function DeliveryLog({ events, meta }: { events: ThreadEnvelope[]; meta: ThreadMeta }) {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const name = (id?: string) => (id ? whoName(id, agents, meta) : t.someone);
  const steps: { at: string; text: string; key: string }[] = [];
  let lastBeat: { agentId: string; n: number; idx: number } | undefined;

  for (const env of events) {
    const ev = env.event;
    let text: string | undefined;
    if (ev.type === "order.heartbeat") {
      if (lastBeat && lastBeat.agentId === ev.agentId) {
        lastBeat.n++;
        steps[lastBeat.idx]!.text = t.stepCheckin(name(ev.agentId), lastBeat.n) + (ev.note ? ` · ${ev.note}` : "");
        continue;
      }
      text = t.stepCheckin(name(ev.agentId), 1) + (ev.note ? ` · ${ev.note}` : "");
      steps.push({ at: clockOf(env.at), text, key: env.eventId });
      lastBeat = { agentId: ev.agentId, n: 1, idx: steps.length - 1 };
      continue;
    }
    lastBeat = undefined;
    switch (ev.type) {
      case "order.created":
        text =
          ev.order.turn > 1
            ? t.stepFollowUp(ev.order.turn)
            : agents[ev.order.from.id] || ev.order.depth > 0
              ? t.stepReceivedFrom(ev.order.from.address)
              : t.stepReceived;
        break;
      case "order.routed": {
        const who = t.list(ev.decision.targets.map((id) => name(id)));
        if (ev.decision.targets.length === 0) text = t.stepNoTarget;
        else if (ev.decision.mode === "broadcast") text = t.stepEveryone(who);
        else text = t.stepPicked(who, t.router[ev.decision.router] ?? ev.decision.router);
        break;
      }
      case "order.delivered":
        text = t.stepDelivered(name(ev.agentId));
        break;
      case "order.acked":
        text = t.stepAccepted(name(ev.agentId));
        break;
      case "order.replied":
        text = ev.final ? t.stepReplied(name(ev.agentId)) : t.stepPartial(name(ev.agentId));
        break;
      case "order.declined":
        text = t.stepDeclined(name(ev.agentId));
        break;
      case "order.failed":
        text = t.stepFailed(name(ev.agentId), t.failReason[ev.reason] ?? ev.reason);
        break;
      case "order.cancelled":
        text = t.stepCancelled;
        break;
      case "order.closed":
        text = t.stepClosed[ev.status] ?? ev.status;
        break;
    }
    if (text) steps.push({ at: clockOf(env.at), text, key: env.eventId });
  }

  return (
    <div className="flex flex-col gap-2 py-1">
      {steps.map((s) => (
        <div key={s.key} className="flex items-baseline gap-3 text-sm">
          <span className="mono w-[92px] flex-none text-muted">{s.at}</span>
          <span>{s.text}</span>
        </div>
      ))}
    </div>
  );
}
