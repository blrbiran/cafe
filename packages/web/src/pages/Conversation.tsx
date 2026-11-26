import { useEffect, useMemo, useState } from "react";
import type { AgentRecord, Attachment, Order, RoutingDecision, ThreadEnvelope, ThreadMeta, ThreadStatus } from "@cafe/protocol";
import { api, ApiError, token } from "../api.ts";
import { ago, useT, type Dict } from "../i18n.ts";
import { useNow } from "../format.ts";
import { askerOf, whoAddress, whoName, whyText } from "../outcome.ts";
import { hashFor } from "../route.ts";
import { isActive, loadOlderEvents, useStore } from "../store.ts";
import { Disclosure, KindTag, Pill, type Tone } from "../ui/bits.tsx";
import { Markdown } from "../ui/Markdown.tsx";

interface Turn {
  orderId: string;
  order?: Order;
  startedAt: number;
  decision?: RoutingDecision;
  replies: { agentId: string; text: string; final: boolean; at: number; source?: "agent" | "operator"; attachments?: Attachment[]; report?: boolean }[];
  declines: { agentId: string; reason: string; at: number }[];
  /** `collect: all` deadline silences: recorded, but not a refusal (v4-11). */
  skips: { agentId: string; reason: string; at: number }[];
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
      turn = { orderId: env.orderId, startedAt: env.at, replies: [], declines: [], skips: [], failures: [], acked: new Set() };
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
      case "order.reported":
        turn.replies.push({ agentId: ev.agentId, text: ev.text, final: false, at: env.at, report: true });
        break;
      case "order.replied":
        turn.replies.push({ agentId: ev.agentId, text: ev.text, final: ev.final, at: env.at, source: ev.source, ...(ev.attachments?.length ? { attachments: ev.attachments } : {}) });
        break;
      case "order.declined":
        if (ev.skipped) turn.skips.push({ agentId: ev.agentId, reason: ev.reason, at: env.at });
        else turn.declines.push({ agentId: ev.agentId, reason: ev.reason, at: env.at });
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
  if (turn.decision?.needsHuman) return { tone: "warn", text: t.needsHuman };
  if (active) {
    const targets = turn.decision?.targets ?? [];
    if (!turn.decision || targets.length === 0) return { tone: "info", text: t.routing };
    const pending = targets.filter((id) => !finals.some((r) => r.agentId === id) && !turn.declines.some((d) => d.agentId === id) && !turn.skips.some((s) => s.agentId === id));
    if (turn.acked.size === 0) return { tone: "info", text: t.delivering(names(pending.length ? pending : targets)) };
    return { tone: "info", text: t.working(names(pending.length ? pending : targets), t.dur(now - turn.startedAt)) };
  }
  if (turn.closed?.status === "cancelled") return { tone: undefined, text: t.cancelled };
  if (finals.some((reply) => reply.source === "operator")) return { tone: "warn", text: t.operatorOverride(names(finals.map((reply) => reply.agentId))) };
  if (finals.length > 0) return { tone: "ok", text: t.answeredBy(names(finals.map((r) => r.agentId)), t.dur(finals[0]!.at - turn.startedAt)) };
  if (turn.declines.length > 0) return { tone: "warn", text: t.nobody(turn.declines.length) };
  if (finals.length === 0 && turn.skips.length > 0) return { tone: "info", text: t.skipped(turn.skips.length) };
  return { tone: "danger", text: t.noAnswer };
}

/**
 * The outcome text of a turn. Only this ticks every second while the turn is working, so a long
 * conversation is not re-rendered each second just to advance one duration (#33).
 */
function OutcomeText({ turn, active, agents, meta }: { turn: Turn; active: boolean; agents: Record<string, AgentRecord>; meta: ThreadMeta }) {
  const t = useT();
  const now = useNow(active ? 1_000 : 30_000);
  return <>{turnOutcome(t, turn, active, agents, meta, now).text}</>;
}

