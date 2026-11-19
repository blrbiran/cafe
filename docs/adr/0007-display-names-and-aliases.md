# 展示名与别名：内部 id 永不改变

v3-3（Q90 B，2026-11-19）。dogfooding 反馈（issue #10）要求能在 Web/CLI 给 Host 和 Agent 改名，并且旧历史、旧地址不能变成孤儿。

## 决定

1. **内部标识保持稳定。** `host`（Host 的稳定键）、Agent 的 `name`、`agentId` 和 `Address`（`name#n@host`）都不因改名而改变。`DaemonRecord.hostId` 等于 `host`，两者是同一个稳定值；旧 Daemon 没有该字段时按 `host` 处理。改名只改展示层。
2. **新增展示字段。** `DaemonRecord` / `AgentRecord` 增加 `displayName`（默认分别是 `host` / `name`）和 `aliases[]`（旧名字、旧展示名）。协议字段都是可选的，旧 Daemon/客户端忽略它们即可。
3. **改名是热更新。** `POST /api/host`（本机 `displayName` / `aliases`）、`POST /api/hosts/rename`（Root 改其他 Daemon）、`POST /api/agents/rename`（改本地或经 Root 转发给所属 Daemon 的 Agent）。CLI：`cafe host rename|alias`、`cafe agent rename|alias`、`cafe daemon rename <host> <name>`。
4. **远程改名由 Root 协调。** Root 保存 `hostNames` 覆盖（离线 Daemon 也能先改名），在线时通过 `host/identity` 通知更新目标 Daemon 的本地视图；Agent 改名通过 `agent/rename` 由 Root 转发给所属 Daemon。
5. **旧名字继续可用。** 改 Host 时把旧 `displayName`/`host` 写入 `aliases`；改 Agent 时把旧 `displayName`/`name` 写入 `aliases`。`Registry.resolve` 和显式地址解析都接受 `displayName`/`aliases`，所以旧脚本、旧提问里的地址仍然能路由。
6. **历史不迁移。** Thread/JSONL/统计里保存的仍是稳定 id 或当时的显示名；展示时按 `agentId` 映射到当前 `displayName`。因为路由键从未改变，不需要数据迁移，也不会产生孤儿记录。

## Consequences

- 改名不会改变 Address，因此 routing hints、Thread、`from.host`、`knownDaemons` 的键都保持有效。
- Root 上的 `hostNames` 是唯一需要跨重启保留的展示覆盖；child 重连时以它为准。
- Web UI 只负责显示 `displayName`/`aliases`；改名按钮等交互按项目规则先出原型再实现。
- 如果将来要把 `host` 本身换成不含语义的 ULID，需要另开 ADR 并迁移 Address；本轮刻意不做。
