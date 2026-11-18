# Root 离线时 Daemon 之间直连（ADR-0001 的补充）

Root 在线时仍按 ADR-0001：所有 Order 经 Root 中转，Root 的 web UI 是全网唯一完整视图。Root 离线时，发起方 Daemon 不再立即对跨 Host 的 Order 返回 `root_unreachable`，而是按需直连目标 Daemon 投递；Root 恢复后，发起方把离线期间直连的 Thread 补发给 Root。

目的只有一个：Root 掉线时跨机器的问题还能被回答（Q54 a）。延迟和 Root 负载不是动机，所以 Root 在线时不走直连（Q55 a）。

## 做法

- **地址**：Root 把 Daemon 列表（含各自 `url`）随 `daemons/changed` 推给每个子 Daemon，子 Daemon 存进 SQLite `kv.peerUrls`，重启后仍可用。
- **连接**：按需建立（`initialize` 的 `kind: "peer"`，用共享 token），3 s 连不上即按 `root_unreachable` 失败；出向连接闲置 5 min 关闭。不维持全连接网。
- **事件**：直连上的 Thread 事件双向转发（`thread/event`），各 Daemon 按 eventId 去重，和经 Root 时一样各写一份 JSONL。
- **Registry**：Root 离线时不同步。子 Daemon 失去 Root 时，只把**没有直连地址**的 Host 上的 Agent 标为离线；其余保留最后状态。目标 Agent 实际已不在时，对方 Daemon 回 `order.failed`，按现有逻辑换候选或结束（Q58）。Root 正常关机时也不再把各子 Daemon 的 Agent 广播为离线。
- **补发**：发起方记下离线期间直连过的 Thread（`kv.backfill`），重连 Root 后用 `thread/backfill` 发送这些 Thread 的完整事件；Root 跳过文件中已有的 eventId，因此重复补发无害（Q56）。

## Consequences

- Root 离线期间的消息，Root 的 web UI 要等它恢复、子 Daemon 重连后才看得到。
- Root 离线期间新加入或离开的 Agent，其他 Host 看不到；Root 恢复后由 Registry 快照纠正。
- 两个子 Daemon 必须能直接互通（同一局域网或 tailnet），否则行为与之前相同。
