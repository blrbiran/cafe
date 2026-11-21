# v4-3 Customer connector SDK

状态（2026-11-19）：spec 草案，来源 dogfooding #28。**只写 spec，不实现。** 待用户确认 Q1–Q4 后进入实现。

## 为什么

cafe 已经能通过 HTTP、SSE、WebSocket、MCP 和 `cafe` CLI 接入 Customer，但没有一个“把 Discord / Slack / 钉钉 / 飞书接进来”的通用契约。每接一个平台，都要重新决定：进程怎么起、配置放哪、权限是什么、平台消息怎么映射到 Thread、重复投递怎么去重、daemon 重启后怎么恢复。结果是每个 connector 都各写一套，用户也无从知道它是否健康。

目标不是把聊天 SDK 塞进 daemon，而是定义一个**进程外 connector**：独立进程订阅平台事件，调用 cafe 的 HTTP/WS API 发 Order，再把回复发回原 channel/thread。

## 目标与非目标

目标：

- 一个稳定的 connector manifest + 生命周期（install / start / stop / logs / remove / status）。
- connector 进程崩溃不影响 daemon；daemon 重启后 connector 能重连并恢复映射。
- 幂等的平台事件处理：同一事件重复投递不会创建重复 Thread/Order。
- 默认最小权限；写操作、附件、外部用户需要显式允许。
- 第一个真实平台（Discord 或 Slack）端到端验证，其余按同一契约接入。

非目标（第一阶段）：

- daemon 进程内插件 / 任意代码加载。
- Web UI 插件槽位。
- 跨平台统一消息格式（每个 connector 自己适配）。
- 复用平台 token 作为 cafe token。

## 命名冲突（必须先解决）

`cafe extension install|status|uninstall` **已经存在**，语义是给 pi/omp 安装 Barista 扩展（见 `packages/cli/src/extension.ts`）。#28 草案里的 `cafe extension install <connector>` 会与它撞名。

建议：Customer connector 一律使用 `cafe connector` 命名空间；`cafe extension` 继续只管 pi/omp 扩展。文档里明确：

- Barista 侧：`cafe extension` / pi/omp 扩展。
- Customer 侧：`cafe connector` / MCP / HTTP。

## 当前可复用的接入面

- `POST /api/orders`：创建 Order（JSON）。
- `GET /api/threads/:id/stream`（SSE）：跟一条 Thread，支持 `Last-Event-ID`。
- `GET /api/events`（SSE）：全局事件流，支持过滤和 `Last-Event-ID`；`GET /api/events/history?after=` 可补放。
- `/ws`：Web UI 用的 WebSocket；connector 可以只用 HTTP/SSE。
- `cafe mcp`：MCP stdio server（`cafe_agents` / `cafe_ask` / `cafe_wait` / `cafe_cancel`）。
- `packages/protocol/src/client.ts` 的 `CafeClient`：注册 Agent、发 Order、收事件；connector 可以复用，但 Customer 用 HTTP 更简单。
- token：loopback 免 token，远程用共享 token；没有细粒度 ACL。

## 方案比较

### A. 进程外 sidecar + `cafe connector` 监管（建议）

connector 是一个普通 Node 进程（或任意可执行文件），由 `cafe connector start` 或 launchd/systemd 监管。它只通过 cafe HTTP/WS API 工作，不进入 daemon 地址空间。生命周期、日志、健康、重启都由 supervisor 负责。平台 SDK 和消息适配留在 connector 里。

优点：隔离、可独立升级、崩溃不影响 daemon、实现简单；缺点：多一个进程，需要定义健康/日志协议。

### B. daemon 进程内 plugin loader（拒绝第一阶段）

在 daemon 里 `import()` 第三方代码。省一个进程，但引入任意代码执行、生命周期、版本兼容、权限和卸载问题；与 cafe 当前“轻依赖 daemon”的定位冲突。

### C. 只提供 SDK 库，不做 supervisor

发布 `@cafe/connector`，用户自己 `node connector.js`。实现最轻，但没有 install/start/stop/logs/status，多个 connector 各管各的，运维体验不一致。

**建议 A + C 的库：** `@cafe/connector` 提供类型和生命周期辅助，`cafe connector` 负责监管。

## 设计

### 1. manifest

`cafe-connector.json`（或 package.json 的 `cafe.connector` 字段）：

```json
{
  "name": "cafe-connector-discord",
  "kind": "customer-connector",
  "version": "0.1.0",
  "entry": "./dist/index.js",
  "permissions": ["orders:write", "threads:read"],
  "configSchema": {
    "botToken": { "type": "string", "secret": true, "required": true },
    "allowChannels": { "type": "array", "items": "string", "default": [] }
  },
  "health": { "type": "stdio", "heartbeatMs": 30000 }
}
```

