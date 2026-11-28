import { z } from "zod";

export { CURRENT_FEATURES, DEFAULT_PORT, FEATURES, RESERVED_ASSIGNMENT_FEATURES, missingFeatures, onlineVersions, PROTOCOL_VERSION, type Feature } from "./version.ts";

/** Delivery deadlines (ms). See GLOSSARY: Order lifecycle. */
export const ACK_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MISSES = 3;
export const BROADCAST_DEADLINE_MS = 120_000;
export const MAX_ORDER_DEPTH = 4;
/** Events a Thread read returns when the caller gives no page size (#31). */
export const DEFAULT_THREAD_PAGE = 200;

/** Bound each history excerpt while retaining the conclusion of long messages (#129). */
export function compactHistoryText(text: string): string {
  const limit = 1500;
  if (text.length <= limit) return text;
  const marker = "\n…[truncated]…\n";
  const content = limit - marker.length;
  const tail = Math.floor(content / 2);
  return text.slice(0, content - tail).replace(/[\uD800-\uDBFF]$/, "") + marker + text.slice(-tail).replace(/^[\uDC00-\uDFFF]/, "");
}

/** Public status of a connector installed on the daemon serving the page. */
export interface ConnectorStatusRow {
  name: string;
  state: "connecting" | "connected" | "disconnected" | "running" | "stopped" | "crashed";
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const AgentRole = z.enum(["barista", "customer"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentMode = z.enum(["tui", "headless", "cli", "web"]);
export type AgentMode = z.infer<typeof AgentMode>;

/** A message scope (v4-11). `default` is implicit; channels are not security boundaries. */
export const ChannelName = z.string().regex(/^[a-z0-9_-]{1,64}$/, "channel names use a-z, 0-9, _ and -, at most 64 chars");
export type ChannelName = z.infer<typeof ChannelName>;
export const DEFAULT_CHANNEL = "default";

const DutyAliases = z.array(z.string().trim().min(1).max(64)).max(8);

/** One roster entry in a `.cafe` team block (v4-11). */
export const TeamMember = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/, "member name may only contain [a-zA-Z0-9_.-]"),
  duty: z.string().min(1).max(64).optional(),
  dutyAliases: DutyAliases.optional(),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  scope: z.array(z.string()).default([]),
  mode: z.enum(["headless", "tui"]).default("headless"),
  dir: z.string().min(1, "member directory path must not be empty").refine((value) => !value.includes("\0"), "member directory path must not contain NUL").refine((value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[a-zA-Z]:[\\\\/]/.test(value), "member directory path must be relative to the roster root").default("."),
  channels: z.array(ChannelName).optional(),
  observer: z.boolean().optional(),
  collect: z.enum(["any", "all"]).optional(),
  agent: z.string().optional(),
  bin: z.string().optional(),
  access: z.enum(["read-only", "write"]).optional(),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamSpec = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/, "team name may only contain [a-zA-Z0-9_.-]").optional(),
  channel: ChannelName.optional(),
  agent: z.string().optional(),
  members: z.array(TeamMember).min(1),
});
export type TeamSpec = z.infer<typeof TeamSpec>;

export const TeamAgent = z.enum(["pi", "omp", "codex", "claude"]);
const TeamBin = z.enum(["pi", "omp"]);

/** Local launch configuration. The replicated roster retains its backward-compatible shape. */
export const TeamLaunchSpec = TeamSpec.extend({
  agent: TeamAgent.optional(),
  members: z.array(TeamMember.extend({ agent: TeamAgent.optional(), bin: TeamBin.optional() })).min(1),
});

/** A roster replicated to the Root (v4-11; v4-13 adds the authoritative flag and content hash). */
export const TeamRecord = z.object({
  team: z.string(),
  host: z.string(),
  channel: ChannelName,
  members: z.array(TeamMember),
  revision: z.number().int().optional(),
  hostOnline: z.boolean().optional(),
  /** The roster came from a `.cafe` file: `teams()` must not grow it from live registrations. */
  authoritative: z.boolean().optional(),
  /** Hash of team/channel/members; an identical re-publish is a no-op (no revision bump, no push). */
  contentHash: z.string().optional(),
  /** Tombstone (v4-13): the roster was removed; keep it in teams.json so a stale upsert loses. */
  removed: z.boolean().optional(),
});
export type TeamRecord = z.infer<typeof TeamRecord>;

/** One entry of a team's live roster (v4-13). */
export const TeamRosterEntry = z.object({
  name: z.string(),
  duty: z.string().optional(),
  dutyAliases: DutyAliases.optional(),
  online: z.boolean().default(false),
});
export type TeamRosterEntry = z.infer<typeof TeamRosterEntry>;

/**
 * What a member needs to know about its team (v4-13). Delivered in the `agent/register` result,
 * never stored in the replicated AgentRecord.
 */
