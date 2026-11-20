import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThreadMeta } from "@cafe/protocol";
import { api } from "../api.ts";
import { ago, useT } from "../i18n.ts";
import { useNow } from "../format.ts";
import { bucketOf, outcome, askerOf, whoAddress, whyText } from "../outcome.ts";
import { agentAddress, agentLabel } from "../display.ts";
import { navigate, type Filter } from "../route.ts";
import { closeComposer, ensureLive, loadOlder, openComposer, SEARCH_LIMIT, setSearch, useStore, type SearchResult } from "../store.ts";
import { Empty, PageHeader, Pill, type Tone } from "../ui/bits.tsx";

export function FeedPage({ filter }: { filter: Filter }) {
  const t = useT();
  const threads = useStore((s) => s.threads);
  const composer = useStore((s) => s.composer);
  const older = useStore((s) => s.older);
  const search = useStore((s) => s.search);
  const searching = search.q.trim() !== "";

  const { active, done } = useMemo(() => {
    const active = threads.filter((x) => bucketOf(x) === "active");
    const rest = threads
      .filter((x) => bucketOf(x) !== "active")
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
    return { active, done: rest.filter((x) => filter === "all" || bucketOf(x) === filter) };
  }, [threads, filter]);
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
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="filter" className="flex flex-wrap gap-2">
          {filters.map(([k, label]) => (
            <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => navigate({ page: "feed", filter: k })}>
              {label}
            </button>
          ))}
        </div>
        <input
          id="cafe-search"
          type="search"
          className="field min-h-8 min-w-0 flex-[1_1_180px] py-1"
          style={{ width: "auto" }}
          aria-label={t.searchLabel}
          placeholder={t.searchPlaceholder}
          value={search.q}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSearch("");
          }}
        />
      </div>
      {searching ? <SearchResults filter={filter} /> : <>
      {threads.length === 0 && <Empty>{t.emptyFeed}</Empty>}
      {showActive && (
        <section className="flex flex-col gap-2.5">
          <h2 className="section-cap">{t.inProgress}</h2>
          <div className="feed-grid flex flex-col gap-2.5">
            {active.map((m) => (
              <ThreadCard key={m.threadId} meta={m} filter={filter} />
            ))}
          </div>
        </section>
      )}
      {showDone && threads.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="section-cap">{t.recent}</h2>
          <div className="feed-grid flex flex-col gap-2.5">
            {done.length === 0 ? <Empty>{t.emptyFilter}</Empty> : done.map((m) => <ThreadCard key={m.threadId} meta={m} filter={filter} />)}
          </div>
          {!older.done ? (
            <div className="flex justify-center pt-1">
              <button type="button" onClick={() => void loadOlder()} disabled={older.loading} aria-busy={older.loading}>
                {older.loading ? t.loadingOlder : t.loadOlder}
              </button>
            </div>
          ) : (
            older.loaded && <div className="hint text-center">{t.noOlder}</div>
          )}
        </section>
      )}
      {filter === "active" && active.length === 0 && threads.length > 0 && <Empty>{t.emptyFilter}</Empty>}
      </>}
    </>
  );
}

function SearchResults({ filter }: { filter: Filter }) {
  const t = useT();
  const now = useNow();
  const agents = useStore((s) => s.agents);
  const search = useStore((s) => s.search);
  const q = search.q.trim();
  if (search.error) return <div role="alert" className="well text-sm" data-tone="danger">{search.error}</div>;
  if (!search.results) return <div className="hint">{t.searching}</div>;
  const rows = search.results.filter((r: SearchResult) => filter === "all" || bucketOf(r.meta) === filter);
  if (rows.length === 0) return <Empty>{t.searchNone(q)}</Empty>;
  return (
    <section className="flex flex-col gap-2.5" aria-busy={search.loading}>
      <h2 className="section-cap">{t.searchFound(rows.length)}</h2>
      {rows.map(({ meta, hits }) => {
        const o = outcome(t, meta, agents, undefined, now);
        const ask = askerOf(t, meta);
        const open = () => navigate({ page: "thread", threadId: meta.threadId, from: filter });
        return (
          <article key={meta.threadId} className="card flex flex-col gap-2.5 px-4.5 py-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <span className="mono text-fg">{ask.who}</span>
              <span>{ask.verb}</span>
              <span>· {ago(t, meta.createdAt, now)}</span>
            </div>
            <button type="button" className="qbtn" onClick={open}>
              <Highlight text={meta.summary || "—"} q={q} />
            </button>
            <div>
              <Pill tone={o.tone}>{o.text}</Pill>
            </div>
            {hits.filter((h) => !sameAsTitle(h.text, meta.summary)).map((h) => (
              <div key={`${h.orderId}-${h.at}-${h.who}`} className="well flex flex-col gap-1 px-3.5 py-2.5">
                <div className="mono text-xs text-muted">{h.who}</div>
                <div className="answer clamp3">
                  <Highlight text={plain(h.text)} q={q} />
                </div>
              </div>
            ))}
            <div>
              <button type="button" className="linkbtn" onClick={open}>
                {t.openConv}
              </button>
            </div>
          </article>
        );
      })}
      {search.results.length >= SEARCH_LIMIT && <div className="hint">{t.searchCapped(SEARCH_LIMIT)}</div>}
    </section>
  );
}

