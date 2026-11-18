# v2-1 路由参考历史（Routing Hints）

状态：已确认并实现（2026-11-19，Q42–Q50）

## 原则

- 路由**主要**依据 Barista 的 description / tags / scope。历史只是辅助信号，用来在"描述上打平"的候选之间排先后，**永远不会**把一个 Barista 排除，也不会让一个描述明显更匹配的 Barista 落选。
- 婉拒多不代表以后不重要：信号按时间衰减（半衰期 2 天，窗口 7 天），且只在"话题相似"时才生效。
- 资源消耗要可忽略：无 LLM、无 embedding、无额外网络往返。

## 数据

`agent_events` 增加两列：

| 列 | 说明 |
|---|---|
| `identity` | `name@host`（Address 去掉 `#n`），Barista 重启换 agentId 后历史仍连续 |
| `tokens` | 该 Order 正文的关键词，最多 12 个、空格分隔（复用 RulesRouter 的分词） |

旧行迁移：`identity` 从当前 Registry 补齐，补不上则保留 agentId；`tokens` 为空（不参与话题匹配，只计入总数）。

## Hints

每个 identity 一份摘要：

```ts
interface RoutingHint {
  identity: string;            // name@host
  answered: number; declined: number; failed: number;   // 7 天内原始计数（展示用）
  declinedTopics: Record<string, number>; // 关键词 → 衰减后权重，最多保留 20 个
}
```

- 计算：Root 上每 30 s（有新事件才算）对 7 天内事件做一次 `GROUP BY`，O(事件数)，单次 SQL。
- 复制：Root 用一条不带版本号的通知 `hints/update` 推给子 Daemon（不进 Registry 版本，避免每次回答都 bump 版本）；子 Daemon 连上时拉一次全量。
- Root 离线：子 Daemon 用自己本地的 `agent_events` 算。

## 用法

- **RulesRouter**：`penalty = min(0.9, Σ 与本 Order 重合关键词的衰减权重 × 0.3)`。只用于排序，不参与"score ≥ 1 才单播"的阈值判断。因为一个描述关键词就是 +1，惩罚上限 0.9 保证历史不会盖过描述匹配。
- **LlmRouter**：候选列表里有相似话题婉拒记录的 Barista 附一行 `history (weak hint): recently declined orders about <重合关键词>`；system prompt 增加一句"description 是主要依据，history 仅在难以区分时参考"。
- 开关：`router.learn: true`（默认），`false` 时完全不读 hints。
- `reason` 里注明是否用到历史，例如 `keyword match (score 3) on b#1@h; history: a#1@h declined similar orders`。

## 展示

- CLI：新增 `cafe stats`，按 identity 列出 7 天内回答 / 婉拒 / 失败次数和"婉拒较多的话题"；HTTP `GET /api/routing/hints`。
- Web UI：Barista 卡片显示"最近 7 天回答 12 次，婉拒 2 次"；话题与命中率放在折叠的"调试信息"。**先做原型确认。**

## 实现中补充的两点

- **运行层面的婉拒不算话题**：`decline(reason, { unavailable: true })` 表示超时没接、被中止、会话关闭、命令执行失败等，只计入婉拒次数，不记关键词。pi 插件看门狗、中止、关闭，以及 `cafe serve` 的命令失败都已标上。Barista 主动说"不归我管"的仍按话题记。
- **中文分词**：原来的分词把一整句中文当成一个词，规则路由对中文描述几乎匹配不上。现在 CJK 连续文字拆成相邻二字词（"数据库" → 数据、据库），tag 要求全部二字词都出现才算命中。这一改动同时改善了规则路由本身。

## 评估

`tests/routing-eval.test.ts`：固定 6 个左右的 Barista、约 20 条问题和期望接单方，先回放一批带婉拒的历史，再比较规则路由加上 hints 前后的命中率。断言：命中率不下降，且描述明确匹配的问题结果不变。只跑规则路由。

## 不做

- 不做 embedding / LLM 话题判断。
- 不根据"回答过"加分（避免强者愈强），只用婉拒做减分。
