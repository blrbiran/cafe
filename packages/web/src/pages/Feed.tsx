import { useEffect, useRef, useState } from "react";
import type { ThreadMeta } from "@cafe/protocol";
import { api } from "../api.ts";
import { ago, useT } from "../i18n.ts";
import { useNow } from "../format.ts";
import { bucketOf, outcome, whoAddress, whyText } from "../outcome.ts";
import { navigate, type Filter } from "../route.ts";
import { closeComposer, ensureLive, openComposer, useStore } from "../store.ts";
import { Empty, PageHeader, Pill } from "../ui/bits.tsx";

export function FeedPage({ filter }: { filter: Filter }) {
  const t = useT();
  const threads = useStore((s) => s.threads);
  const composer = useStore((s) => s.composer);

  const active = threads.filter((x) => bucketOf(x) === "active");
  const rest = threads
    .filter((x) => bucketOf(x) !== "active")
    .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
  const done = rest.filter((x) => filter === "all" || bucketOf(x) === filter);
  const showActive = (filter === "all" || filter === "active") && active.length > 0;
  const showDone = filter !== "active";

  const filters: [Filter, string][] = [
    ["all", t.fAll],
    ["active", t.fActive],
    ["answered", t.fAnswered],
    ["unanswered", t.fUnanswered],
  ];

  return (
    <>
      <PageHeader
        title={t.feedTitle}
        sub={t.feedSub}
        actions={
          <button type="button" className="btn-primary min-h-9 px-3.5" onClick={() => openComposer()}>
            {t.ask}
          </button>
        }
      />
      {composer && <Composer initialTo={composer.to} />}
      <div role="group" aria-label="filter" className="flex flex-wrap gap-2">
        {filters.map(([k, label]) => (
          <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => navigate({ page: "feed", filter: k })}>
            {label}
          </button>
        ))}
      </div>
      {threads.length === 0 && <Empty>{t.emptyFeed}</Empty>}
      {showActive && (
        <section className="flex flex-col gap-2.5">
          <h2 className="section-cap">{t.inProgress}</h2>
          {active.map((m) => (
            <ThreadCard key={m.threadId} meta={m} />
          ))}
        </section>
      )}
      {showDone && threads.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="section-cap">{t.recent}</h2>
          {done.length === 0 ? <Empty>{t.emptyFilter}</Empty> : done.map((m) => <ThreadCard key={m.threadId} meta={m} />)}
        </section>
      )}
      {filter === "active" && active.length === 0 && threads.length > 0 && <Empty>{t.emptyFilter}</Empty>}
    </>
  );
}

function ThreadCard({ meta }: { meta: ThreadMeta }) {
  const t = useT();
  const now = useNow();
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live[meta.threadId]);
  const bucket = bucketOf(meta);
  const o = outcome(t, meta, agents, live, now);
  const open = () => navigate({ page: "thread", threadId: meta.threadId });

  // In-progress cards show "why this agent", which needs the routing decision: fetch it lazily.
  useEffect(() => {
    if (bucket === "active") ensureLive(meta.threadId);
  }, [bucket, meta.threadId]);
  const why = bucket === "active" ? whyText(t, live, agents, meta) : undefined;
  const first = meta.replies[0];

  return (
    <article className={`card flex flex-col gap-2.5 px-4.5 py-4 ${bucket === "active" ? "card-live" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <span className="mono text-fg">{meta.from.address}</span>
        <span>{t.askedVerb}</span>
        <span>· {ago(t, meta.createdAt, now)}</span>
        {meta.turns > 1 && <span>· {t.turns(meta.turns)}</span>}
      </div>
      <button type="button" className="qbtn" onClick={open}>
        {meta.summary || "—"}
      </button>
      <div className="flex flex-wrap items-center gap-2.5">
        <Pill tone={o.tone}>{o.text}</Pill>
        {why && (
          <span className="hint">
            {t.why}
            {why}
          </span>
        )}
      </div>
      {bucket === "answered" && first && (
        <div className="well flex flex-col gap-1.5 px-3.5 py-3">
          <div className="mono text-xs text-ok">{first.address ?? whoAddress(first.agentId, agents, meta)}</div>
          <div className="answer clamp3">{plain(first.text)}</div>
          {meta.replies.length > 1 && <div className="hint">{t.moreReplies(meta.replies.length - 1)}</div>}
        </div>
      )}
      {bucket === "unanswered" && meta.declines.length > 0 && (
        <div className="well flex flex-col gap-1.5 px-3.5 py-3">
          {meta.declines.map((d) => (
            <div key={d.agentId} className="text-sm">
              <span className="mono text-danger">{d.address ?? whoAddress(d.agentId, agents, meta)}</span>
              <span className="text-muted"> — {d.reason}</span>
            </div>
          ))}
        </div>
      )}
      {bucket !== "active" && (
        <div>
          <button type="button" className="linkbtn" onClick={open}>
            {t.openConv}
          </button>
        </div>
      )}
    </article>
  );
}

function Composer({ initialTo }: { initialTo?: string }) {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const [body, setBody] = useState("");
  const [to, setTo] = useState(initialTo ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTo(initialTo ?? "");
    ref.current?.focus();
  }, [initialTo]);

  const choices = Object.values(agents)
    .filter((a) => a.role === "barista" && a.status !== "offline")
    .sort((a, b) => a.address.localeCompare(b.address));
  // Keep a prefilled address selectable even if that agent just went offline.
  const known = !to || choices.some((a) => a.address === to);

  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.createOrder({ body, to: to || undefined });
      closeComposer();
      navigate({ page: "thread", threadId: r.threadId });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card flex flex-col gap-3 p-4"
      style={{ borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))" }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="cap" htmlFor="cafe-q">
        {t.yourQuestion}
      </label>
      <textarea
        id="cafe-q"
        ref={ref}
        className="field"
        rows={3}
        placeholder={t.qPlaceholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-[1_1_260px] flex-col gap-1.5">
          <label className="cap" htmlFor="cafe-to">
            {t.sendTo}
          </label>
          <select id="cafe-to" className="field" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t.autoPick}</option>
            {!known && <option value={to}>{to}</option>}
            {choices.map((a) => (
              <option key={a.agentId} value={a.address}>
                {a.name} · {a.address}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => closeComposer()}>
            {t.cancel}
          </button>
          <button type="submit" className="btn-primary" disabled={!body.trim()} aria-busy={busy}>
            {busy ? t.sending : t.send}
          </button>
        </div>
      </div>
      {!to && <div className="hint">{t.autoPickHint}</div>}
      {err && (
        <div role="alert" className="well text-sm" data-tone="danger">
          {err}
        </div>
      )}
    </form>
  );
}

/** Strip the Markdown markers that would look like noise in a three-line preview. */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\n{2,}/g, "\n");
}
