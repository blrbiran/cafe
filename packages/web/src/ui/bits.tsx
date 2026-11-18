import type { ReactNode } from "react";

export type Tone = "info" | "ok" | "warn" | "danger" | undefined;

export function Dot({ tone }: { tone?: Tone }) {
  return <span className="dot" data-dot={tone} aria-hidden="true" />;
}

/** A status pill: dot + plain-language text, coloured by tone. */
export function Pill({ tone, children, dot = true }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className="pill" data-tone={tone}>
      {dot && <Dot tone={tone} />}
      {children}
    </span>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 text-2xl text-fg-strong">{title}</h1>
        {sub && <div className="text-base text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A collapsed section with a "▸ / ▾" toggle (delivery log, debug details). */
export function Disclosure({ show, hide, open, onToggle, children }: { show: string; hide: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="card flex flex-col gap-2 px-4.5 py-3">
      <button type="button" className="linkbtn text-muted" aria-expanded={open} onClick={onToggle}>
        {open ? hide : show}
      </button>
      {open && <div className="pb-1.5">{children}</div>}
    </section>
  );
}

/** Small key/value grid used on agent and machine cards. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-x-2.5 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <FactRow key={k} k={k} v={v} />
      ))}
    </div>
  );
}

function FactRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <span className="text-muted">{k}</span>
      <span className="min-w-0 overflow-hidden text-ellipsis text-fg">{v}</span>
    </>
  );
}
