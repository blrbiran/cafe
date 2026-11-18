# v2-5 数据清理与搜索

状态：已实现，默认值经用户同意（2026-11-19）。

## 清理

用户的硬性规则是"删除用户数据前必须确认"，所以：

- **默认不自动删除任何东西。** `retention.days` 不设就永不自动清理；设了才每天（启动 1 分钟后开始）删除早于该天数的数据。
- `cafe prune --older-than <days>` 默认只报告会删什么（多少个会话、多少 KiB、最早日期、多少条统计行），加 `--yes` 才删除。API：`POST /api/prune {olderThanDays, dryRun}`，`dryRun` 不传即为 true。
- 只删**已结束**（done / failed / cancelled）且最后活动早于截止时间的会话；正在进行的会话不动。删除的是 SQLite 行和对应的 JSONL 文件，并删除空的日期目录。只删除 `~/.cafe/sessions/` 下的文件，元数据里的路径如果指向别处会被忽略。
- `agent_events`（路由历史统计）按同一截止时间删除。

## 搜索

- `cafe search <文字>`：在问题和回答里做不区分大小写的子串搜索，按会话从新到旧，最多 20 个会话、每个显示 3 处命中。API：`GET /api/search?q=&limit=`。
- 实现是逐个扫描 JSONL 文件（ADR-0003 说明过 v1 不做索引），会话很多时会慢，再配合清理使用。以后需要再加 SQLite FTS。

## 顺带

- `GET /api/threads?before=<createdAt>` 支持往更早的会话翻页（web 的"加载更早"还没做，需先出原型）。