export const TeamContext = z.object({
  team: z.string(),
  channel: ChannelName,
  revision: z.number().int().optional(),
  self: z.object({ name: z.string(), duty: z.string().optional(), mode: z.string() }),
  orchestrator: z.string(),
  roster: z.array(TeamRosterEntry),
  playbook: z.string(),
});
export type TeamContext = z.infer<typeof TeamContext>;

/** A roster change pushed to online members (v4-13). Not an Order and never a turn of its own. */
export const TeamRosterUpdate = z.object({
  team: z.string(),
  channel: ChannelName,
  revision: z.number().int(),
  members: z.array(TeamRosterEntry),
  change: z.object({ added: z.array(z.string()).default([]), removed: z.array(z.string()).default([]), updated: z.array(z.string()).default([]) }),
  /** The team was removed; drop the playbook and stop addressing it. */
  removedTeam: z.boolean().optional(),
});
export type TeamRosterUpdate = z.infer<typeof TeamRosterUpdate>;

/**
 * The team playbook (v4-13). One template for every client, so pi/Claude/CLI see the same words.
 * It is deliberately short: it is injected once per process, and the roster is repeated only as
 * a compact list.
 */
export function renderTeamPlaybook(input: { team: string; channel: string; self: TeamRosterEntry; orchestrator: string; roster: TeamRosterEntry[] }): string {
  const { team, channel, self, orchestrator, roster } = input;
  const who = `You are ${self.name}${self.duty ? ` (${self.duty})` : ""} in team "${team}", channel #${channel}. The team's orchestrator (front door) is ${orchestrator}.`;
  const lines = [
    who,
    `Team roster: ${roster.map((m) => `${m.name}${m.duty ? `/${m.duty}` : ""}${m.online ? "" : " (offline)"}`).join(", ")}.`,
    "",
    "How the team talks:",
    `- Sending to "${team}" (or sending in #${channel} without a target) reaches the ORCHESTRATOR, not everyone.`,
    "- Assign one member with to: \"<member>\". Ask whoever owns a duty with to: \"<duty>\" (if that is ambiguous, use a name).",
    "- broadcast: true is the only way to reach every member. Use it only when the person explicitly asked everyone.",
    "- A question about an assignment goes back to the asker with escalate: true; never broadcast a clarification.",
    "- Use collect: \"all\" only when you need every target's answer; otherwise the first final answer closes the turn.",
    "- The roster can change while you work. `cafe team status` (or the team roster note) is authoritative before a big assignment.",
    "- Channels are scopes, not privacy boundaries.",
    "",
  ];
  if (self.duty === "orchestrator" || self.name === orchestrator) {
    lines.push(
      "Your job as orchestrator:",
      "- Split the task. Assign each part to one member at a time with to: \"<member>\".",
      ...roster.flatMap((m) => m.duty && m.dutyAliases?.length ? [`- Job phrases for ${m.duty}: ${m.dutyAliases.join(", ")}.`] : []),
      "- In Pi/OMP, use the registered cafe_ask tool with delegate: true to link the assignment to the active Order. Use the registered runtime for Agent delegation.",
      "- Send interim progress while delegated work is pending. In Pi/OMP, use cafe_reply with finalResult: true to submit the result of the active human Order. If you already answered the original Order, use cafe_reply with reportThreadId and reportOrderId.",
      "- Do not do the work yourself unless it is small; keep your context for the task and the reports.",
      "- Report to the person who asked you with a normal reply. Say what was done, where, and what is still open.",
    );
  } else {
    lines.push(
      "Your job as a member:",
      "- Do the work in this Order, then reply to it. Keep the reply short: what changed, where, what is blocked.",
      "- Need a decision or a clarification? Escalate to the asker with escalate: true; do not ask the whole team.",
      "- Status reports go to the orchestrator with to: \"<orchestrator>\", not to everyone.",
    );
  }
  return lines.join("\n");
}

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

/** A `.cafe` file: the top-level identity plus an optional team roster (v4-11). */
export const CafeDocument = CafeFile.extend({ team: TeamLaunchSpec.optional() });
export type CafeDocument = z.infer<typeof CafeDocument>;

