import type { AgentRecord, Order, RoutingDecision, RoutingHint } from "@cafe/protocol";
import { historyPenalty, overlappingDeclines, tokenize } from "./hints.ts";

export interface RouteInput {
  order: Order;
  /** Baristas eligible for this Order (already excludes the Customer and the call chain). */
  candidates: AgentRecord[];
  /** Recent outcomes by agentId (auxiliary; absent when `router.learn` is off or there is no history). */
  hints?: Map<string, RoutingHint>;
  /** The customer explicitly asked everyone (`cafe ask --broadcast`, the Web "ask everyone" control). */
  broadcast?: boolean;
}

/** Bounded fan-out when no Barista clearly owns the question. */
export const TOP_K = 3;

export interface Router {
  readonly name: RoutingDecision["router"];
  decide(input: RouteInput): Promise<RoutingDecision>;
}

/** True if every token of `phrase` is in `body` (a CJK tag like "数据库" becomes the bigrams 数据 + 据库). */
function mentions(body: Set<string>, phrase: string): boolean {
  const t = tokenize(phrase);
  if (t.size === 0) return false;
  for (const x of t) if (!body.has(x)) return false;
  return true;
}

/**
 * Artifact/intent words that identify a role more precisely than a domain word.
 * "Please update the README for the billing service" contains "billing", but the
 * work is documentation: a candidate whose text uses the docs vocabulary wins
 * (#39). Each group fires only when the Order contains one of its action words
 * and the candidate describes that area; the raw text test keeps the singular
 * verb "document" from firing on the noun "documents".
 */
const INTENT_GROUPS: ReadonlyArray<{ test: RegExp; words: readonly string[] }> = [
  { test: /\b(readme|changelog|documentation|docs|guide)\b|\bdocument\b(?!s)/i, words: ["readme", "changelog", "documentation", "doc", "guide", "reference"] },
  { test: /\b(deploy|deployment|rollout|release|pipeline)\b/i, words: ["deploy", "deployment", "rollout", "release", "pipeline", "kubernetes", "terraform"] },
  { test: /\b(rotate|credential|secret|oauth|permission|authentication)\b/i, words: ["rotate", "credential", "secret", "oauth", "permission", "authentication", "auth"] },
];

/** Longer tokens are more specific: `elasticsearch` should beat a generic `index` hit. */
const specific = (t: string) => (t.length >= 8 ? 2 : 0);

/**
 * Deterministic fallback: keyword overlap between the Order body and each
 * Barista's name/tags/description/scope.
 *
 * Ranking is (description score, then idle bonus minus history penalty). The
 * penalty is < 1, so history only reorders Baristas that tie on the description.
 * With no strong match, the top-k candidates are asked together (bounded
 * fan-out) instead of broadcasting to everyone; an explicit broadcast still
 * reaches all of them (#39).
 */
export class RulesRouter implements Router {
  readonly name = "rules" as const;

  async decide({ order, candidates, hints, broadcast }: RouteInput): Promise<RoutingDecision> {
    if (candidates.length === 0) return { targets: [], mode: "broadcast", reason: "no eligible baristas", router: "rules", candidates: [] };
    if (broadcast) return { targets: candidates.map((c) => c.agentId), mode: "broadcast", reason: "customer asked everyone", router: "rules", candidates: [] };
    const body = tokenize(order.body);
    const scored = candidates
      .map((c) => {
        const text = tokenize(`${c.name} ${c.tags.join(" ")} ${c.description} ${c.scope.join(" ")}`);
        let score = 0;
        if (mentions(body, c.name)) score += 5;
        for (const t of c.tags) {
          if (mentions(body, t)) score += 3 + specific(t);
        }
        for (const t of text) if (body.has(t)) score += 1 + specific(t);
        for (const group of INTENT_GROUPS) {
          if (group.test.test(order.body) && group.words.some((w) => text.has(w))) score += 10;
        }
        // Weak signal for the top-k fallback: how many body tokens this Barista mentions at all.
        const weak = [...body].filter((t) => text.has(t)).length;
        const penalty = historyPenalty(hints?.get(c.agentId), body);
        const tiebreak = (c.status === "idle" ? 0.5 : 0) - penalty;
        return { c, score, weak, penalty, tiebreak };
      })
      .sort((a, b) => b.score - a.score || b.weak - a.weak || b.tiebreak - a.tiebreak);
    const matched = scored.filter((s) => s.score >= 1);
    const best = matched[0];
    if (best) {
      // A genuinely separable question: two strong owners and a conjunction. Each
      // gets the same text (rules cannot split it), and the daemon's grace window
      // closes the Thread after the first final answer (#39).
      const separable = /\b(and|also|plus|as well as)\b|[,，;；]|并且|同时|还有/.test(order.body);
      const strong = matched.filter((s) => s.score >= 3);
      if (separable && strong.length >= 2 && strong[1]!.score >= strong[0]!.score * 0.6) {
        const top = strong.slice(0, TOP_K);
        return {
          targets: top.map((s) => s.c.agentId),
          mode: top.length > 1 ? "multicast" : "unicast",
          reason: `separable parts, likely ${top.map((s) => s.c.address).join(", ")}`,
          router: "rules",
          candidates: matched.filter((s) => !top.includes(s)).map((s) => s.c.agentId),
        };
      }
      // Only Baristas that tied with the target on the description were actually moved by history.
      const demoted = matched.filter((s) => s !== best && s.score === best.score && s.penalty > best.penalty);
      const history = demoted.length
        ? `; history: ${demoted.map((s) => `${s.c.address} declined similar orders`).join(", ")}`
        : "";
      return {
        targets: [best.c.agentId],
        mode: "unicast",
        reason: `keyword match (score ${best.score}) on ${best.c.address}${history}`,
        router: "rules",
        candidates: matched.slice(1).map((s) => s.c.agentId),
        ...(demoted.length ? { demoted: demoted.map((s) => s.c.agentId) } : {}),
      };
    }
    // Bounded fan-out: the caller chose top-k over asking nobody and over
    // broadcasting to the whole network.
    const top = scored.slice(0, Math.min(TOP_K, scored.length));
    return {
      targets: top.map((s) => s.c.agentId),
      mode: top.length > 1 ? "multicast" : "unicast",
      reason: top.some((s) => s.weak > 0) ? `no strong owner; asking the top ${top.length} candidates` : `no keyword match; asking the ${top.length} most available Baristas`,
      router: "rules",
      candidates: scored.slice(top.length).map((s) => s.c.agentId),
    };
  }
}

