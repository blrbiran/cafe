import type { RoutingHint } from "@cafe/protocol";

/**
 * Routing hints: a cheap, auxiliary signal from past outcomes (docs/specs/v2-1-routing-hints.md).
 * Descriptions stay the primary routing input; hints only reorder Baristas that tie on them.
 */

export const HINT_WINDOW_MS = 7 * 24 * 3600_000;
export const HINT_HALF_LIFE_MS = 2 * 24 * 3600_000;
const MAX_ORDER_TOKENS = 12;
const MAX_TOPICS = 20;
const PENALTY_PER_WEIGHT = 0.3;
/** < 1, the value of a single description keyword hit, so history never outweighs a description match. */
export const MAX_PENALTY = 0.9;

const WORD = /[\p{L}\p{N}_-]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * A conservative English plural stem: `ledgers` → `ledger`, `policies` →
 * `policy`, `boxes` → `box`. Both the Order and the Barista text go through
 * the same function, so a singular tag matches a plural question (#39).
 */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (/(?:ch|sh|x|z|s)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is") && !w.endsWith("ws")) return w.slice(0, -1);
  return w;
}

/**
 * Lower-cased word tokens (length > 1). CJK text has no spaces, so CJK runs are
 * split into overlapping bigrams; other scripts split on non-word characters.
 */
export function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(WORD) ?? []) {
    if (!CJK.test(w)) {
      const t = stem(w);
      if (t.length > 1) out.add(t);
      continue;
    }
    for (const part of w.split(CJK_RUN)) if (part.length > 1) out.add(part);
    for (const run of w.match(CJK_RUN) ?? []) {
      if (run.length < 2) continue;
      for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
    }
  }
  return out;
}

/** The keywords stored with an outcome: at most 12, longest first (longer words are more specific). */
export function orderKeywords(body: string): string[] {
  return [...tokenize(body)].sort((a, b) => b.length - a.length).slice(0, MAX_ORDER_TOKENS);
}

/** `name@host`: an Agent's identity across restarts (its Address without `#n`). */
export function identityOf(rec: { name: string; host: string }): string {
  return `${rec.name}@${rec.host}`;
}

export interface OutcomeRow {
  identity: string;
  kind: "answered" | "declined" | "failed";
  at: number;
  tokens: string[];
}

/**
 * Build hints from pre-counted outcomes (#68). `Store.outcomeSummary()` does the grouping in SQL, so
 * this only has to weight the recent decline topics; it no longer walks every row of the last week.
 */
export function hintsFromSummary(
  rows: { identity: string; answered: number; declined: number; failed: number; declinedTopics?: string[]; declinedAt?: number }[],
  now = Date.now(),
): Record<string, RoutingHint> {
  const out: Record<string, RoutingHint> = {};
  for (const r of rows) {
    const h: RoutingHint = (out[r.identity] ??= { identity: r.identity, answered: 0, declined: 0, failed: 0, declinedTopics: {} });
    h.answered += r.answered;
    h.declined += r.declined;
    h.failed += r.failed;
    if (r.declinedAt === undefined || now - r.declinedAt > HINT_WINDOW_MS) continue;
    const w = Math.pow(0.5, Math.max(0, now - r.declinedAt) / HINT_HALF_LIFE_MS);
    for (const t of r.declinedTopics ?? []) h.declinedTopics[t] = (h.declinedTopics[t] ?? 0) + w;
  }
  for (const h of Object.values(out)) {
    const top = Object.entries(h.declinedTopics).sort((a, b) => b[1] - a[1]).slice(0, MAX_TOPICS);
    h.declinedTopics = Object.fromEntries(top.map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  }
  return out;
}

export function computeHints(rows: OutcomeRow[], now = Date.now()): Record<string, RoutingHint> {
  const out: Record<string, RoutingHint> = {};
  for (const r of rows) {
    if (now - r.at > HINT_WINDOW_MS) continue;
    const h = (out[r.identity] ??= { identity: r.identity, answered: 0, declined: 0, failed: 0, declinedTopics: {} });
    h[r.kind] += 1;
    if (r.kind !== "declined") continue;
    const w = Math.pow(0.5, Math.max(0, now - r.at) / HINT_HALF_LIFE_MS);
    for (const t of r.tokens) h.declinedTopics[t] = (h.declinedTopics[t] ?? 0) + w;
  }
  for (const h of Object.values(out)) {
    const top = Object.entries(h.declinedTopics).sort((a, b) => b[1] - a[1]).slice(0, MAX_TOPICS);
    h.declinedTopics = Object.fromEntries(top.map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  }
  return out;
}

/** Topics this Barista declined recently that overlap the Order, strongest first. */
export function overlappingDeclines(hint: RoutingHint | undefined, orderTokens: Set<string>): string[] {
  if (!hint) return [];
  return Object.entries(hint.declinedTopics)
    .filter(([t]) => orderTokens.has(t))
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}

export function historyPenalty(hint: RoutingHint | undefined, orderTokens: Set<string>): number {
  if (!hint) return 0;
  let sum = 0;
  for (const t of overlappingDeclines(hint, orderTokens)) sum += hint.declinedTopics[t]!;
  return Math.min(MAX_PENALTY, sum * PENALTY_PER_WEIGHT);
}