export const AgentStatus = z.enum(["idle", "busy", "offline"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** What an Agent declares when it registers with its Daemon. */
export const AgentIdentity = CafeFile.extend({
  mode: AgentMode,
  // Display-only fields (v3-2). Plain strings, so a newer client with new values still registers with an older Daemon.
  /** Which agent runs this identity: pi, omp, codex, claude or command (`cafe serve`). Unknown values are shown as-is. */
  agent: z.string().optional(),
  /** Bridges only: "read-only" or "write" (may edit files in its directory). */
  access: z.string().optional(),
  /** `cafe serve` only: the command run once per Order (the client truncates it to 80 characters). */
  command: z.string().optional(),
  cwd: z.string(),
  pid: z.number().int().optional(),
  /** A TUI session running in the background (e.g. Claude Code `--bg`): no terminal shows it. Display only. */
  background: z.boolean().optional(),
  /** On reconnect: ask to keep the agentId/Address from the previous connection. */
  resumeAgentId: z.string().optional(),
  // --- v4-11 agent teams. All optional: an old client registers unchanged. ---
  /** Team name the process belongs to. */
  team: z.string().optional(),
  /** The team's channel (so the Web and `to: <team>` need no roster). */
  teamChannel: ChannelName.optional(),
  /** Roster entry name inside the team. */
  member: z.string().optional(),
  /** Local directory holding the roster `.cafe` (same Host only; lets the daemon read the full roster). */
  teamDir: z.string().optional(),
  memberLaunchHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  durableAssignments: z.literal(true).optional(),
  /** Free-form responsibility label used as a routing signal. */
  duty: z.string().min(1).max(64).optional(),
  /** Channels this Agent receives from; the first entry is its home channel. Absent = ["default"]. */
  channels: z.array(ChannelName).optional(),
  /** Observers are never routing targets; they receive channel digests instead. */
  observer: z.boolean().optional(),
});
export type AgentIdentity = z.infer<typeof AgentIdentity>;

/** The channels an Agent/record receives from (v4-11). */
export function channelsOf(a: { channels?: string[] }): string[] {
  return a.channels?.length ? a.channels : [DEFAULT_CHANNEL];
}

/** A Registry entry. */
export const AgentRecord = AgentIdentity.extend({
  agentId: z.string(),
  address: z.string(),
  host: z.string(),
  status: AgentStatus,
  registeredAt: z.number(),
  lastSeenAt: z.number(),
  /** User-visible name (defaults to `name`); changing it does not change the Address. */
  displayName: z.string().optional(),
  /** Previous names/aliases that still resolve to this Agent. */
  aliases: z.array(z.string()).default([]),
  /** Names kept for routing only (automatic on rename); never used as the display label. */
  legacyAliases: z.array(z.string()).default([]),
  /** Thread this Agent is currently handling (v4-11); set by its own daemon. */
  activeThreadId: z.string().optional(),
  /** Exact Order being handled; late events must not clear a newer Order in the same Thread. */
  activeOrderId: z.string().optional(),
});
export type AgentRecord = z.infer<typeof AgentRecord>;

export const HostIdentity = z.object({
  /** Immutable Root-assigned identity; separate from the mutable routing/display slug. */
  hostId: z.string().min(1),
  host: z.string().min(1),
  /** SPKI fingerprint bound to the Host certificate by the Root. */
  keyFingerprint: z.string().min(1),
  state: z.enum(["enrolled", "revoked"]),
  revision: z.number().int().nonnegative().optional(),
});
export type HostIdentity = z.infer<typeof HostIdentity>;

export const DaemonRecord = z.object({
  host: z.string(),
  /** Stable Root-assigned identity; absent on older Daemons. */
  hostId: z.string().optional(),
  /** User-visible name (defaults to `host`). Renaming it does not change routing keys. */
  displayName: z.string().optional(),
  /** Previous names that still identify this Host in addresses. */
  aliases: z.array(z.string()).default([]),
  /** Names kept for routing only (automatic on rename); never used as the display label. */
  legacyAliases: z.array(z.string()).default([]),
  url: z.string(),
  isRoot: z.boolean(),
  online: z.boolean(),
  connectedAt: z.number().optional(),
  lastSeenAt: z.number(),
  /** cafe release running on that Host (absent: older than this field). */
  version: z.string().optional(),
  /** Features that Host's Daemon supports (v4-12); absent = an older release. */
  features: z.array(z.string()).optional(),
  /** Its last connection was refused (#89: plaintext link to a TLS Root); cleared when it joins. */
  refused: z.object({ reason: z.literal("plaintext"), at: z.number() }).optional(),
});
export type DaemonRecord = z.infer<typeof DaemonRecord>;


// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const OrderKind = z.enum(["order", "notice"]);
export type OrderKind = z.infer<typeof OrderKind>;

export const DeliveryMode = z.enum(["unicast", "multicast", "broadcast"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

export const EventActor = z.object({
  kind: z.enum(["human", "connector", "agent", "operator"]),
  /** Opaque stable principal ID; raw credentials and digests never appear in the event. */
  principalId: z.string().min(1),
});
export type EventActor = z.infer<typeof EventActor>;

export const Party = z.object({
  /** agentId for registered Agents; synthetic id for CLI/web Customers. */
  id: z.string(),
  address: z.string(),
  host: z.string(),
});
export type Party = z.infer<typeof Party>;

/** Who actually asked: a person, or an Agent relaying the person's request. */
export const OrderOrigin = z.enum(["human", "agent"]);
export type OrderOrigin = z.infer<typeof OrderOrigin>;

/** The Agent that relayed the question (the person's words may differ from `body`). */
export const OrderVia = z.object({
  id: z.string().optional(),
  address: z.string(),
  name: z.string().optional(),
});
export type OrderVia = z.infer<typeof OrderVia>;

/** A file carried by an Order. Blobs live on the origin Host; the wire only carries metadata. */
export const Attachment = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string().default("application/octet-stream"),
  size: z.number().int(),
  sha256: z.string(),
  /** Host whose daemon holds the blob; absent on Threads older than attachments. */
  host: z.string().optional(),
  /** Who uploaded it (web / cli / mcp or an Agent), for display and audit. */
  uploader: Party.optional(),
});
export type Attachment = z.infer<typeof Attachment>;

export const Order = z.object({
  orderId: z.string(),
  threadId: z.string(),
  kind: OrderKind,
  from: Party,
  /** Message scope (v4-11); absent on Orders older than channels. */
  channel: ChannelName.optional(),
  /** any (default) or all (v4-11). */
  collect: z.enum(["any", "all"]).optional(),
  /** Absent on Threads created before provenance existed. */
  origin: OrderOrigin.optional(),
  via: OrderVia.optional(),
  /** Caller supplied origin/via fields are display claims unless a registered Agent peer authored the Order. */
  provenanceVerified: z.boolean().optional(),
  /** Explicit Address requested by the Customer; skips LLM routing. */
  to: z.string().optional(),
  body: z.string(),
  /**
   * Optional per-target question text, keyed by agentId (v4-7 #39). A target missing from the map
   * receives `body`, so a partial map is safe. Delivery sends only the target's own text; the
   * recorded Order and history keep the shared `body`.
   */
  variants: z.record(z.string(), z.string()).optional(),
  /** Files attached to this Order; the blobs stay on their origin Host. */
  attachments: z.array(Attachment).optional(),
  parentOrderId: z.string().optional(),
  /** The Thread holding the parent Order (v4-11 sub-Thread link). */
  parentThreadId: z.string().optional(),
  /** Short excerpt of the parent task, derived by the sending daemon for a known participant. */
  parentContext: z.string().max(640).optional(),
  /** The issuing daemon verified the original human parent's owner credential for this link. */
  parentOwnerVerified: z.literal(true).optional(),
  /** One-use owner-authored attestation for a human answer in a clarification Thread. */
  parentOwnerAttestation: z.object({
    attestationId: z.string().min(1),
    parentOrderId: z.string().min(1),
    parentThreadId: z.string().min(1),
    clarificationOrderId: z.string().min(1),
    recipientAgentId: z.string().min(1),
    recipientHostId: z.string().min(1),
    parentAssignmentId: z.string().min(1).optional(),
    answerRequestId: z.string().min(1),
    answerHash: z.string().min(1),
  }).optional(),
  /** The issuing daemon has a private ownership credential for this human Order. */
  humanClarifications: z.literal(true).optional(),
  /** The first turn publishes a question for the owner of its human parent. */
  needsHuman: z.literal(true).optional(),
  /** A validated human answer, pinned to the Agent that published the question. */
  clarificationRecipient: Party.optional(),
  /** This Order was created with an explicit escalation (v4-11). */
  escalate: z.boolean().optional(),
  /** Agent ids already involved upstream in this call chain. */
  chain: z.array(z.string()).default([]),
  depth: z.number().int().min(0).default(0),
  deadlineMs: z.number().int().optional(),
  createdAt: z.number(),
  /** 1 for the first Order of a Thread; >1 for Follow-ups. */
  turn: z.number().int().min(1).default(1),
  /** Earlier turns of the Thread, oldest first (Follow-ups only). */
  history: z.array(z.object({ from: z.string(), agentId: z.string().optional(), role: z.enum(["customer", "barista"]), text: z.string() })).default([]),
});
export type Order = z.infer<typeof Order>;

/** Why a sub-Order could not be delivered (v4-11; v4-13 adds the team-session failures). */
export const SubOrderFailure = z.enum([
  "parent_offline",
  "parent_not_agent",
  "unknown_team",
  "team_offline",
  "ambiguous_team",
  "ambiguous_address",
  "no_online_barista",
  "no_channel_members",
  /** v4-13: a roster has no (or more than one) orchestrator. */
  "no_orchestrator",
  /** v4-13: `to: <duty>` matched more than one online member. */
  "ambiguous_duty",
  /** v4-13: no member has that duty. */
  "unknown_duty",
  /** v4-13: two teams own one channel, so its default recipient is not unique. */
  "ambiguous_channel",
  "self_delivery",
  /** v4-13: a follow-up's responders and targets are all offline. */
  "responders_offline",
]);
export type SubOrderFailure = z.infer<typeof SubOrderFailure>;

export const RoutingDecision = z.object({
  targets: z.array(z.string()),
  mode: DeliveryMode,
  reason: z.string(),
  router: z.enum(["explicit", "followup", "llm", "rules"]),
  /** Ordered fallbacks for unicast re-delivery. */
  candidates: z.array(z.string()).default([]),
  /** Baristas that matched as well as the target but were ranked after it because they recently declined similar Orders. */
  demoted: z.array(z.string()).optional(),
  /** Set when the LLM router failed and the keyword rules decided instead. */
  llmError: z.string().optional(),
  /** A coarse, explainable confidence: 1 = explicit/only owner, below 0.5 = a guess. */
  confidence: z.number().min(0).max(1).optional(),
  /** Why plausible Baristas were not chosen (bounded to a few entries). */
  whyNot: z.array(z.object({ agentId: z.string(), reason: z.string() })).optional(),
  /** How many Baristas received this Order (targets.length). */
  fanout: z.number().int().min(0).optional(),
  /** A question was published for the owner of the parent Order. */
  needsHuman: z.literal(true).optional(),
  /** Machine-readable failure when targets is empty (v4-11). */
  failure: SubOrderFailure.optional(),
  /**
   * Per-target question text for a multicast Order (v4-7 #39). Delivery-only: `dispatch()` sends
   * target `t` the text `variants[t]`, falling back to the Order's `body`.
   */
  variants: z.record(z.string(), z.string()).optional(),
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
export const OrderAssignment = z.object({
  assignmentId: z.string().min(1),
  targetAgentId: z.string().min(1),
  targetHostId: z.string().min(1),
  /** Target-specific text/history copied from the canonical Order assignment. */
  body: z.string(),
  history: z.array(z.object({ from: z.string(), agentId: z.string().optional(), role: z.enum(["customer", "barista"]), text: z.string() })).default([]),
  bodyHash: z.string().optional(),
});
export type OrderAssignment = z.infer<typeof OrderAssignment>;

export const OrderAssignmentReference = OrderAssignment.pick({ assignmentId: true, targetAgentId: true, targetHostId: true }).extend({
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Canonical transport choice, fixed when the assignment is journaled. Missing means legacy. */
  relayMode: z.enum(["compat", "strict"]).optional(),
});
export type OrderAssignmentReference = z.infer<typeof OrderAssignmentReference>;
const JournalAssignment = z.union([OrderAssignmentReference, OrderAssignment]);

export const OrderReplacement = z.object({ type: z.literal("order.replaced"), previousOrderId: z.string(), order: Order, decision: RoutingDecision, assignments: z.array(JournalAssignment) });

export const ThreadEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("order.created"), order: Order }),
  z.object({ type: z.literal("order.routed"), decision: RoutingDecision }),
  z.object({ type: z.literal("order.assigned"), assignment: JournalAssignment }),
  z.object({ type: z.literal("order.delivered"), agentId: z.string(), assignmentId: z.string().optional(), protectedIdentity: z.literal(true).optional() }),
  z.object({ type: z.literal("order.acked"), agentId: z.string(), assignmentId: z.string().optional() }),
  z.object({ type: z.literal("order.heartbeat"), agentId: z.string(), assignmentId: z.string().optional(), note: z.string().optional() }),
  z.object({ type: z.literal("order.replied"), agentId: z.string(), assignmentId: z.string().optional(), text: z.string(), final: z.boolean(), source: z.enum(["agent", "operator"]).optional(), auditOnly: z.literal(true).optional(), awaitingOwner: z.literal(true).optional(), attachments: z.array(Attachment).optional() }),
  z.object({ type: z.literal("order.final-accepted"), agentId: z.string(), assignmentId: z.string(), replyEventId: z.string(), text: z.string(), attachments: z.array(Attachment).optional() }),
  /** A result added by an original recipient after the human Order closed. */
  z.object({ type: z.literal("order.reported"), agentId: z.string(), assignmentId: z.string().optional(), text: z.string() }),
  /** `unavailable`: an operational decline (timeout, shutdown), not "this topic is not mine". */
  z.object({ type: z.literal("order.declined"), agentId: z.string(), assignmentId: z.string().optional(), reason: z.string(), unavailable: z.boolean().optional(), /** The thread closed first; this target was never asked to do anything wrong (#101). */ skipped: z.boolean().optional() }),
  z.object({ type: z.literal("order.dispatch-failed"), agentId: z.string(), assignmentId: z.string(), reason: z.string() }),
  z.object({ type: z.literal("order.failed"), agentId: z.string().optional(), assignmentId: z.string().optional(), reason: z.string(), /** Operational failure (timeout), not "this topic is not mine". */ unavailable: z.boolean().optional() }),
  z.object({ type: z.literal("order.cancelled"), by: z.string() }),
  OrderReplacement,
  z.object({ type: z.literal("order.overridden"), targetAgentId: z.string(), text: z.string(), final: z.boolean(), attachments: z.array(Attachment).optional() }),
  /** One Order finished. The Thread stays open for Follow-ups. */
  z.object({ type: z.literal("order.closed"), status: ThreadStatus }),
]);
export type ThreadEventBody = z.infer<typeof ThreadEvent>;