export type CompleteFn = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>;

/** Hands out at most `limit` slots; waiters are served in order. */
class Gate {
  private active = 0;
  private waiters: Array<() => void> = [];
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("llm timeout while waiting for a slot"));
      };
      this.waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot over without dropping the count
    else this.active--;
  }
}

const SYSTEM_PROMPT = `You are the router of "cafe", a network of AI agents.
Given an Order (a question or task) and a list of Baristas (each with a description, tags and scope), choose who should receive it. Do NOT answer the Order; you only route.
Respond with ONLY a JSON object:
{"targets": ["<agentId>", ...], "mode": "unicast" | "multicast" | "broadcast", "reason": "<one sentence>", "candidates": ["<fallback agentId>", ...]}
Policy:
- Default to unicast: exactly one Barista whose description clearly owns the work.
- Use multicast only when the Order genuinely contains separable parts and each target handles a different part (at most 3 targets).
- If no Barista clearly owns it, pick the 2-3 most plausible targets (mode multicast). Never use broadcast just because you are unsure.
- Use broadcast only when the Order explicitly says to ask everyone.
- Prefer the candidate whose scope/description is the most specific. An action word (write/update/rotate/deploy the README) can outweigh a domain word (billing).
- candidates: ordered fallbacks if the unicast target does not acknowledge.
- A "history" line is only a weak hint: use it to choose between Baristas that fit about equally well, never to skip a Barista that clearly fits better.`;

/** LLM-backed router. `complete` is injected so tests can use a fake model. */
export class LlmRouter implements Router {
  readonly name = "llm" as const;
  private complete: CompleteFn;
  private fallback: Router;
  private timeoutMs: number;
  private gate: Gate;
  /** Same question + same candidate set should get the same decision, not a re-roll of the dice. */
  private cache = new Map<string, RoutingDecision>();
  private static CACHE_LIMIT = 200;

  constructor(complete: CompleteFn, fallback: Router = new RulesRouter(), opts: { timeoutMs?: number; concurrency?: number } = {}) {
    this.complete = complete;
    this.fallback = fallback;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.gate = new Gate(opts.concurrency ?? 2);
  }

