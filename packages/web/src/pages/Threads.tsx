import { useState } from "react";
import type { ThreadMeta, ThreadStatus } from "@cafe/protocol";
import { api } from "../api.ts";
import { hashFor, navigate } from "../route.ts";
import { addressOf, useStore } from "../store.ts";
import { duration, relTime, useNow } from "../format.ts";
import { Badge, Empty, PageHeader, StatusBadge } from "../ui/bits.tsx";

const STATUSES: ThreadStatus[] = ["routing", "delivering", "working", "done", "failed", "cancelled"];

export function ThreadsPage({ status, agent }: { status?: string; agent?: string }) {
  const threads = useStore((s) => s.threads);
  const agents = useStore((s) => s.agents);
  const [composing, setComposing] = useState(false);
  const now = useNow();

  const shown = threads.filter(
    (t) => (!status || t.status === status) && (!agent || t.from.id === agent || t.targets.includes(agent)),
  );

  return (
    <>
      <PageHeader
        title="Threads"
        meta={`${shown.length} of ${threads.length} threads`}
        actions={
          <button className="btn-primary" onClick={() => setComposing((v) => !v)}>
            {composing ? "Close" : "New order"}
          </button>
        }
      />
      {composing && <Composer onDone={() => setComposing(false)} />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by status"
          value={status ?? ""}
          onChange={(e) => navigate({ page: "threads", status: e.target.value || undefined, agent })}
        >
          <option value="">all statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by agent"
          value={agent ?? ""}
          onChange={(e) => navigate({ page: "threads", status, agent: e.target.value || undefined })}
        >
          <option value="">all agents</option>
          {Object.values(agents)
            .sort((a, b) => a.address.localeCompare(b.address))
            .map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.address}
              </option>
            ))}
        </select>
        {(status || agent) && (
          <button className="btn-quiet btn-sm" onClick={() => navigate({ page: "threads" })}>
            clear
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <Empty>No threads yet. Send one with “New order” or `cafe ask`.</Empty>
      ) : (
        <section className="card table-box">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>From</th>
                <th>To</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Created</th>
                <th>1st reply</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <Row key={t.threadId} t={t} now={now} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function Row({ t, now }: { t: ThreadMeta; now: number }) {
  const agents = useStore((s) => s.agents);
  const open = t.status === "routing" || t.status === "delivering" || t.status === "working";
  return (
    <tr className="cursor-pointer" onClick={() => navigate({ page: "thread", threadId: t.threadId })}>
      <td className="max-w-96">
        <a href={hashFor({ page: "thread", threadId: t.threadId })} className="line-clamp-2 text-fg-strong no-underline hover:underline" onClick={(e) => e.stopPropagation()}>
          {t.summary || "(empty)"}
        </a>
        {t.kind === "notice" && <Badge>notice</Badge>}
      </td>
      <td className="font-data text-xs whitespace-nowrap">{t.from.address}</td>
      <td className="font-data text-xs whitespace-nowrap">
        {t.targets.length === 0 ? <span className="text-muted">—</span> : t.targets.slice(0, 3).map((id) => <div key={id}>{addressOf(agents, id)}</div>)}
        {t.targets.length > 3 && <div className="text-muted">+{t.targets.length - 3} more</div>}
      </td>
      <td>{t.mode ? <Badge>{t.mode}</Badge> : <span className="text-muted">—</span>}</td>
      <td>
        <StatusBadge status={t.status} />
      </td>
      <td className="meta whitespace-nowrap num">{relTime(t.createdAt, now)}</td>
      <td className="meta whitespace-nowrap num">{t.firstReplyAt ? duration(t.firstReplyAt - t.createdAt) : "—"}</td>
      <td className="meta whitespace-nowrap num">{t.closedAt ? duration(t.closedAt - t.createdAt) : open ? duration(now - t.createdAt) + "…" : "—"}</td>
    </tr>
  );
}

function Composer({ onDone }: { onDone: () => void }) {
  const [body, setBody] = useState("");
  const [to, setTo] = useState("");
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const agents = useStore((s) => s.agents);

  return (
    <form
      className="card mb-4 flex flex-col gap-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim()) return;
        setBusy(true);
        setErr(undefined);
        try {
          const r = await api.createOrder({ body, to: to.trim() || undefined, kind: notice ? "notice" : "order" });
          onDone();
          navigate({ page: "thread", threadId: r.threadId });
        } catch (e2) {
          setErr((e2 as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Order
        <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} placeholder="Ask the network… (⌘↵ to send)" onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
        }} />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1">
          To (optional address, e.g. name@host — leave empty to let the router decide)
          <input list="cafe-addresses" value={to} onChange={(e) => setTo(e.target.value)} placeholder="router decides" />
          <datalist id="cafe-addresses">
            {Object.values(agents)
              .filter((a) => a.role === "barista")
              .map((a) => (
                <option key={a.agentId} value={a.address} />
              ))}
          </datalist>
        </label>
        <label className="flex-row items-center gap-2 pb-2 text-sm text-fg">
          <input type="checkbox" checked={notice} onChange={(e) => setNotice(e.target.checked)} />
          notice (no reply)
        </label>
        <button type="submit" className="btn-primary" disabled={!body.trim()} aria-busy={busy}>
          Send
        </button>
      </div>
      {err && <div className="text-sm text-danger">{err}</div>}
    </form>
  );
}
