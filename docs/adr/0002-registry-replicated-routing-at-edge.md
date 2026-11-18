# Registry 由 Root 复制到每个 Daemon，路由在发起方 Daemon 完成

Root Daemon 维护全网 Registry，以「全量快照 + 带版本号的增量」复制到每个 Daemon（类似二级 DNS / 缓存解析器）。配置了路由 LLM 的 Daemon 用本地副本自行做 Routing Decision；未配置的 Daemon 把路由请求交给 Root。这样路由能力分散到边缘，Root 离线时本机路由仍可用，且 Root 不必承担所有 LLM 调用。

## Considered Options

- 逐级上送（本地找不到再交 Root 决策）：Root 成为 LLM 瓶颈，且 Root 离线时子 Daemon 只能看到本机 Barista。
- 仅 Root 持有 Registry：同上，且子 Daemon 的 web UI 无法展示全网注册情况。
