import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 4777;

/** Delivery deadlines (ms). See GLOSSARY: Order lifecycle. */
export const ACK_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MISSES = 3;
export const BROADCAST_DEADLINE_MS = 120_000;
export const MAX_ORDER_DEPTH = 4;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const AgentRole = z.enum(["barista", "customer"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentMode = z.enum(["tui", "headless", "cli", "web"]);
export type AgentMode = z.infer<typeof AgentMode>;

/** Contents of a `.cafe` Cafe File. */
export const CafeFile = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/, "name may only contain [a-zA-Z0-9_.-]"),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  scope: z.array(z.string()).default([]),
  role: AgentRole.default("barista"),
  concurrency: z.number().int().min(1).default(1),
});
export type CafeFile = z.infer<typeof CafeFile>;

export const AgentStatus = z.enum(["idle", "busy", "offline"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** What an Agent declares when it registers with its Daemon. */
export const AgentIdentity = CafeFile.extend({
  mode: AgentMode,
  cwd: z.string(),
  pid: z.number().int().optional(),
  /** On reconnect: ask to keep the agentId/Address from the previous connection. */
  resumeAgentId: z.string().optional(),
});
export type AgentIdentity = z.infer<typeof AgentIdentity>;

/** A Registry entry. */
export const AgentRecord = AgentIdentity.extend({
  agentId: z.string(),
  address: z.string(),
  host: z.string(),
  status: AgentStatus,
  registeredAt: z.number(),
  lastSeenAt: z.number(),
});
export type AgentRecord = z.infer<typeof AgentRecord>;

export const DaemonRecord = z.object({
  host: z.string(),
  url: z.string(),
  isRoot: z.boolean(),
  online: z.boolean(),
  connectedAt: z.number().optional(),
  lastSeenAt: z.number(),
});
export type DaemonRecord = z.infer<typeof DaemonRecord>;

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const OrderKind = z.enum(["order", "notice"]);
export type OrderKind = z.infer<typeof OrderKind>;

export const DeliveryMode = z.enum(["unicast", "multicast", "broadcast"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

export const Party = z.object({
  /** agentId for registered Agents; synthetic id for CLI/web Customers. */
  id: z.string(),
  address: z.string(),
  host: z.string(),
});
export type Party = z.infer<typeof Party>;

export const Order = z.object({
  orderId: z.string(),
  threadId: z.string(),
  kind: OrderKind,
  from: Party,
  /** Explicit Address requested by the Customer; skips LLM routing. */
  to: z.string().optional(),
  body: z.string(),
  parentOrderId: z.string().optional(),
  /** Agent ids already involved upstream in this call chain. */
  chain: z.array(z.string()).default([]),
  depth: z.number().int().min(0).default(0),
  deadlineMs: z.number().int().optional(),
  createdAt: z.number(),
  /** 1 for the first Order of a Thread; >1 for Follow-ups. */
  turn: z.number().int().min(1).default(1),
  /** Earlier turns of the Thread, oldest first (Follow-ups only). */
  history: z.array(z.object({ from: z.string(), role: z.enum(["customer", "barista"]), text: z.string() })).default([]),
});
export type Order = z.infer<typeof Order>;

export const RoutingDecision = z.object({
  targets: z.array(z.string()),
  mode: DeliveryMode,
  reason: z.string(),
  router: z.enum(["explicit", "followup", "llm", "rules"]),
  /** Ordered fallbacks for unicast re-delivery. */
  candidates: z.array(z.string()).default([]),
  /** Baristas that matched as well as the target but were ranked after it because they recently declined similar Orders. */
  demoted: z.array(z.string()).optional(),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;

/** Recent outcomes of one Barista identity (`name@host`), an auxiliary routing signal. */
export const RoutingHint = z.object({
  identity: z.string(),
  answered: z.number(),
  declined: z.number(),
  failed: z.number(),
  /** keyword → time-decayed weight of recent declines mentioning it. */
  declinedTopics: z.record(z.string(), z.number()),
});
export type RoutingHint = z.infer<typeof RoutingHint>;

export const ThreadStatus = z.enum(["routing", "delivering", "working", "done", "failed", "cancelled"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

/** Everything that happens to a Thread is a ThreadEvent; Threads are append-only logs of these. */
export const ThreadEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("order.created"), order: Order }),
  z.object({ type: z.literal("order.routed"), decision: RoutingDecision }),
  z.object({ type: z.literal("order.delivered"), agentId: z.string() }),
  z.object({ type: z.literal("order.acked"), agentId: z.string() }),
  z.object({ type: z.literal("order.heartbeat"), agentId: z.string(), note: z.string().optional() }),
  z.object({ type: z.literal("order.replied"), agentId: z.string(), text: z.string(), final: z.boolean() }),
  /** `unavailable`: an operational decline (timeout, shutdown), not "this topic is not mine". */
  z.object({ type: z.literal("order.declined"), agentId: z.string(), reason: z.string(), unavailable: z.boolean().optional() }),
  z.object({ type: z.literal("order.failed"), agentId: z.string().optional(), reason: z.string() }),
  z.object({ type: z.literal("order.cancelled"), by: z.string() }),
  /** One Order finished. The Thread stays open for Follow-ups. */
  z.object({ type: z.literal("order.closed"), status: ThreadStatus }),
]);
export type ThreadEventBody = z.infer<typeof ThreadEvent>;

export const ThreadEnvelope = z.object({
  eventId: z.string(),
  threadId: z.string(),
  orderId: z.string(),
  /** Host whose Daemon emitted the event. */
  host: z.string(),
  at: z.number(),
  event: ThreadEvent,
});
export type ThreadEnvelope = z.infer<typeof ThreadEnvelope>;

export const ThreadMeta = z.object({
  threadId: z.string(),
  orderId: z.string(),
  kind: OrderKind,
  from: Party,
  targets: z.array(z.string()),
  mode: DeliveryMode.optional(),
  status: ThreadStatus,
  summary: z.string(),
  createdAt: z.number(),
  firstReplyAt: z.number().optional(),
  closedAt: z.number().optional(),
  file: z.string(),
  /** Number of Orders (first + Follow-ups). */
  turns: z.number().int().default(1),
  /** When the latest Order (turn) was created. */
  turnStartedAt: z.number().optional(),
  /** Routing Decision of the latest Order. */
  reason: z.string().optional(),
  router: z.enum(["explicit", "followup", "llm", "rules"]).optional(),
  lastActivityAt: z.number().optional(),
  /** Final replies of the latest Order (text truncated), for list views. */
  replies: z.array(z.object({ agentId: z.string(), address: z.string().optional(), text: z.string(), at: z.number() })).default([]),
  /** Declines of the latest Order. */
  declines: z.array(z.object({ agentId: z.string(), address: z.string().optional(), reason: z.string(), at: z.number() })).default([]),
});
export type ThreadMeta = z.infer<typeof ThreadMeta>;

// ---------------------------------------------------------------------------
// Wire frames (codex app-server style: id+method requests, id-only responses,
// method-only notifications; no "jsonrpc" field).
// ---------------------------------------------------------------------------

export type Request<M extends string = string, P = unknown> = { id: number | string; method: M; params: P };
export type Notification<M extends string = string, P = unknown> = { method: M; params: P };
export type Response<R = unknown> =
  | { id: number | string; result: R }
  | { id: number | string; error: { code: string; message: string } };
export type Frame = Request | Notification | Response;

export const ClientKind = z.enum(["agent", "daemon", "ui"]);
export type ClientKind = z.infer<typeof ClientKind>;

export const InitializeParams = z.object({
  protocolVersion: z.number().int(),
  kind: ClientKind,
  token: z.string().optional(),
  /** For kind=daemon: the connecting Daemon's host and reachable URL. */
  host: z.string().optional(),
  url: z.string().optional(),
  registryVersion: z.number().int().optional(),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export const CreateOrderParams = z.object({
  body: z.string().min(1),
  kind: OrderKind.default("order"),
  to: z.string().optional(),
  parentOrderId: z.string().optional(),
  /** Follow-up: continue this Thread (default targets: Baristas that replied in it). */
  threadId: z.string().optional(),
  deadlineMs: z.number().int().optional(),
  /** Customer identity for callers that are not registered Agents (CLI, web). */
  as: z.string().optional(),
});
export type CreateOrderParams = z.infer<typeof CreateOrderParams>;

export const RegistryDelta = z.object({
  version: z.number().int(),
  upsert: z.array(AgentRecord).default([]),
  remove: z.array(z.string()).default([]),
});
export type RegistryDelta = z.infer<typeof RegistryDelta>;

/**
 * Method catalogue. Direction: A = agent, D = daemon (local), R = root, U = web UI.
 *
 * A→D  initialize, agent/register, agent/status, order/create, order/ack,
 *      order/heartbeat, order/reply, order/decline, order/cancel, agents/list
 * D→A  order/deliver (notification), thread/event (notification, to Customers)
 * D→R  initialize(kind=daemon), registry/upsert, registry/remove, order/relay,
 *      thread/event, route/decide
 * R→D  registry/snapshot, registry/delta, order/relay, thread/event, root/moved
 * D→U  snapshot (HTTP), thread/event, registry/delta, daemons/changed
 */
export const Methods = {
  initialize: "initialize",
  agentRegister: "agent/register",
  agentStatus: "agent/status",
  agentsList: "agents/list",
  orderCreate: "order/create",
  orderDeliver: "order/deliver",
  /** D→A: an Order you were working on was cancelled by its Customer. */
  orderCancelled: "order/cancelled",
  orderAck: "order/ack",
  orderHeartbeat: "order/heartbeat",
  orderReply: "order/reply",
  orderDecline: "order/decline",
  orderCancel: "order/cancel",
  orderRelay: "order/relay",
  threadEvent: "thread/event",
  registrySnapshot: "registry/snapshot",
  registryDelta: "registry/delta",
  registryUpsert: "registry/upsert",
  registryRemove: "registry/remove",
  routeDecide: "route/decide",
  /** Root→Daemon: latest routing hints (not versioned; replaces the previous set). */
  hintsUpdate: "hints/update",
  rootMoved: "root/moved",
  daemonsChanged: "daemons/changed",
} as const;

export function isRequest(f: Frame): f is Request {
  return "method" in f && "id" in f;
}
export function isNotification(f: Frame): f is Notification {
  return "method" in f && !("id" in f);
}
export function isResponse(f: Frame): f is Response {
  return !("method" in f) && "id" in f;
}

/** Format an Address: `name#n@host`. */
export function formatAddress(name: string, n: number, host: string): string {
  return `${name}#${n}@${host}`;
}

/** Parse an Address; `n` is undefined for group addresses (`name@host`). Host may be omitted (`name`). */
export function parseAddress(addr: string): { name: string; n?: number; host?: string } | undefined {
  const m = /^([a-zA-Z0-9_.-]+)(?:#(\d+))?(?:@([a-zA-Z0-9_.-]+))?$/.exec(addr.trim());
  if (!m) return undefined;
  return { name: m[1]!, n: m[2] ? Number(m[2]) : undefined, host: m[3] };
}
