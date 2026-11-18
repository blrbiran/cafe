import type { AgentRecord, Order, RoutingDecision, RoutingHint } from "@cafe/protocol";
import { historyPenalty, overlappingDeclines, tokenize } from "./hints.ts";

export interface RouteInput {
  order: Order;
  /** Baristas eligible for this Order (already excludes the Customer and the call chain). */
  candidates: AgentRecord[];
  /** Recent outcomes by agentId (auxiliary; absent when `router.learn` is off or there is no history). */
  hints?: Map<string, RoutingHint>;
}

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
 * Deterministic fallback: keyword overlap between the Order body and each
 * Barista's name/tags/description/scope. No match → broadcast.
 *
 * Ranking is (description score, then idle bonus minus history penalty). The
 * penalty is < 1, so history only reorders Baristas that tie on the description.
 */
export class RulesRouter implements Router {
  readonly name = "rules" as const;

  async decide({ order, candidates, hints }: RouteInput): Promise<RoutingDecision> {
    if (candidates.length === 0) return { targets: [], mode: "broadcast", reason: "no eligible baristas", router: "rules", candidates: [] };
    const body = tokenize(order.body);
    const scored = candidates
      .map((c) => {
        let score = 0;
        if (mentions(body, c.name)) score += 5;
        for (const t of c.tags) if (mentions(body, t)) score += 3;
        for (const t of tokenize(`${c.description} ${c.scope.join(" ")}`)) if (body.has(t)) score += 1;
        const penalty = historyPenalty(hints?.get(c.agentId), body);
        const tiebreak = (c.status === "idle" ? 0.5 : 0) - penalty;
        return { c, score, penalty, tiebreak };
      })
      .sort((a, b) => b.score - a.score || b.tiebreak - a.tiebreak);
    const matched = scored.filter((s) => s.score >= 1);
    const best = matched[0];
    if (best) {
      const demoted = matched.filter((s) => s.penalty > 0);
      const history = demoted.length
        ? `; history: ${demoted.map((s) => `${s.c.address} declined similar orders`).join(", ")}`
        : "";
      return {
        targets: [best.c.agentId],
        mode: "unicast",
        reason: `keyword match (score ${best.score}) on ${best.c.address}${history}`,
        router: "rules",
        candidates: matched.slice(1).map((s) => s.c.agentId),
      };
    }
    return { targets: candidates.map((c) => c.agentId), mode: "broadcast", reason: "no barista matched; broadcasting", router: "rules", candidates: [] };
  }
}

export type CompleteFn = (system: string, prompt: string) => Promise<string>;

const SYSTEM_PROMPT = `You are the router of "cafe", a network of AI agents.
Given an Order (a question or task) and a list of Baristas (agents that can answer, each with a description and scope),
choose who should receive it. Do NOT answer the Order yourself; you only route.
Respond with ONLY a JSON object:
{"targets": ["<agentId>", ...], "mode": "unicast" | "multicast" | "broadcast", "reason": "<one sentence>", "candidates": ["<fallback agentId>", ...]}
- unicast: exactly one clearly responsible Barista.
- multicast: a few Baristas each own part of the answer.
- broadcast: you cannot tell; targets = all Baristas.
- candidates: ordered fallbacks if the unicast target does not acknowledge.
Decide mainly from each Barista's description, tags and scope. A "history" line, when present, is only a weak hint:
use it to choose between Baristas that fit about equally well, never to skip a Barista that clearly fits better.`;

/** LLM-backed router. `complete` is injected so tests can use a fake model. */
export class LlmRouter implements Router {
  readonly name = "llm" as const;
  private complete: CompleteFn;
  private fallback: Router;

  constructor(complete: CompleteFn, fallback: Router = new RulesRouter()) {
    this.complete = complete;
    this.fallback = fallback;
  }

  async decide(input: RouteInput): Promise<RoutingDecision> {
    const { order, candidates, hints } = input;
    if (candidates.length === 0) return this.fallback.decide(input);
    const body = tokenize(order.body);
    const list = candidates
      .map((c) => {
        const declined = overlappingDeclines(hints?.get(c.agentId), body).slice(0, 5);
        const history = declined.length ? `\n  history (weak hint): recently declined orders about ${declined.join(", ")}` : "";
        return `- agentId: ${c.agentId}\n  address: ${c.address}\n  status: ${c.status}\n  tags: ${c.tags.join(", ")}\n  scope: ${c.scope.join(", ")}\n  description: ${c.description}${history}`;
      })
      .join("\n");
    const prompt = `Order from ${order.from.address}:\n"""\n${order.body}\n"""\n\nBaristas:\n${list}`;
    try {
      const text = await this.complete(SYSTEM_PROMPT, prompt);
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const valid = new Set(candidates.map((c) => c.agentId));
      const targets: string[] = (json.targets ?? []).filter((t: string) => valid.has(t));
      if (targets.length === 0) throw new Error("llm returned no valid targets");
      const mode = ["unicast", "multicast", "broadcast"].includes(json.mode) ? json.mode : targets.length === 1 ? "unicast" : "multicast";
      return {
        targets: mode === "unicast" ? targets.slice(0, 1) : targets,
        mode,
        reason: String(json.reason ?? ""),
        router: "llm",
        candidates: (json.candidates ?? []).filter((t: string) => valid.has(t) && !targets.includes(t)),
      };
    } catch (err) {
      const d = await this.fallback.decide(input);
      return { ...d, reason: `${d.reason} (llm failed: ${(err as Error).message})` };
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
  return async (system, prompt) => {
    const loader = new pi.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: pi.getAgentDir(),
      systemPromptOverride: () => system,
      appendSystemPromptOverride: () => [],
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { session } = await pi.createAgentSession({
      model: m,
      modelRuntime: runtime,
      thinkingLevel: "off",
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(),
      noTools: "all",
    });
    try {
      await session.prompt(prompt);
      return session.getLastAssistantText() ?? "";
    } finally {
      session.dispose();
    }
  };
}