/** The result presented to callers. Audit-only replies stay in the journal. */
export function orderReplyView(event: ThreadEventBody): Extract<ThreadEventBody, { type: "order.replied" }> | undefined {
  if (event.type === "order.replied") return event.auditOnly || event.awaitingOwner ? undefined : event;
  if (event.type === "order.final-accepted") return { type: "order.replied", agentId: event.agentId, assignmentId: event.assignmentId, final: true, text: event.text, attachments: event.attachments };
  if (event.type !== "order.overridden") return undefined;
  return { type: "order.replied", agentId: event.targetAgentId, text: event.text, final: event.final, source: "operator", attachments: event.attachments };
}

export const ThreadEnvelope = z.object({
  eventId: z.string(),
  threadId: z.string(),
  orderId: z.string(),
  /** Host whose Daemon emitted the event; absent on legacy entries. */
  host: z.string(),
  /** Immutable authenticated source Host ID; absent only on legacy/unverified entries. */
  eventHostId: z.string().min(1).optional(),
  /** Authenticated caller principal; legacy entries may omit it. */
  actor: EventActor.optional(),
  at: z.number(),
  event: ThreadEvent,
});
export type ThreadEnvelope = z.infer<typeof ThreadEnvelope>;

export const OrderAssignmentDelivery = z.object({
  assignment: OrderAssignmentReference,
  ownerHostId: z.string().min(1),
  orderCreatedEventId: z.string().min(1),
  assignmentEventId: z.string().min(1),
  predecessors: z.array(ThreadEnvelope.extend({ event: z.union([z.object({ type: z.literal("order.created"), order: Order }), OrderReplacement]) })).max(64).optional(),
  creation: ThreadEnvelope.extend({ event: z.union([z.object({ type: z.literal("order.created"), order: Order }), OrderReplacement]) }),
  assignmentEvent: ThreadEnvelope.extend({ event: z.union([z.object({ type: z.literal("order.assigned"), assignment: OrderAssignmentReference }), OrderReplacement]) }),
});
export type OrderAssignmentDelivery = z.infer<typeof OrderAssignmentDelivery>;