  async decide(input: RouteInput): Promise<RoutingDecision> {
    const { order, candidates, hints, broadcast } = input;
    if (broadcast) {
      // The customer explicitly asked everyone; no model call needed.
      return { targets: candidates.map((c) => c.agentId), mode: "broadcast", reason: "customer asked everyone", router: "llm", candidates: [] };
    }
    if (candidates.length === 0) return this.fallback.decide(input);
    if (candidates.length === 1) {
      return { targets: [candidates[0]!.agentId], mode: "unicast", reason: "only eligible barista (no model call)", router: "llm", candidates: [] };
    }
    const cacheKey = `${order.body}\u0000${candidates
      .map((c) => `${c.agentId}:${c.status}:${c.description}:${c.tags.join(",")}`)
      .sort()
      .join("|")}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { ...cached };
    const body = tokenize(order.body);
    const list = candidates
      .map((c) => {
        const declined = overlappingDeclines(hints?.get(c.agentId), body).slice(0, 5);
        const history = declined.length ? `\n  history (weak hint): recently declined orders about ${declined.join(", ")}` : "";
        return `- agentId: ${c.agentId}\n  address: ${c.address}\n  status: ${c.status}\n  tags: ${c.tags.join(", ")}\n  scope: ${c.scope.join(", ")}\n  description: ${c.description}${history}`;
      })
      .join("\n");
    const prompt = `Order from ${order.from.address}:\n"""\n${order.body}\n"""\n\nBaristas:\n${list}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const timeout = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener("abort", () => reject(new Error(`llm timeout after ${this.timeoutMs}ms`)), { once: true });
    });
    let release: (() => void) | undefined;
    try {
      release = await this.gate.acquire(ctrl.signal);
      const text = await Promise.race([this.complete(SYSTEM_PROMPT, prompt, ctrl.signal), timeout]);
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const valid = new Set(candidates.map((c) => c.agentId));
      const raw: string[] = Array.isArray(json.targets) ? json.targets.filter((t: unknown): t is string => typeof t === "string" && valid.has(t)) : [];
      // The model's mode is a hint, not a contract: an unrequested broadcast is
      // bounded, targets are de-duplicated, and multicast is capped at TOP_K.
      const declared = ["unicast", "multicast", "broadcast"].includes(json.mode) ? json.mode : raw.length === 1 ? "unicast" : "multicast";
      let mode: RoutingDecision["mode"] = declared === "broadcast" ? "multicast" : declared;
      const ids = raw.length ? raw : candidates.map((c) => c.agentId);
      const ordered = candidates.map((c) => c.agentId).filter((id) => ids.includes(id));
      const targets: string[] = mode === "unicast" ? [raw[0] ?? ordered[0]!] : ordered.slice(0, TOP_K);
      if (!targets.length || !targets[0]) throw new Error("llm returned no valid targets");
      if (targets.length === 1) mode = "unicast";
      const decision: RoutingDecision = {
        targets,
        mode,
        reason: String(json.reason ?? ""),
        router: "llm",
        candidates: (Array.isArray(json.candidates) ? json.candidates : []).filter((t: string) => valid.has(t) && !targets.includes(t)).slice(0, TOP_K),
      };
      this.cache.set(cacheKey, decision);
      if (this.cache.size > LlmRouter.CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      return { ...decision };
    } catch (err) {
      const message = ctrl.signal.aborted ? `llm timeout after ${this.timeoutMs}ms` : (err as Error).message;
      const d = await this.fallback.decide(input);
      return { ...d, reason: `${d.reason} (llm failed: ${message})`, llmError: message };
    } finally {
      clearTimeout(timer);
      release?.();
    }
  }
}

/**
 * Build a CompleteFn on top of the pi SDK (reuses pi's auth.json).
 * `model` is `provider/modelId`, e.g. `anthropic/claude-haiku-4-5`.
 */
export async function piComplete(model: string): Promise<CompleteFn> {
  const [provider, ...rest] = model.split("/");
  const modelId = rest.join("/");
  const pi: any = await import("@earendil-works/pi-coding-agent" as string);
  const runtime = await pi.ModelRuntime.create();
  const m = runtime.getModel(provider, modelId);
  if (!m) throw new Error(`unknown model ${model}`);
  // The loader (skills/context scanning) is the expensive part; keep it for every Order.
  const loader = new pi.DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: pi.getAgentDir(),
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
  });
  await loader.reload();
  return async (_system, prompt, signal) => {
    const { session } = await pi.createAgentSession({
      model: m,
      modelRuntime: runtime,
      thinkingLevel: "off",
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(),
      noTools: "all",
    });
    const onAbort = () => void session.abort().catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    const aborted = new Promise<never>((_, reject) => {
      if (signal?.aborted) reject(new Error("aborted"));
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    try {
      await Promise.race([session.prompt(prompt), aborted]);
      return session.getLastAssistantText() ?? "";
    } finally {
      signal?.removeEventListener("abort", onAbort);
      session.dispose();
    }
  };
}

/** Every `provider/model` the pi runtime knows, for `cafe router models`. */
export async function listRouterModels(search?: string): Promise<string[]> {
  const pi: any = await import("@earendil-works/pi-coding-agent" as string);
  const runtime = await pi.ModelRuntime.create();
  const q = search?.toLowerCase();
  return runtime
    .getModels()
    .map((m: any) => `${m.provider}/${m.id}`)
    .filter((id: string) => !q || id.toLowerCase().includes(q))
    .sort();
}