- `permissions` 是声明，不是强制沙箱；supervisor 至少检查 connector 是否只访问声明的 API（通过代理/日志审计，第一阶段可只做记录）。
- `configSchema` 用于 `cafe connector config` 的校验和脱敏；`secret: true` 的字段不写日志、不在 `status` 中显示。
- `health.type`：`stdio`（stdout 心跳行）或 `http`（本地端口 `/healthz`）。第一阶段建议 `stdio`，最简单。

### 2. 命令

```bash
cafe connector install <path|package> [--force]
cafe connector list
cafe connector status <name>
cafe connector start <name>
cafe connector stop <name>
cafe connector restart <name>
cafe connector logs <name> [--follow]
cafe connector config <name> [key] [value] [--secret]
cafe connector remove <name>
```

- install 复制或链接到 `~/.cafe/connectors/<name>/`，校验 manifest，创建默认 config。
- start 读取 config，注入环境变量，启动 entry；stdout/stderr 写 `~/.cafe/logs/connector-<name>.log`。
- status 显示 running / stopped / crashed、最近心跳、最近错误、pid、restart count。
- remove 只删除 cafe 自己的 connector 目录和监管状态；如果同名目录不是 cafe 安装的，拒绝并提示 `--force`。

### 3. 进程契约

supervisor 启动 connector 时注入：

```
CAFE_DAEMON=127.0.0.1:4777
CAFE_TOKEN=<token>
CAFE_CONNECTOR_NAME=<name>
CAFE_CONNECTOR_CONFIG=<绝对路径>
CAFE_CONNECTOR_STATE=<可写目录>
```

connector 的职责：

1. 订阅平台事件；过滤 bot 自己、重复事件、未授权频道/用户。
2. 把平台 channel/thread/user 映射到 cafe Thread；持久化映射到 `CAFE_CONNECTOR_STATE/threads.json`（原子写）。
3. 调 `POST /api/orders` 发 Order；用平台事件 id 作为幂等键。
4. 用 `/api/threads/:id/stream` 或 `/api/events` 跟回复；把最终回复发回原 channel/thread。
5. 处理限流、重试、断线重连、daemon 不可用。
6. 定期向 stdout 写心跳行：`{"type":"heartbeat","at":<ms>,"ok":true}`；错误写 `{"type":"error","message":"…"}`。

supervisor 不必理解平台协议，只看心跳和进程退出。

### 4. 幂等与恢复

- 平台事件 id 是幂等键：connector 在本地维护 `seen-events` 环形/表（或 SQLite），重复投递直接忽略。
- 映射 `platformThreadId → cafeThreadId` 持久化；connector 重启后先读映射，再继续。
- connector 崩溃/重启：不重发已经发过的 Order；未发送成功的事件留在 outbox，重试。
- daemon 重启：connector 重连并重新订阅；对进行中的 Thread 用 `GET /api/threads/:id` 补状态。
- 平台断线：指数退避重连；不丢最终回复（outbox 持久化）。

### 5. 权限与安全

- 默认只读：connector 只能 `orders:write` + `threads:read`；附件（`attachments:write`）和升级（`update:*`）需要显式授予。
- 频道/用户 allowlist：`allowChannels` / `allowUsers`；不在列表里的消息不创建 Order。
- 外部消息默认按 `origin: "agent"` + `via: {address: "<connector-name>@<host>"}` 记录，Web 显示“代问”。
- 平台 token 和 cafe token 分离；connector 不能读取 cafe config 里的 token 之外的密钥。
- 日志和 status 对 `secret` 字段脱敏。
- 不允许 connector 自动触发 `cafe update` 或写文件到 cafe 目录之外。
- `/api/orders` 可以增加一个可选的 `idempotencyKey` 字段（connector 用平台事件 id），daemon 在短时间内去重；没有这个字段时 connector 自己保证。

### 6. SDK

发布 `@cafe/connector`：

```ts
export interface ConnectorContext {
  cafe: CafeHttpClient;        // orders/threads/events helpers
  config: Record<string, unknown>;
  stateDir: string;
  log(line: string): void;
  heartbeat(): void;
}

export function defineConnector(fn: (ctx: ConnectorContext) => Promise<void>): ConnectorMain;
```

connector 的 `entry` 默认导出 `defineConnector(...)` 的结果；`cafe connector start` 直接 `node entry.js`。SDK 只做薄封装，不隐藏 HTTP 语义。

### 7. 与 Open Claw / hermes-agent 的关系

- 复用它们的平台 SDK / 事件适配层，把最后的 agent 调用替换成 cafe Order；或把 cafe 包成它们的 MCP/HTTP 后端。
- 不直接把它们的插件当 cafe connector 安装；需要 manifest + 生命周期适配。
- 没看到源码前不假设可直接复用；先做薄适配。