function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

export function ConversationPage({ threadId, drawer = false, onClose }: { threadId: string; drawer?: boolean; onClose?: () => void }) {
  const t = useT();
  const detail = useStore((s) => s.detail);
  const agents = useStore((s) => s.agents);
  const threadStatus = detail?.meta.status ?? "";
  const threadActive = isActive(threadStatus);
  // Relative times ("3 min ago") only; live durations tick in <OutcomeText>.
  const now = useNow(30_000);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [copied, setCopied] = useState(false);

  const events = detail?.events ?? [];
  const turns = useMemo(() => buildTurns(events), [events]);

  // v4-13 (#112): assignments and clarifications are separate Threads linked by parentThreadId.
  // The store carries the live ones; the API page catches children outside the snapshot.
  const connected = useStore((s) => s.connected);
  const rootOnline = useStore((s) => s.rootOnline);
  const childActivity = useStore((s) => s.linkedActivity);
  const [childView, setChildView] = useState<{ threadId: string; children: ThreadMeta[]; partial: boolean }>();
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api.children(threadId).then((view) => {
        if (!alive) return;
        setChildView((previous) => {
          if (!view.partial || previous?.threadId !== threadId) return { ...view, threadId };
          const known = new Map(previous.children.map((child) => [child.threadId, child]));
          for (const child of view.children) {
            const seen = known.get(child.threadId);
            if (!seen || (child.lastActivityAt ?? 0) >= (seen.lastActivityAt ?? 0)) known.set(child.threadId, child);
          }
          return { threadId, partial: true, children: [...known.values()] };
        });
      }).catch(() => {
        if (alive) setChildView((previous) => previous?.threadId === threadId
          ? { ...previous, partial: true }
          : { threadId, children: [], partial: true });
      });
    }, 80);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [threadId, connected, rootOnline, childActivity]);
  const children = useMemo(() => childView?.threadId === threadId ? childView.children.filter((t) => t.parentThreadId === threadId) : [], [childView, threadId]);
  const linkedTasks = children.filter((child) => !child.clarification);
  const clarificationThreads = children.filter((child) => child.clarification);

  const copy = () => {
    if (!detail) return;
    void navigator.clipboard?.writeText(detail.meta.threadId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const back = (
    <div className="flex flex-wrap gap-3">
      <a className="linkbtn" href={hashFor({ page: "feed", filter: "all", channel: detail?.meta.channel ?? "default" })}>
        {t.back}
      </a>
      {detail?.meta.parentThreadId && (
        <a className="linkbtn" href={hashFor({ page: "thread", threadId: detail.meta.parentThreadId, channel: detail.meta.channel ?? "default" })}>
          {t.backToParent}
        </a>
      )}
    </div>
  );

  if (!detail || detail.meta.threadId !== threadId) {
    return (
      <>
        {!drawer && back}
        <div className="hint">{t.loading}</div>
      </>
    );
  }

  const { meta } = detail;
  const taskStatus = meta.taskStatus;
  const taskLabel = taskStatus === "working" ? t.taskWorking
    : taskStatus === "awaiting_report" ? t.taskAwaitingReport
    : taskStatus === "unknown" ? t.taskStatusUnknown
    : undefined;
  const taskStatusText = taskLabel ? `${t.taskStatusPrefix}${taskLabel}` : undefined;
  const first = turns[0];
  const last = turns.at(-1);
  // The tone does not depend on the clock; the text ticks on its own in <OutcomeText>.
  const lastTone = last ? turnOutcome(t, last, threadActive, agents, meta, now).tone : undefined;
  const lastOutcome = last ? <OutcomeText turn={last} active={threadActive} agents={agents} meta={meta} /> : undefined;
  const participants = [...new Set([meta.from.address, ...turns.flatMap((turn) => turn.replies.map((r) => whoAddress(r.agentId, agents, meta)))])];
  const routerText = last?.decision ? (t.router[last.decision.router] ?? last.decision.router) : "—";

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

  const main = (
    <div className="thread-main flex flex-col gap-5">
      {drawer && (
        <div className="thread-summary well grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-2.5 text-xs min-[900px]:grid-cols-4">
          <div>
            <div className="cap">{t.ctxStatus}</div>
            <div className="text-fg-strong">{lastOutcome ?? t.loading}</div>
            {taskStatusText && <div className="mt-1 text-warn">{taskStatusText}</div>}
          </div>
          <div>
            <div className="cap">{t.ctxPeople}</div>
            <div className="truncate text-fg-strong">{participants.map((p) => p.replace(/@.*$/, "")).join(" · ")}</div>
          </div>
          <div>
            <div className="cap">{t.ctxTurns}</div>
            <div className="text-fg-strong">{t.turns(turns.length || 1)}</div>
          </div>
          <div>
            <div className="cap">{t.ctxRouter}</div>
            <div className="text-fg-strong">{routerText}</div>
          </div>
        </div>
      )}

      {detail.hasMore && (
        <div className="flex justify-center">
          <button type="button" className="btn-sm" aria-busy={detail.loadingOlder} disabled={detail.loadingOlder} onClick={() => void loadOlderEvents()}>
            {detail.loadingOlder ? t.loadingOlder : t.loadOlder}
          </button>
        </div>
      )}

      {childView?.threadId === threadId && childView.partial && (taskStatus === "unknown" || linkedTasks.length > 0) && <p className="hint" role="status">{t.linkedTasksPartial}</p>}
      <p className={taskStatusText ? "well text-sm" : "sr-only"} role="status" aria-live="polite" aria-atomic="true">{taskStatusText ?? ""}</p>
      {clarificationThreads.map((child) => <Clarification key={child.threadId} parent={meta.threadId} child={child} />)}
      {turns.map((turn, i) => {
        const active = threadActive && turn === last;
        const o = turnOutcome(t, turn, active, agents, meta, now);
        const isFirst = i === 0;
        const asker = askerOf(t, turn.order ?? meta, !isFirst);
        const why = whyText(t, turn.decision, agents, meta);
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
                <span className="mono text-fg">{asker.who}</span>
                <span>{asker.verb}</span>
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
              <AttachmentList items={turn.order?.attachments} />
              <div className="flex flex-wrap items-center gap-2.5">
                <Pill tone={o.tone}>
                  <OutcomeText turn={turn} active={active} agents={agents} meta={meta} />
                </Pill>
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
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {targets.map((id) => (
                          <span key={id} className="inline-flex items-center gap-2">
                            <span className="mono text-fg-strong">{whoAddress(id, agents, meta)}</span>
                            <KindTag a={agents[id]} />
                          </span>
                        ))}
                      </span>
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
            <LinkedTasks children={linkedTasks.filter((child) => child.parentOrderId === turn.orderId)} meta={meta} agents={agents} />
          </div>
        );
      })}
      <LinkedTasks children={linkedTasks.filter((child) => !turns.some((turn) => turn.orderId === child.parentOrderId))} meta={meta} agents={agents} />
      {meta.targetStates?.length ? (
        <div className="card flex flex-col gap-2 px-5 py-4">
          <div className="cap">{t.latestTargets}</div>
          <div className="flex flex-wrap gap-2">
            {meta.targetStates.map((s) => (
              <Pill key={s.agentId} tone={s.state === "replied" ? "ok" : s.state === "declined" ? "warn" : s.state === "failed" ? "danger" : "info"}>
                <span className="mono">{whoAddress(s.agentId, agents, meta)}</span> · {t.targetState[s.state] ?? s.state}
              </Pill>
            ))}
          </div>
        </div>
      ) : null}
      {first === undefined && <div className="hint">{t.loading}</div>}
      <Disclosure show={t.processShow} hide={t.processHide} open={showLog} onToggle={() => setShowLog((v) => !v)}>
        <DeliveryLog events={events} meta={meta} />
      </Disclosure>
    </div>
  );

  // Wide screens show the rail (status, people, router, turns) beside the thread. The thread summary
// grid in the body carries the same four facts and is hidden at ≥1920 px (`.thread-summary` in
// index.css), so nothing is rendered twice (#64). The thread id stays in the header and the
// delivery log in the body's disclosure; the rail does not repeat them.
  const rail = (
    <aside className="thread-rail" aria-label={t.navFeed}>
      <div className="card flex flex-col gap-1.5 p-3 text-xs">
        <div className="cap">{t.ctxStatus}</div>
        <div className="text-fg-strong">{lastOutcome ?? "—"}</div>
        <div className="text-muted">
          {t.ctxRouter}: {routerText}
        </div>
        <div className="text-muted">
          {t.ctxTurns}: {t.turns(turns.length || 1)}
        </div>
      </div>
      <div className="card flex flex-col gap-1 p-3 text-xs">
        <div className="cap">{t.ctxPeople}</div>
        {participants.map((p) => (
          <div key={p} className="mono truncate">
            {p}
          </div>
        ))}
      </div>
    </aside>
  );

  if (drawer) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <button type="button" className="iconbtn" aria-label={t.drawerClose} onClick={onClose}>
            ✕
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-fg-strong">{first?.order?.body ?? meta.summary}</div>
            <div className="mono truncate text-[11px] text-muted">{meta.threadId}</div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {lastOutcome && <Pill tone={lastTone}>{lastOutcome}</Pill>}
            <button type="button" className="btn-sm whitespace-nowrap max-md:hidden" onClick={copy}>
              {copied ? t.copied : t.copyId}
            </button>
          </div>
        </header>
        <div className="thread-body min-h-0 flex-1 overflow-y-auto px-5 py-4 max-md:px-4">
          {main}
          {rail}
        </div>
        <div className="border-t border-line bg-card px-5 py-3 max-md:px-4">
          {!meta.clarification && <FollowUp meta={meta} busy={threadActive} drawer />}
          {meta.clarification && back}
        </div>
      </div>
    );
  }

  return (
    <>
      {back}
      {main}
      {!meta.clarification && <FollowUp meta={meta} busy={threadActive} />}
    </>
  );
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Files attached to a question or reply; clicking downloads through the local daemon. */
function AttachmentList({ items }: { items?: Attachment[] }) {
  const t = useT();
  if (!items?.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((a) => (
        <a
          key={a.id}
          href={api.attachmentUrl(a.id)}
          download={a.name}
          className="kind-tag"
          title={t.download}
          onClick={(e) => {
            // On another machine the file needs the token header, which a plain link cannot send (#97).
            if (!token) return;
            e.preventDefault();
            void api.downloadAttachment(a.id, a.name).catch(() => undefined);
          }}
        >
          📎 {a.name} · {sizeText(a.size)} · {t.download}
        </a>
      ))}
    </div>
  );
}

