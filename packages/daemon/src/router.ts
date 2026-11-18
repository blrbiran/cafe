import type { AgentRecord, Order, RoutingDecision } from "@cafe/protocol";

export interface RouteInput {
  order: Order;
  /** Baristas eligible for this Order (already excludes the Customer and the call chain). */
  candidates: AgentRecord[];
}

export interface Router {
  readonly name: RoutingDecision["router"];
  decide(input: RouteInput): Promise<RoutingDecision>;
}

const WORD = /[\p{L}\p{N}_-]+/gu;

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(WORD) ?? []).filter((t) => t.length > 1));
}

/**
 * Deterministic fallback: keyword overlap between the Order body and each
 * Barista's name/tags/description/scope. No match → broadcast.
 */
export class RulesRouter implements Router {
  readonly name = "rules" as const;

  async decide({ order, candidates }: RouteInput): Promise<RoutingDecision> {
    if (candidates.length === 0) return { targets: [], mode: "broadcast", reason: "no eligible baristas", router: "rules", candidates: [] };
    const body = tokens(order.body);
    const scored = candidates
      .map((c) => {
        let score = 0;
        if (body.has(c.name.toLowerCase())) score += 5;
        for (const t of c.tags) if (body.has(t.toLowerCase())) score += 3;
        for (const t of tokens(`${c.description} ${c.scope.join(" ")}`)) if (body.has(t)) score += 1;
        if (c.status === "idle") score += 0.5;
        return { c, score };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0]!;
    if (best.score >= 1) {
      return {
        targets: [best.c.agentId],
        mode: "unicast",
        reason: `keyword match (score ${best.score}) on ${best.c.address}`,
        router: "rules",
        candidates: scored.slice(1).filter((s) => s.score >= 1).map((s) => s.c.agentId),
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
- candidates: ordered fallbacks if the unicast target does not acknowledge.`;

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
    const { order, candidates } = input;
    if (candidates.length === 0) return this.fallback.decide(input);
    const list = candidates
      .map((c) => `- agentId: ${c.agentId}\n  address: ${c.address}\n  status: ${c.status}\n  tags: ${c.tags.join(", ")}\n  scope: ${c.scope.join(", ")}\n  description: ${c.description}`)
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
