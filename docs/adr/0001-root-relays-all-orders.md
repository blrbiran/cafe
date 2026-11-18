# Root Daemon 中转所有 Order（星型拓扑）

当 Root Daemon 在线时，所有 Order——包括同一 Host 内的——都经 Root Daemon 投递，Daemon 之间不直连。目的是让 Root Daemon 的 web UI 成为全网消息的唯一完整视图，并简化跨网络可达性（各 Daemon 只需与 Root 互通）。路由决策仍由发起方所在 Daemon 做出（见 ADR-0002），Root 只按已确定的目标透传或广播，不再二次路由。

## Consequences

- Root 离线时退化为：同 Host 内的 Order 由本地 Daemon 直接投递；跨 Host 的 Order ~~立即返回 `root_unreachable`~~ 改为直连目标 Daemon，见 [ADR-0004](0004-direct-links-when-root-offline.md)。
- 同 Host 消息在 Root 在线时也多一跳延迟，这是为可观测性付出的代价。
- Daemon 间直连只作为 Root 离线时的后备（ADR-0004）；Root 在线时仍全部经 Root。