export const TaskStatus = z.enum(["working", "awaiting_report", "done", "failed", "cancelled", "unknown"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TargetState = z.enum(["pending", "acked", "replied", "declined", "failed", "skipped", "overridden"]);
export type TargetState = z.infer<typeof TargetState>;

export const ThreadMeta = z.object({
  threadId: z.string(),
  orderId: z.string(),
  kind: OrderKind,
  /** Message scope (v4-11); absent on Threads older than channels. */
  channel: ChannelName.optional(),
  /** Set when this Thread is a clarification/escalation of another Thread (v4-11). */
  parentThreadId: z.string().optional(),
  parentOrderId: z.string().optional(),
  /** Set only after the parent Human Order owner credential was verified. */
  parentOwnerVerified: z.literal(true).optional(),
  clarification: z.object({ orderId: z.string(), question: z.string(), acknowledged: z.boolean().optional() }).optional(),
  from: Party,
  /** Provenance of the first question; absent on older Threads. */
  origin: OrderOrigin.optional(),
  via: OrderVia.optional(),
  /** Whether origin/via are authenticated actor provenance rather than display claims. */
  provenanceVerified: z.boolean().optional(),
  targets: z.array(z.string()),
  mode: DeliveryMode.optional(),
  status: ThreadStatus,
  summary: z.string(),
  /** Turn (question) the summary shows; the title stays on the first question. */
  summaryTurn: z.number().int().default(1),
  createdAt: z.number(),
  firstReplyAt: z.number().optional(),
  closedAt: z.number().optional(),
  file: z.string(),
  /** Number of Orders (first + Follow-ups). */
  turns: z.number().int().default(1),
  /** When the latest Order (turn) was created. */
  turnStartedAt: z.number().optional(),
  /** Files on every turn (first seen first, deduplicated), so list views can show "2 attachments". */
  attachments: z.array(Attachment).optional(),
  /** Routing Decision of the latest Order. */
  reason: z.string().optional(),
  router: z.enum(["explicit", "followup", "llm", "rules"]).optional(),
  lastActivityAt: z.number().optional(),
  /** Final replies of the latest Order (text truncated), for list views. */
  replies: z.array(z.object({ agentId: z.string(), address: z.string().optional(), text: z.string(), at: z.number(), source: z.enum(["agent", "operator"]).optional() })).default([]),
  /** Declines of the latest Order. */
  declines: z.array(z.object({ agentId: z.string(), address: z.string().optional(), reason: z.string(), at: z.number() })).default([]),
  /** Derived in Thread detail: visible child Orders of this turn that still need work. */
  pendingChildren: z.number().int().nonnegative().optional(),
  /** Latest parent Order with a persisted result report; used to project task state. */
  reportedOrderId: z.string().optional(),
  /** Derived task lifecycle, kept separate from this Thread's Order status. */
  taskStatus: TaskStatus.optional(),
  /** True when the parent projection could not query all relevant Hosts. */
  childrenPartial: z.boolean().optional(),
  /** Per-target state of the latest Order (v4-11); absent on old rows. */
  targetStates: z.array(z.object({ agentId: z.string(), state: TargetState })).optional(),
  /** Historical answer shown when this exact latest follow-up failed before delivery. */
  followupOutcome: z.object({
    orderId: z.string(),
    answer: z.object({
      orderId: z.string(), turn: z.number().int().positive(), agentId: z.string(),
      address: z.string().optional(), source: z.enum(["agent", "operator"]).optional(), text: z.string(), truncated: z.boolean(),
    }),
  }).optional(),
});
export type ThreadMeta = z.infer<typeof ThreadMeta>;

/** Derive whole-task status from one parent Order and its authenticated linked children. */
export function projectTaskStatus(parent: ThreadMeta, children: ThreadMeta[], partial = false): TaskStatus | undefined {
  const linked = children.filter((child) => child.parentThreadId === parent.threadId && child.parentOrderId === parent.orderId && (!child.clarification || child.turns > 1));
  if (!linked.length) return undefined;
  const terminal = parent.status === "failed" || parent.status === "cancelled";
  const openChild = linked.some((child) => (!terminal || !child.clarification) && (child.status === "routing" || child.status === "delivering" || child.status === "working"));
  if (openChild) return "working";
  if (terminal && linked.some((child) => child.clarification)) return parent.status === "failed" ? "failed" : "cancelled";
  if (partial) return "unknown";
  if (parent.status === "failed" || parent.status === "cancelled") return parent.status;
  if (parent.status !== "done") return "working";
  if (parent.reportedOrderId === parent.orderId) return "done";
  const humanParent = parent.origin !== "agent" && parent.from.id.startsWith("cli:");
  const agentCreatedWork = linked.some((child) => child.origin === "agent" || !child.from.id.startsWith("cli:"));
  return humanParent && agentCreatedWork ? "awaiting_report" : "done";
}

/** A channel digest for an observer (v4-11): one summary, not an Order. */
export const ChannelDigest = z.object({
  /** `<host>:<seq>` (v4-13); a number is accepted for an older publisher. */
  digestId: z.union([z.string(), z.number().int()]),
  channel: ChannelName,
  since: z.number(),
  threads: z.array(
    z.object({
      threadId: z.string(),
      orderId: z.string().optional(),
      status: z.string(),
      from: z.object({ id: z.string(), address: z.string(), host: z.string() }),
      summary: z.string(),
      targets: z.array(z.string()).default([]),
      replies: z.number().int().default(0),
      declined: z.number().int().default(0),
      closedAt: z.number().optional(),
      parentThreadId: z.string().optional(),
    }),
  ),
  omitted: z.number().int().default(0),
  /** Terminal failures past the visible 20-thread cap, within the bounded query window. */
  omittedFailures: z.array(z.object({
    threadId: z.string(),
    orderId: z.string(),
    status: z.literal("failed"),
    summary: z.string(),
    closedAt: z.number(),
  })).optional(),
  partial: z.boolean().optional(),
});
export type ChannelDigest = z.infer<typeof ChannelDigest>;

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

/** `peer`: another Daemon connecting directly while the Root is offline (ADR-0004). */
export const ClientKind = z.enum(["agent", "daemon", "ui", "peer"]);
export type ClientKind = z.infer<typeof ClientKind>;

export const InitializeParams = z.object({
  protocolVersion: z.number().int(),
  kind: ClientKind,
  token: z.string().optional(),
  /** For kind=daemon: the connecting Daemon's host and reachable URL. */
  host: z.string().optional(),
  /** Stable Root-assigned Host identity, authenticated by the TLS peer certificate. */
  hostId: z.string().optional(),
  /** Version of the Host certificate identity protocol; absent on older Daemons. */
  hostAuthVersion: z.number().int().optional(),
  /** The Root identity a child has pinned locally for this network. */
  rootHostId: z.string().optional(),
  /** Display name and aliases of the connecting Daemon (rename does not change `host`). */
  displayName: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  legacyAliases: z.array(z.string()).optional(),
  url: z.string().optional(),
  registryVersion: z.number().int().optional(),
  /** cafe release of the connecting side, for mismatch messages and the Network view. */
  cafeVersion: z.string().optional(),
  /** Features the connecting side supports (v4-12); absent = an older release. */
  features: z.array(z.string()).optional(),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export const CreateOrderParams = z.object({
  body: z.string().min(1),
  kind: OrderKind.default("order"),
  /** Message scope (v4-11). Explicit wins for a fresh Order; follow-ups/sub-Threads inherit. */
  channel: ChannelName.optional(),
  /** any (default): first final answer wins; all: wait for every target or the deadline. */
  collect: z.enum(["any", "all"]).optional(),
  to: z.string().optional(),
  parentOrderId: z.string().optional(),
  /** The Thread holding the parent Order (v4-11); used when it is no longer in the daemon's memory. */
  parentThreadId: z.string().optional(),
  /**
   * Explicit escalation (v4-11): requires parentOrderId and creates a sub-Thread whose target is
   * the parent Order's sender. Without this flag, parentOrderId keeps its provenance meaning.
   */
  escalate: z.boolean().optional(),
  /** Follow-up: continue this Thread (default targets: Baristas that replied in it). */
  threadId: z.string().optional(),
  deadlineMs: z.number().int().min(1).max(2_147_483_647).optional(),
  /** Customer identity for callers that are not registered Agents (CLI, web). */
  as: z.string().optional(),
  /** `agent` when an Agent relays the person's request; defaults to `human`. */
  origin: OrderOrigin.optional(),
  via: OrderVia.optional(),
  /** Already-uploaded files to attach (ids from POST /api/artifacts on the same daemon). */
  attachments: z.array(Attachment).optional(),
  /** Ask every eligible Barista, bypassing routing (only when the customer explicitly wants it). */
  broadcast: z.boolean().optional(),
  /** Follow-up only: replace this exact still-open Order after owner authorization. */
  replaceOrderId: z.string().min(1).optional(),
  /** @deprecated transitional legacy request field; removed after all callers send replaceOrderId. */
  replace: z.boolean().optional(),
  /**
   * Customer-side dedupe key (a platform event id for connectors). A repeated
   * request inside the Daemon's short window returns the first Order/Thread
   * instead of creating a new Thread. Optional: callers without it guarantee
   * idempotency themselves.
   */
  idempotencyKey: z.string().min(1).max(256).optional(),
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
 *      order/heartbeat, order/reply, order/decline, order/cancel, agents/list,
 *      agent/session/get, agent/session/set
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
  /** A→D: the external session (Codex thread, Claude session) a bridged Barista uses for a cafe Thread. */
  agentSessionGet: "agent/session/get",
  agentSessionSet: "agent/session/set",
  /** Root → owning Daemon: change an Agent's display name (Address stays stable). */
  agentRename: "agent/rename",
  /** Child → Root: this Host's display name / aliases changed. */
  hostIdentity: "host/identity",
  orderCreate: "order/create",
  orderDeliver: "order/deliver",
  /** D→A: an Order you were working on was cancelled by its Customer. */
  orderCancelled: "order/cancelled",
  orderAck: "order/ack",
  orderReceive: "order/receive",
  assignmentStatus: "order/assignment-status",
  /** Body-free check of the exact live route and local Agent before a strict assignment transfer. */
  assignmentPreflight: "assignment/preflight",
  /** Acknowledged private payload transfer; never used as a compatibility fallback. */
  assignmentRelay: "assignment/relay",
  orderHeartbeat: "order/heartbeat",
  orderReply: "order/reply",
  orderDecline: "order/decline",
  orderCancel: "order/cancel",
  orderRelay: "order/relay",
  threadEvent: "thread/event",
  /** Child → Root: batch task-state projection for one visible list page. */
  threadTaskStatuses: "thread/task-statuses",
  registrySnapshot: "registry/snapshot",
  registryDelta: "registry/delta",
  registryUpsert: "registry/upsert",
  registryRemove: "registry/remove",
  routeDecide: "route/decide",
  /** Root→Daemon: latest routing hints (not versioned; replaces the previous set). */
  hintsUpdate: "hints/update",
  /** Daemon→Root after reconnecting: events of Threads that went direct while the Root was offline. */
  threadBackfill: "thread/backfill",
  rootMoved: "root/moved",
  daemonsChanged: "daemons/changed",
  /** v4-11: a daemon publishes a full team roster (revision-guarded) to the Root / children. */
  teamUpsert: "team/upsert",
  teamRemove: "team/remove",
  /** v4-13: Daemon→Agent, a changed roster (not an Order; never triggers a turn). */
  teamRoster: "team/roster",
  /** v4-11: a channel digest for an observer (not an Order). */
  channelDigest: "channel/digest",
  /** Root→children: a Host was forgotten (v4-8); drop its address, link and pins. */
  hostForgotten: "cafe/hostForgotten",
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
