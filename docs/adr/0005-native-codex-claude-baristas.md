# Codex / Claude Code 当 Barista：桥接进程、只读默认、会话映射存在 Daemon

Codex 和 Claude Code 没有 pi 那样的扩展接口，cafe 用一个**桥接进程**（`cafe barista run --agent codex|claude`）替它们注册身份、接收 Order、回答。桥接进程和 headless pi 一样由 supervisor 托管（`cafe barista start --agent codex|claude`），每个 concurrency 槽一个进程，记在 `baristas.json`（Q78）。

- **Codex**：每个桥接进程常驻一个 `codex app-server`（stdio JSON-RPC），一个 cafe Thread 对应一个 Codex thread；取消用 `turn/interrupt`（Q73）。
- **Claude Code**：每个问题起一个 `claude -p --output-format json`；第一问用 `--session-id <uuid>` 定下会话 id，追问用 `--resume`；取消发 SIGINT（Q74 A）。

## 决定

1. **默认只读，永远不给全权限**（Q75）。Codex：`sandbox: read-only` + `approvalPolicy: never`，服务端发来的任何审批或提问一律拒绝。Claude：`--permission-mode dontAsk`，只提供并预先允许 Read / Grep / Glob。`--write` 放开到可写工作区（Codex `workspace-write`；Claude 加 Edit / Write，仍然没有 Bash）。
2. **Claude 沿用本机登录，只读用户级设置**（Q76）：`--setting-sources user`，不执行项目的 hooks 和 `.mcp.json`。设置了 `ANTHROPIC_API_KEY` 时改用 `--bare`。分发给别人或团队使用时应要求 API key（Anthropic 政策）。
3. **cafe Thread → 外部会话 id 的映射存在本机 Daemon 的 SQLite**（`agent_sessions`，键是 agent 类型 + Barista 目录 + Thread），桥接进程通过 `agent/session/get|set` 读写（Q79）。键里没有 agentId，所以同一目录的任何槽、重启后的新进程都能接上。会话找不到时（被删、换了机器）新开一个，并带上 Thread 的历史；只在明确是"找不到会话"的错误时重试，不会为真正的失败付两次钱。
4. 一个桥接进程同时只跑一个 turn，后来的 Order 排队；Order 一到就开始处理（不恢复 `accept: confirm`）。
5. `cafe prune` 删 Thread 时一并删掉映射；Codex / Claude 自己的会话记录不动。

## Consequences

- Barista 列表只显示"后台运行"，看不出是 pi、Codex 还是 Claude；要区分需要改 UI（先出原型）。
- Codex 的 app-server 协议有实验字段，升级 Codex 后先跑一次 mock 模型检查（见 `docs/specs/v3-1-native-codex-claude.md`）。
- 第二阶段（TUI 会话当 Barista：Codex `thread/queue/add`，Claude channels）没做。