/** A hit on the question itself repeats the card title; the title already shows the highlight. */
function sameAsTitle(hit: string, summary: string): boolean {
  const a = hit.replace(/^…/, "").replace(/\s+/g, " ").trim();
  const b = summary.replace(/…$/, "").replace(/\s+/g, " ").trim();
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a));
}

/** Mark every case-insensitive occurrence of `q` in `text`. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function ThreadCardImpl({ meta, filter }: { meta: ThreadMeta; filter: Filter }) {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live[meta.threadId]);
  const bucket = bucketOf(meta);
  const now = useNow(bucket === "active" ? 1_000 : 30_000);
  const open = () => navigate({ page: "thread", threadId: meta.threadId, from: filter });

  // In-progress cards show "why this agent", which needs the routing decision: fetch it lazily.
  useEffect(() => {
    if (bucket === "active") ensureLive(meta.threadId);
  }, [bucket, meta.threadId]);
  const why = bucket === "active" ? whyText(t, live, agents, meta) : undefined;
  const first = meta.replies[0];
  const ask = askerOf(t, meta);
  const started = live?.startedAt ?? meta.turnStartedAt ?? (meta.turns <= 1 ? meta.createdAt : undefined);
  const end = bucket === "answered" ? (first?.at ?? meta.closedAt) : undefined;
  const timing =
    bucket === "active"
      ? started
        ? t.dur(now - started)
        : undefined
      : bucket === "answered" && started && end
        ? t.dur(end - started)
        : undefined;
  const status =
    bucket === "active"
      ? { tone: "info" as Tone, text: t.statusWorking }
      : bucket === "answered"
        ? { tone: "ok" as Tone, text: t.statusAnswered }
        : bucket === "cancelled"
          ? { tone: undefined, text: t.statusCancelled }
          : { tone: (meta.declines.length ? "warn" : "danger") as Tone, text: t.statusUnanswered };
  const preview = first
    ? plain(first.text)
    : bucket === "unanswered" && meta.declines.length
      ? meta.declines.map((d) => `${whoAddress(d.agentId, agents, meta)}：${d.reason}`).join(" · ")
      : undefined;

  return (
    <article
      role="link"
      tabIndex={0}
      data-thread-id={meta.threadId}
      aria-label={`${meta.summary} — ${status.text}`}
      title={why}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={`card flex cursor-pointer flex-col gap-1.5 px-3.5 py-2.5 transition-colors hover:border-line-strong ${bucket === "active" ? "card-live" : ""}`}
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="flex min-w-0 items-center gap-1.5 text-muted">
          <span className="mono truncate text-fg">{ask.who}</span>
          <span>{ask.verb}</span>
          <span>· {ago(t, meta.createdAt, now)}</span>
          {meta.turns > 1 && <span>· {t.turns(meta.turns)}</span>}
          {meta.attachments?.length ? <span>· 📎 {meta.attachments.length}</span> : null}
        </div>
        <div className="flex flex-none items-center gap-2">
          <Pill tone={status.tone}>{status.text}</Pill>
          {timing && <span className="mono text-muted">{timing}</span>}
        </div>
      </div>
      <div className="clamp2 text-[15px] font-semibold leading-snug text-fg-strong">{meta.summary || "—"}</div>
      {bucket === "answered" && first && (
        <div className="truncate text-xs text-muted">
          <span className="mono text-ok">{whoAddress(first.agentId, agents, meta)}</span>：{preview}
          {meta.replies.length > 1 && <span> · {t.moreReplies(meta.replies.length - 1)}</span>}
        </div>
      )}
      {bucket === "unanswered" && preview && <div className="truncate text-xs text-muted">{preview}</div>}
    </article>
  );
}

const ThreadCard = memo(ThreadCardImpl);

function Composer({ initialTo }: { initialTo?: string }) {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const daemons = useStore((s) => s.daemons);
  const [body, setBody] = useState("");
  const [to, setTo] = useState(initialTo ?? "");
  const [files, setFiles] = useState<File[]>([]);
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
      const attachments = [];
      for (const file of files) attachments.push(await api.uploadAttachment(file));
      const r = await api.createOrder({ body, to: to || undefined, ...(attachments.length ? { attachments } : {}) });
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
      <div className="flex flex-col gap-1.5">
        <label className="cap" htmlFor="cafe-files">
          {t.attach}
        </label>
        <input
          id="cafe-files"
          type="file"
          multiple
          onChange={(e) => {
            const chosen = Array.from(e.currentTarget.files ?? []);
            setFiles((xs) => [...xs, ...chosen]);
            e.currentTarget.value = "";
          }}
        />
        <div className="hint">{t.attachHint}</div>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="kind-tag">
                {f.name} ({(f.size / 1024).toFixed(1)} KB)
                <button type="button" className="ml-1 text-muted" aria-label={t.removeAttachment(f.name)} onClick={() => setFiles((xs) => xs.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
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
                {agentLabel(a, daemons)} · {agentAddress(a, daemons)}
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
