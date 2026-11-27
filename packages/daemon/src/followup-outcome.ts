import { isDeepStrictEqual } from "node:util";
import type { ThreadEnvelope, ThreadMeta } from "@cafe/protocol";
import type { Store } from "./store.ts";

export type HistoricalAnswer = NonNullable<ThreadMeta["followupOutcome"]>["answer"];
export interface FollowupProjectionState {
  lastAnswer?: HistoricalAnswer;
  active?: {
    orderId: string;
    turn: number;
    emptyRoute: boolean;
    closed: boolean;
    answer?: HistoricalAnswer;
  };
}

export function emptyFollowupProjection(): FollowupProjectionState {
  return {};
}

/** Apply one journal event in append order; timestamps never determine event eligibility. */
export function applyFollowupEvent(state: FollowupProjectionState, env: ThreadEnvelope, addressOf?: (agentId: string) => string | undefined): FollowupProjectionState {
  const ev = env.event;
  if (ev.type === "order.created" || ev.type === "order.replaced") {
    return { ...state, active: { orderId: ev.order.orderId, turn: ev.order.turn, emptyRoute: false, closed: false } };
  }
  const active = state.active;
  if (!active || env.orderId !== active.orderId || active.closed) return state;
  if (ev.type === "order.routed") return { ...state, active: { ...active, emptyRoute: ev.decision.targets.length === 0 } };
  if (ev.type === "order.replied" && ev.final) {
    const text = capPreview(ev.text);
    const answer: HistoricalAnswer = {
      orderId: env.orderId,
      turn: active.turn,
      agentId: ev.agentId,
      ...(addressOf?.(ev.agentId) ? { address: addressOf(ev.agentId) } : {}),
      ...(ev.source ? { source: ev.source } : {}),
      text: text.text,
      truncated: text.truncated,
    };
    return { ...state, active: { ...active, answer } };
  }
  if (ev.type === "order.closed") {
    const lastAnswer = ev.status === "done" && active.answer && active.turn >= (state.lastAnswer?.turn ?? 0) ? active.answer : state.lastAnswer;
    return { ...state, lastAnswer, active: { ...active, closed: true } };
  }
  return state;
}

export function projectFollowupEvent(store: Store, meta: ThreadMeta, env: ThreadEnvelope, bytesBefore: number, bytesWritten: number, addressOf?: (agentId: string) => string | undefined): ThreadMeta | undefined {
  const progress = store.getFollowupProgress<FollowupProjectionState>(meta.threadId);
  if ((progress && progress.offset !== bytesBefore) || (!progress && bytesBefore !== 0)) return undefined;
  let state = progress?.state ?? emptyFollowupProjection();
  state = applyFollowupEvent(state, env, addressOf);
  const { followupOutcome: _stale, ...withoutStaleOutcome } = meta;
  const outcome = outcomeFor(state, meta, true);
  const projected = outcome ? { ...withoutStaleOutcome, followupOutcome: outcome } : withoutStaleOutcome;
  const nextProgress = { offset: bytesBefore + bytesWritten, complete: true, state };
  if (isDeepStrictEqual(meta.followupOutcome, outcome)) store.saveFollowupProgress(meta.threadId, nextProgress);
  else store.saveFollowupProjection(projected, nextProgress);
  return isDeepStrictEqual(meta.followupOutcome, outcome) ? undefined : projected;
}

export function recoverFollowupBatch(store: Store, options: { limit: number; after?: { createdAt: number; threadId: string }; maxBytesPerThread?: number; maxEventsPerThread?: number; addressOf?: (agentId: string) => string | undefined }): { processed: number; unavailable: string[]; updated: ThreadMeta[]; next?: { createdAt: number; threadId: string } } {
  const threads = store.threadsForFollowupProjection(options.after, options.limit);
  let processed = 0;
  const unavailable: string[] = [];
  const updated: ThreadMeta[] = [];
  let next: { createdAt: number; threadId: string } | undefined;
  for (const listed of threads) {
    next = { createdAt: listed.createdAt, threadId: listed.threadId };
    const progress = store.getFollowupProgress(listed.threadId);
    let state = (progress?.state as FollowupProjectionState | undefined) ?? emptyFollowupProjection();
    let offset = progress?.offset ?? 0;
    try {
      const page = store.readEventsFromOffset(listed.file, offset, options.maxBytesPerThread ?? 64 * 1024, options.maxEventsPerThread ?? 500);
      if (offset > page.fileSize) {
        offset = 0;
        state = emptyFollowupProjection();
      }
      for (const env of page.events) state = applyFollowupEvent(state, env, options.addressOf);
      offset = page.offset;
      const complete = offset >= page.fileSize;
      const latest = store.getThread(listed.threadId) ?? listed;
      const { followupOutcome: _stale, ...withoutStaleOutcome } = latest;
      const outcome = outcomeFor(state, latest, complete);
      const projected = outcome ? { ...withoutStaleOutcome, followupOutcome: outcome } : withoutStaleOutcome;
      const nextProgress = { offset, complete, state };
      if (!isDeepStrictEqual(latest.followupOutcome, outcome)) {
        store.saveFollowupProjection(projected, nextProgress);
        updated.push(projected);
      } else if (page.events.length || !progress || offset !== progress.offset || complete !== progress.complete) {
        store.saveFollowupProgress(latest.threadId, nextProgress);
      }
      processed++;
    } catch {
      unavailable.push(listed.threadId);
    }
  }
  return { processed, unavailable, updated, ...(next ? { next } : {}) };
}

function outcomeFor(state: FollowupProjectionState, meta: ThreadMeta, complete: boolean): ThreadMeta["followupOutcome"] | undefined {
  const active = state.active;
  return complete && meta.status === "failed" && active?.orderId === meta.orderId && active.closed && active.emptyRoute && state.lastAnswer
    ? { orderId: meta.orderId, answer: state.lastAnswer }
    : undefined;
}

export function projectFollowupOutcomes(events: ThreadEnvelope[], latestOrderId: string, latestStatus: ThreadMeta["status"]): Pick<FollowupProjectionState, "lastAnswer"> & { followupOutcome?: ThreadMeta["followupOutcome"] } {
  let state = emptyFollowupProjection();
  for (const env of events) state = applyFollowupEvent(state, env);
  const active = state.active;
  const followupOutcome = latestStatus === "failed" && active?.orderId === latestOrderId && active.closed && active.emptyRoute && state.lastAnswer
    ? { orderId: latestOrderId, answer: state.lastAnswer }
    : undefined;
  return { lastAnswer: state.lastAnswer, ...(followupOutcome ? { followupOutcome } : {}) };
}

function capPreview(text: string): { text: string; truncated: boolean } {
  if (text.length <= 300) return { text, truncated: false };
  let preview = text.slice(0, 300);
  const last = preview.charCodeAt(preview.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) preview = preview.slice(0, -1);
  return { text: preview, truncated: true };
}
