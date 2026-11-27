import type { AgentRecord, ThreadMeta } from "@cafe/protocol";
import type { Dict } from "./i18n.ts";
import { isActive, nameOf, type LiveTurn } from "./store.ts";
import type { Tone } from "./ui/tone.ts";

export type Bucket = "active" | "answered" | "unanswered" | "cancelled";

export function followupAnswer(meta: ThreadMeta): NonNullable<ThreadMeta["followupOutcome"]>["answer"] | undefined {
  const projection = meta.followupOutcome;
  if (meta.status !== "failed" || !projection || projection.orderId !== meta.orderId) return undefined;
  if (projection.answer.orderId === meta.orderId || projection.answer.turn >= meta.turns) return undefined;
  return projection.answer;
}

export function followupPreviewText(answer: NonNullable<ThreadMeta["followupOutcome"]>["answer"]): string {
  return `${answer.text}${answer.truncated ? "…" : ""}`;
}

export function followupSearchPreview(meta: ThreadMeta, hits: readonly { orderId: string; text: string; at: number; who: string }[]): boolean {
  const answer = followupAnswer(meta);
  return !!answer && !hits.some((hit) => hit.orderId === answer.orderId);
}

export function bucketOf(t: ThreadMeta): Bucket {
  if (t.taskStatus === "working" || t.taskStatus === "awaiting_report" || t.taskStatus === "unknown" || isActive(t.status) || (t.clarification && t.turns === 1)) return "active";
  if (t.status === "cancelled") return "cancelled";
  if (followupAnswer(t)) return "answered";
  if (t.replies.length > 0) return "answered";
  return "unanswered";
}

/** Display name of an agent id, preferring the live registry, then addresses carried in the meta. */
export function whoName(id: string, agents: Record<string, AgentRecord>, meta?: ThreadMeta): string {
  const a = agents[id];
  if (a) return a.displayName ?? a.name;
  const fromMeta = meta?.replies.find((r) => r.agentId === id)?.address ?? (meta?.followupOutcome?.answer.agentId === id ? meta.followupOutcome.answer.address : undefined) ?? meta?.declines.find((d) => d.agentId === id)?.address;
  return fromMeta ? nameOf(fromMeta) : id.slice(-6);
}

export function whoAddress(id: string, agents: Record<string, AgentRecord>, meta?: ThreadMeta): string {
  return agents[id]?.address ?? meta?.replies.find((r) => r.agentId === id)?.address ?? (meta?.followupOutcome?.answer.agentId === id ? meta.followupOutcome.answer.address : undefined) ?? meta?.declines.find((d) => d.agentId === id)?.address ?? id.slice(-6);
}

/**
 * Who asked, in plain words: "you" for this web UI, or the relaying Agent's
 * address when an Agent asked on the person's behalf.
 */
export function askerOf(
  t: Dict,
  source: { from: { address: string }; origin?: "human" | "agent"; via?: { address: string }; provenanceVerified?: boolean },
  followUp = false,
): { who: string; verb: string } {
  if (source.origin === "agent") return {
    who: source.via?.address ?? source.from.address,
    verb: source.provenanceVerified === true ? t.relayedVerb : t.unverifiedRelayedVerb,
  };
  if (source.from.address.startsWith("web@")) return { who: t.you, verb: followUp ? t.followUpLabel : t.askedVerb };
  return { who: source.from.address, verb: followUp ? t.followUpLabel : t.askedVerb };
}

/**
 * The one-line outcome of a Thread's latest turn, in plain language.
 * `live` supplies the turn start (for follow-ups) and the current targets.
 */
export function outcome(t: Dict, meta: ThreadMeta, agents: Record<string, AgentRecord>, live: LiveTurn | undefined, now: number): { tone: Tone; text: string } {
  if (meta.clarification && meta.turns === 1) return { tone: "warn", text: t.needsHuman };
  if (meta.taskStatus === "working") return { tone: "info", text: t.taskWorking };
  if (meta.taskStatus === "awaiting_report") return { tone: "warn", text: t.taskAwaitingReport };
  if (meta.taskStatus === "unknown") return { tone: "warn", text: t.taskStatusUnknown };
  const startedAt = live?.startedAt ?? meta.turnStartedAt ?? (meta.turns <= 1 ? meta.createdAt : undefined);
  const names = (ids: string[]) => t.list([...new Set(ids.map((id) => whoName(id, agents, meta)))]);
  switch (bucketOf(meta)) {
    case "active": {
      const targets = live?.targets ?? meta.targets;
      if (meta.status === "routing" || targets.length === 0) return { tone: "info", text: t.routing };
      if (meta.status === "delivering") return { tone: "info", text: t.delivering(names(targets)) };
      return { tone: "info", text: t.working(names(targets), startedAt ? t.dur(now - startedAt) : "…") };
    }
    case "answered": {
      if (followupAnswer(meta)) return { tone: "warn", text: t.followupNotDelivered };
      const who = names(meta.replies.map((r) => r.agentId));
      const end = meta.replies[0]?.at ?? meta.closedAt;
      const took = startedAt && end ? t.dur(end - startedAt) : undefined;
      const operatorReplyers = meta.replies.filter((reply) => reply.source === "operator").map((reply) => reply.agentId);
      if (operatorReplyers.length) return { tone: "warn", text: t.operatorOverride(names(operatorReplyers)) };
      return { tone: "ok", text: t.answeredBy(who, took) };
    }
    case "cancelled":
      return { tone: undefined, text: t.cancelled };
    case "unanswered":
      return meta.declines.length > 0 ? { tone: "warn", text: t.nobody(meta.declines.length) } : { tone: "danger", text: t.noAnswer };
  }
}

/** Plain-language "why this agent" from a routing decision. */
export function whyText(
  t: Dict,
  d: { router?: string; mode?: string; reason?: string; targets?: string[]; demoted?: string[]; llmError?: string } | undefined,
  agents: Record<string, AgentRecord> = {},
  meta?: ThreadMeta,
): string | undefined {
  if (!d?.router) return undefined;
  if (d.mode === "broadcast") return d.llmError ? `${t.whyLlmDown}${t.askEveryone}` : t.askEveryone;
  switch (d.router) {
    case "llm":
      return d.reason ? t.whyLlm(d.reason) : t.router.llm;
    case "rules": {
      const base = d.llmError ? `${t.whyLlmDown}${t.whyRules}` : t.whyRules;
      const target = d.targets?.[0];
      if (!d.demoted?.length || !target) return base;
      const name = (id: string) => whoName(id, agents, meta);
      return `${base}${t.whyDemoted(t.list(d.demoted.map(name)), name(target))}`;
    }
    case "explicit":
      return t.whyExplicit;
    case "followup":
      return t.whyFollowup;
    default:
      return d.reason;
  }
}