function LinkedTasks({ children, meta, agents }: { children: ThreadMeta[]; meta: ThreadMeta; agents: Record<string, AgentRecord> }) {
  const t = useT();
  if (!children.length) return null;
  return (
    <section className="card flex flex-col gap-2 px-5 py-4">
      <h2 className="cap">{t.clarifications(children.length)}</h2>
      {children.map((child) => (
        <div key={child.threadId} className="flex flex-col gap-1">
          <a className="linkbtn flex flex-wrap items-baseline justify-between gap-2"
            href={hashFor({ page: "thread", threadId: child.threadId, channel: child.channel ?? meta.channel ?? "default" })}>
            <span>{child.summary}</span>
            <span className="text-xs text-muted">{t.linkedStatus[child.status]}</span>
          </a>
          {child.replies.map((reply) => (
            <p key={`${reply.agentId}-${reply.at}`} className="text-sm text-muted">
              {reply.source === "operator" ? t.operatorOverride(reply.address ?? whoAddress(reply.agentId, agents, child)) : reply.address ?? whoAddress(reply.agentId, agents, child)} · {reply.text}
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}

function Clarification({ parent, child }: { parent: string; child: ThreadMeta }) {
  const t = useT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const question = child.clarification!;
  const submitted = accepted || child.turns > 1;
  const status = question.acknowledged ? t.clarificationReceived
    : submitted && child.status === "failed" ? t.clarificationFailed
    : submitted ? t.clarificationAccepted : t.needsHuman;
  const id = `clarification-${child.threadId}`;
  return (
    <article className="well flex flex-col gap-2 px-3.5 py-2.5">
      <div role="status" className="text-sm font-medium">{status} · {child.from.address}</div>
      <div className="prose-text">{question.question}</div>
      {!submitted && (
        <form className="flex flex-col gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || sending) return;
          setSending(true);
          setError(undefined);
          void api.answerClarification(parent, child.threadId, question.orderId, text)
            .then(() => setAccepted(true))
            .catch((err: Error) => setError(err.message))
            .finally(() => setSending(false));
        }}>
          <label htmlFor={id} className="text-sm">{t.clarificationReply}</label>
          <textarea id={id} className="field" rows={3} value={text} maxLength={12_000} required onChange={(event) => setText(event.target.value)} />
          <button className="btn-sm self-start" type="submit" disabled={sending || !text.trim()}>{t.clarificationSubmit}</button>
          {error && <p role="alert" className="text-sm">{error}</p>}
        </form>
      )}
      <a className="linkbtn self-start" href={hashFor({ page: "thread", threadId: child.threadId, channel: child.channel ?? "default" })}>{t.clarificationThread}</a>
    </article>
  );
}

function Replies({ turn, active, meta }: { turn: Turn; active: boolean; meta: ThreadMeta }) {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const items = [
    ...turn.replies.map((r) => ({ key: `r-${r.at}-${r.agentId}`, who: r.agentId, at: r.at, tone: (r.source === "operator" ? "warn" : r.final ? "ok" : "info") as Tone, kind: r.report ? t.resultReport : r.source === "operator" ? t.operatorOverrideLabel : r.final ? t.kAnswer : t.kPartial, text: r.text, md: true, attachments: r.attachments })),
    ...turn.declines.map((d) => ({ key: `d-${d.at}-${d.agentId}`, who: d.agentId, at: d.at, tone: "warn" as Tone, kind: t.kDecline, text: d.reason, md: false, attachments: undefined as Attachment[] | undefined })),
    ...turn.skips.map((d) => ({ key: `s-${d.at}-${d.agentId}`, who: d.agentId, at: d.at, tone: "info" as Tone, kind: t.kSkipped, text: d.reason, md: false, attachments: undefined as Attachment[] | undefined })),
  ].sort((a, b) => a.at - b.at);
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="section-cap">{t.replies}</h2>
      {items.map((r) => (
        <div key={r.key} className="card flex flex-col gap-2 px-4.5 py-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="mono text-sm text-fg-strong">{whoAddress(r.who, agents, meta)}</span>
            <KindTag a={agents[r.who]} />
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
          <AttachmentList items={r.attachments} />
        </div>
      ))}
      {items.length === 0 && <div className="well hint px-4.5 py-3.5">{active ? t.noRepliesYet : t.noReplyFinal}</div>}
    </section>
  );
}

function FollowUp({ meta, busy, drawer = false }: { meta: ThreadMeta; busy: boolean; drawer?: boolean }) {
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
      className={drawer ? "flex flex-col gap-2" : "card flex flex-col gap-2.5 px-4.5 py-3.5"}
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
        text = ev.skipped ? t.stepSkipped(name(ev.agentId)) : t.stepDeclined(name(ev.agentId));
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