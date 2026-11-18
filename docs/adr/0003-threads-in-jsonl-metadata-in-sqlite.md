# Thread 内容存 JSONL 文件，SQLite 只存元数据

每个 Thread 的完整事件（Order、Routing Decision、ack、心跳、Reply、decline、取消）以追加方式写入 `~/.cafe/sessions/<YYYY-MM-DD>/<threadId>.jsonl`，经过的每个 Daemon 各写一份；SQLite 只存 Registry 缓存与 Thread 元数据（参与方、状态、时间戳、文件路径、摘要）。做法与 oh-my-pi / codex 的会话存储一致：消息正文便于人和 agent 直接 grep/阅读、追加写对崩溃友好，而列表查询仍走索引。

## Consequences

- 同一 Thread 在多个 Daemon 上各有一份副本，不保证彼此完全一致；以各自观察到的事件为准。
- 全文检索需要扫描文件，v1 不提供。
