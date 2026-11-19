import type { AgentRecord, Order } from "@cafe/protocol";

/**
 * Shared routing-eval fixtures: a fixed Barista set and labelled Orders.
 * Used by `tests/routing-eval.test.ts` (rules, no cost) and by
 * `scripts/router-eval.ts` (rules by default, `--model` for a real LLM sample).
 */

export interface FixtureBarista {
  name: string;
  tags: string[];
  description: string;
}

export const FIXTURE_BARISTAS: FixtureBarista[] = [
  { name: "mobile", tags: ["ios", "android", "安卓", "react native", "deep link"], description: "mobile app: iOS and Android screens, React Native, push notifications" },
  { name: "web", tags: ["frontend", "css", "next.js", "hydration", "responsive", "accessibility"], description: "web frontend: React hooks, pages, CSS, accessibility" },
  { name: "billing", tags: ["invoice", "payment", "refund", "退款", "subscription", "proration", "vat", "webhook", "currency"], description: "billing service: invoices, refunds, VAT, payment provider webhooks" },
  { name: "search", tags: ["elasticsearch", "ranking", "relevance"], description: "search indexing, ranking and relevance" },
  { name: "db", tags: ["数据库", "sql", "postgres", "index", "table", "schema", "migration"], description: "database schema, migrations and postgres queries" },
  { name: "infra", tags: ["deploy", "部署", "k8s", "kubernetes", "docker", "ci", "pipeline", "terraform", "helm", "alerting"], description: "deployment, Kubernetes, Docker, CI pipelines, Terraform" },
  { name: "docs", tags: ["documentation", "文档", "guide", "docs"], description: "developer documentation and API reference" },
  { name: "security", tags: ["auth", "oauth", "权限", "secrets", "session", "token"], description: "authentication, OAuth, access control and secrets" },
];

export interface EvalCase {
  q: string;
  /** Barista names expected to receive the Order. */
  expect: string[];
  mode?: "unicast" | "multicast" | "broadcast";
  /** Clear by description alone; history must not move it. */
  clear?: boolean;
}

export const EVAL_CASES: EvalCase[] = [
  // billing
  { q: "the invoice total is wrong after a refund", expect: ["billing"], clear: true },
  { q: "payment gateway returns 502", expect: ["billing"], clear: true },
  { q: "payment provider webhook is not arriving", expect: ["billing"], clear: true },
  { q: "VAT number is missing on the invoice", expect: ["billing"], clear: true },
  { q: "refunds are not showing on invoices", expect: ["billing"], clear: true },
  { q: "the customer was charged twice for one invoice", expect: ["billing"], clear: true },
  { q: "subscription proration 算错了", expect: ["billing"], clear: true },
  { q: "退款失败，支付网关返回 502", expect: ["billing"], clear: true },
  { q: "currency conversion on invoices looks wrong", expect: ["billing"], clear: true },
  // search
  { q: "elasticsearch ranking looks off", expect: ["search"], clear: true },
  { q: "reindex the elasticsearch cluster", expect: ["search"], clear: true },
  { q: "search relevance for product queries", expect: ["search"], clear: true },
  { q: "query returns stale documents after indexing", expect: ["search"], clear: true },
  { q: "search suggestions are empty", expect: ["search"], clear: true },
  // db
  { q: "this postgres query is slow", expect: ["db"], clear: true },
  { q: "数据库迁移失败了", expect: ["db"], clear: true },
  { q: "add an index for the users table", expect: ["db"], clear: true },
  { q: "schema change for orders", expect: ["db"], clear: true },
  { q: "sql 查询超时", expect: ["db"], clear: true },
  { q: "backup restore failed for postgres", expect: ["db"], clear: true },
  { q: "vacuum the postgres database", expect: ["db"], clear: true },
  // infra
  { q: "deploy to staging is stuck", expect: ["infra"], clear: true },
  { q: "k8s pod keeps restarting", expect: ["infra"], clear: true },
  { q: "docker build fails in ci", expect: ["infra"], clear: true },
  { q: "terraform plan wants to recreate the cluster", expect: ["infra"], clear: true },
  { q: "部署到生产环境失败了", expect: ["infra"], clear: true },
  { q: "ci pipeline cannot push the image", expect: ["infra"], clear: true },
  { q: "helm chart upgrade fails", expect: ["infra"], clear: true },
  { q: "alerting rules are too noisy", expect: ["infra"], clear: true },
  // mobile
  { q: "ios build crashes on launch", expect: ["mobile"], clear: true },
  { q: "android screens render blank", expect: ["mobile"], clear: true },
  { q: "react native push notification is not received", expect: ["mobile"], clear: true },
  { q: "app store review rejected the build", expect: ["mobile"], clear: true },
  { q: "安卓启动崩溃", expect: ["mobile"], clear: true },
  { q: "deep link opens the wrong screen", expect: ["mobile"], clear: true },
  // web
  { q: "frontend css of the pricing pages", expect: ["web"], clear: true },
  { q: "css grid on the landing pages", expect: ["web"], clear: true },
  { q: "next.js page hydration error", expect: ["web"], clear: true },
  { q: "accessibility labels on the signup form", expect: ["web"], clear: true },
  { q: "responsive layout breaks on tablet", expect: ["web"], clear: true },
  // docs
  { q: "update the API reference docs", expect: ["docs"], clear: true },
  { q: "文档里的示例过期了", expect: ["docs"], clear: true },
  { q: "write docs for the new endpoint", expect: ["docs"], clear: true },
  // security
  { q: "oauth login redirects to the wrong host", expect: ["security"], clear: true },
  { q: "rotate the service secrets", expect: ["security"], clear: true },
  { q: "权限控制有问题，普通用户能看管理员页面", expect: ["security"], clear: true },
  { q: "session tokens expire too early", expect: ["security"], clear: true },
  // ambiguous: both web and mobile talk about React hooks; history decides
  { q: "react hooks rerender loop", expect: ["web"] },
  { q: "custom react hooks for forms", expect: ["web"] },
  { q: "which react hooks should we use for data fetching", expect: ["web"] },
  // nothing fits: broadcast to everyone
  { q: "what is the meaning of life", expect: FIXTURE_BARISTAS.map((b) => b.name), mode: "broadcast" },
  { q: "帮我随便看看", expect: FIXTURE_BARISTAS.map((b) => b.name), mode: "broadcast" },
  { q: "hello", expect: FIXTURE_BARISTAS.map((b) => b.name), mode: "broadcast" },
];

export function agentRecords(host = "eval"): AgentRecord[] {
  return FIXTURE_BARISTAS.map((b, i) => ({
    agentId: `id-${b.name}`,
    address: `${b.name}#1@${host}`,
    host,
    name: b.name,
    tags: b.tags,
    description: b.description,
    scope: [],
    role: "barista",
    concurrency: 1,
    mode: "headless",
    cwd: `/srv/${b.name}`,
    status: i % 2 === 0 ? "idle" : "busy",
    registeredAt: 0,
    lastSeenAt: 0,
    aliases: [],
  })) as AgentRecord[];
}

export function evalOrder(body: string, from = "eval@eval"): Order {
  return {
    orderId: "o",
    threadId: "t",
    kind: "order",
    body,
    from: { id: "eval", address: from, host: "eval" },
    chain: [],
    depth: 0,
    createdAt: 0,
    turn: 1,
    history: [],
  } as Order;
}