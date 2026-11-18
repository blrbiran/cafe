import type { AgentStatus, ThreadStatus } from "@cafe/protocol";
import type { ReactNode } from "react";

export type Tone = "info" | "ok" | "warn" | "danger" | undefined;

export const threadTone: Record<ThreadStatus, Tone> = {
  routing: "info",
  delivering: "info",
  working: "info",
  done: "ok",
  failed: "danger",
  cancelled: "warn",
};

export function StatusBadge({ status }: { status: ThreadStatus }) {
  return (
    <span className="badge" data-tone={threadTone[status]}>
      {status}
    </span>
  );
}

export function Led({ status }: { status: AgentStatus | "danger" | "warn" }) {
  return <span className="led" data-led={status} aria-hidden="true" />;
}

export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function PageHeader({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="mb-1 text-xl">{title}</h1>
        {meta && <div className="meta">{meta}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