## 验收判据

- 用一个 mock 聊天 connector 完成：收到消息 → 创建 cafe Order → 收到回复 → 发回原 channel/thread。
- 同一平台事件重复投递不会创建重复 Thread/Order；connector 重启后映射仍可恢复。
- connector 崩溃、daemon 重启、平台断线后能重连，不丢最终回复。
- 支持 follow-up、cancel、长任务；附件按 #20 的契约接入。
- `cafe connector list/status/logs` 能看到健康状态、最近心跳和最近错误。
- 非 allowlist 频道/用户不能发任务；外部消息默认只读，写操作需要显式审批。
- `cafe connector remove` 只删除 cafe 自己的文件，不影响用户目录。
- 至少一个真实平台（Discord 或 Slack）端到端验证；钉钉/飞书按同一契约接入。

## 已确认（2026-11-19，用户拍板）

- **Q1**：命名用 `cafe connector`；`cafe extension` 只负责 pi/omp 扩展。
- **Q2**：第一阶段只做进程外 sidecar，不做 daemon 内插件。
- **Q3**：第一个真实平台选 **Discord**（不是 Slack）；Slack/钉钉/飞书按同一契约后续接入。
- **Q4**：现在就在 `/api/orders` 加可选 `idempotencyKey`，daemon 做短窗口去重。

## 实现状态（2026-11-21）

已实现，mock 阶段：

- **SDK**：`@cafe/connector`（`packages/connector`）提供 `defineConnector(fn)` 与 `ConnectorContext`（`cafe` HTTP/SSE 客户端、`config`、`stateDir`、`log`、`heartbeat`、`error`、`emit`）。
- **持久化**：`stateDir/threads.json`（platformThreadId → cafeThreadId）、`seen-events.json`（事件 id 去重，默认 7 天 / 2000 条上限）、`outbox.json`（pending / sent / failed / delivered，崩溃后可重试或补发回复）。全部通过临时文件 + rename 原子写。
- **stdout 行协议**：心跳 `{"type":"heartbeat","at":<ms>,"ok":true}`，错误 `{"type":"error","message":"…"}`；由 SDK 负责。mock 的最终回复额外写 `{"type":"reply","channel":"…","threadId":"…","text":"…","final":true}`。
- **mock connector**：`packages/connector/mock`，stdin 读 `{"channel","user","eventId","text"}` JSON lines；按 `allowChannels` / `allowUsers` 过滤；用 `eventId` 作为 `/api/orders` 的 `idempotencyKey`；同一 eventId 只执行一次；重启后从 `threads.json` 恢复映射，follow-up 进入同一 Thread。配置 `ingestPort` 时额外启动本地 HTTP ingest（`POST /`、`GET /healthz`），方便手动试用。
- **supervisor / CLI**：`cafe connector install|list|status|start|stop|restart|logs|config|remove`（`packages/cli/src/connector.ts`）。start 以 detached 进程启动，注入 `CAFE_DAEMON` / `CAFE_TOKEN` / `CAFE_CONNECTOR_NAME` / `CAFE_CONNECTOR_CONFIG` / `CAFE_CONNECTOR_STATE`；日志写 `CAFE_HOME/logs/connector-<name>.log`；pid/restart 状态落盘；stop 先 SIGTERM 等待，超时才 SIGKILL；remove 只删带 cafe 安装标记（`.cafe-installed.json`）的目录，否则要求 `--force`。
- **daemon 幂等**：`POST /api/orders` 接受可选 `idempotencyKey`（协议类型同步）。daemon 在 10 分钟、最多 1000 条的窗口内返回同一个 `orderId` / `threadId`；并发重复请求共享同一个进行中的创建结果。
- **测试**：`tests/connector.test.ts` 真实走 HTTP/SSE，覆盖事件→Order→回复→原 channel、重复 eventId、重启后 follow-up、allowlist、HTTP ingest、CLI install/status/logs/remove，以及 `/api/orders` 幂等。

**真实 Discord 端到端仍待用户 bot token。** 本轮不接 Discord、不使用任何 bot token；Slack / 钉钉 / 飞书按同一契约后续接入。

### 手动试用 mock

```bash
cafe connector install packages/connector/mock --force
cafe connector config mock ingestPort 4899
cafe connector start mock
curl -s 127.0.0.1:4899/healthz
curl -X POST 127.0.0.1:4899 -d '{"channel":"c1","user":"u1","eventId":"e1","text":"hello"}'
cafe connector logs mock --follow   # 心跳、错误和最终回复都在这里
cafe connector remove mock
```

以 stdin 驱动（测试 / 管道）仍然可用：`node <entry>` 从标准输入逐行读取同样的事件 JSON。