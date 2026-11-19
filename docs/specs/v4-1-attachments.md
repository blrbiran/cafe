# v4-1 Order / Reply 附件

状态（2026-11-19）：spec 草案，等用户确认 Q1–Q4 后实现。来源：dogfooding #20。

## 为什么

cafe 现在只能传文字。跨机器的互补场景里，证据往往在文件里：远端 Docker 里的 agent 读过的补丁和日志、本地硬件 agent 的串口日志和抓包、两端都没有共享盘时的截图和构建产物。没有附件，用户只能回到聊天工具/共享盘传文件，cafe 又退回成"文字问答路由器"。

目标不是做网盘，而是让 **一次 Order / Reply 能带上它需要的证据**。

## 范围（第一阶段）

- Customer 发 Order 时带 0–N 个附件（Web 选择/拖拽，CLI `--attach`）。
- Barista 的最终 reply 可以带附件（协议与存储先支持，CLI/MCP 暴露 `cafe_reply` 的附件参数）。
- 附件元数据进事件与列表；二进制单独存放，绝不进 JSONL 正文。
- 跨机器可下载：Barista 在另一台 Host 上也能拿到文件。
- 明确的限额、权限、清理和安全边界。

不做：

- 不做在线预览/编辑器（图片可显示缩略图，其余一律下载）。
- 不做断点续传、分片上传、对象存储后端。
- 不做附件自动执行或自动解压。
- 不做版本/替换语义（一个附件 id 一个文件，改内容请重新上传）。

## 协议

```ts
const Attachment = z.object({
  id: z.string(),            // ULID, 由上传方 daemon 生成
  name: z.string(),          // 原文件名，仅用于展示与下载名
  mime: z.string().default("application/octet-stream"),
  size: z.number().int(),    // bytes
  sha256: z.string(),        // 上传时计算，下载时校验
  // 谁上传的：web / cli / mcp 或某个 Agent；用于权限与审计
  uploader: Party.optional(),
});
```

- `Order.attachments?: Attachment[]`
- `order.replied` 事件加 `attachments?: Attachment[]`（只带元数据）
- `ThreadMeta.attachments?: Attachment[]`：首轮 Order 的附件，供卡片显示"2 个附件"
- 旧的 Thread / 旧 daemon 不带这个字段，读取时当空数组；zod 全部 optional，不升 `PROTOCOL_VERSION`。

## 存储

- 路径：`CAFE_HOME/artifacts/<threadId>/<attachmentId>-<safeName>`；`safeName` 只保留 `[A-Za-z0-9._-]`，去掉路径分隔符。
- 写盘用 temp + rename（与其他状态文件一致），先算 sha256 再落盘。
- 上传方 daemon 是附件的原点（origin）。Order 跨机器时：
  - **方案 A（建议）**：Barista 所在 daemon 在 `order.delivered` 后按需 **pull** `GET /api/artifacts/:id`（Root 在线走 Root 转发，离线走 direct link），校验 sha256 后落在本地 `artifacts/<threadId>/`。
  - 方案 B：发 Order 时把 blob 一并 push 给 Root/目标。
  选 A：发送路径不变、Root 不需要存大文件、失败可以明确记为 `attachment_unavailable`。
- 同一个附件在一条 Host 上只存一份（threadId + id 天然唯一）；sha256 可用于日志与排障，不做跨 Thread 去重（第一阶段不值得）。

## HTTP / RPC

```text
POST   /api/artifacts?name=<name>&mime=<mime>   raw body → { attachment }
GET    /api/artifacts/:id[?download=1]          文件流；带 Content-Disposition: attachment
```

- 所有请求沿用现有 token / loopback 鉴权。
- 上传返回的 `attachment` 直接放进 `POST /api/orders` 的 `attachments` 字段；服务端再次校验 id 属于本 daemon 且 size/sha256 一致。
- 跨机器拉取复用同一 GET；目标 daemon 校验 sha256，失败则 `order.failed { reason: "attachment_unavailable" }`。
- `Content-Type` 一律取安全的 `application/octet-stream`（图片 png/jpeg 可保留类型，但 `Content-Disposition: attachment`，禁止 inline HTML/SVG）。

## CLI / MCP

```bash
cafe ask --attach ./serial.log --attach ./capture.pcap "分析这个时序"
cafe thread <threadId> --download <attachmentId> [--out ./dir]
cafe reply <threadId> --attach ./patch.diff "补丁在这里"
```

- `cafe ask` 先上传（每个文件一行进度），再带着附件 id 发 Order；任一大失败则整体失败，不发半个 Order。
- `cafe thread` 显示附件名/大小；`--download` 下载到 `--out`（默认当前目录），先校验 sha256。
- MCP：`cafe_ask` 增加 `attachments: [{name, mime?, content_base64}]`；`cafe_reply` 同样。base64 有膨胀，单文件上限按计费后的字节数校验。
- 退出码：上传失败 / 下载校验失败都非 0。

## Web

- Composer：选择或拖入文件，显示名称、大小、移除按钮；上传中禁用发送。
- Thread：问题/回答下方列出附件（图标、名字、大小、下载按钮）；图片显示缩略图，点击仍是下载。
- 卡片：显示 `📎 2`，不展开。
- 失败回显：上传失败、超过限额、下载 404/校验失败都给可操作错误。

## 限额与配置

```yaml
attachments:
  maxMb: 25          # 单个文件
  threadMaxMb: 100   # 单个 Thread 总量
  maxCount: 10       # 单个 Order/Reply
```

- 超限：HTTP 413 / CLI 明确报错，不发 Order。
- 计数以 size 之和为准；跨机器拉取时目标 Host 也按同一上限校验。
- 不影响现有 `.cafe` 解析；配置项缺省即用默认值。

## 安全边界

- 附件永不自动执行、自动解压或自动打开。
- 下载名与路径都过 sanitize；拒绝 `..`、绝对路径、控制字符。
- 只允许 token/loopback 访问；跨机器拉取必须带 token。
- 不信任上传的 MIME：一律以 attachment 响应，禁止 inline 渲染。
- 每条 Order 的附件对 Thread 参与者可见（Root、两端 daemon、订阅的 Web）；不引入更细的 ACL。

## 清理

- `retention.days` 生效时，删除 Thread 的同时删除 `artifacts/<threadId>/`。
- `cafe prune` 干跑时列出附件体积；`--yes` 才删。
- 启动时做一次孤儿目录扫描（没有对应 Thread 的 `artifacts/<id>/`），只报告，不自动删。
- 失败的上传留下临时文件：daemon 启动和每小时清理 `*.tmp`。

## 验收判据

- Web 拖入一个 2MB 日志 → 远端 Barista 回复里能引用该文件内容 → Web 和 CLI 都能下载且 sha256 一致。
- CLI `--attach` 发两文件，远端收到顺序与元数据一致；超过 `maxMb` 时本地直接失败。
- Barista reply 带附件：Web 显示、CLI `cafe thread --download` 可取。
- 跨机器（Root 在线 / Root 离线 direct link）各验证一次拉取；附件不可用时 Order 以 `attachment_unavailable` 失败，不静默丢。
- 旧 Thread（无附件）显示不变；旧 daemon 不影响连接。
- 上传 0 字节、非法文件名、路径穿越、SVG/HTML 分别被拒绝。
- `cafe prune --yes` 删除 Thread 后附件目录消失；不带 `--yes` 只报告。
- JSONL 正文里搜不到二进制内容；事件里只有元数据。

## 独立评审结论（2026-11-19，待用户拍板）

一个独立 subagent 对照代码评审了 Q1–Q4。建议如下（与原草案不同的地方已标出）：

- **Q1：协议一次定好，但第一阶段只实现 Customer → Barista 的传输。** reply 附件先支持“同 Host 落盘 + 元数据”，跨机 reply 传输放第二阶段。理由：CLI 没有 `cafe reply`，MCP 没有 `cafe_reply`，Bridge 的回复路径是 `h.reply(text)`，没有给 agent 附文件的入口；reply 到达时 Customer 可能离线，pull 需要另一套“上线后补拉”的队列。协议字段（`order.replied.attachments`）可以现在加，不升 `PROTOCOL_VERSION`。
- **Q2：选 pull，但不要让 Root 代理 blob。** daemon 间永远直连 origin 的 HTTP（peerUrls / 已配置地址），Root 在线与否只影响 Order 路由。必须补三处：
  1. **pull 在通知 Agent 之前完成**（`deliverLocal` 先 await 拉取再 `orderDeliver`），否则 Bridge/pi 已经用没有落盘的附件开工。
  2. **ack 超时与 fallback 重投**：25MB 慢链路可能超过 30s ack；带附件的 Order 要么把 armAck 移到 `order.delivered` 之后，要么放宽窗口，避免 origin 因 no-ack 把同一个 Order 重投给另一台 Barista 再拉一遍。
  3. **backfill 只有元数据、没有 blob** 是设计后果：Root/Web 显示附件但下载不到时，必须由本地 daemon 按 `attachment.host` 代理 GET，并给可操作错误（“origin 不可达 / 已被 retention 清理”）。
- **Q3：HTTP/CLI 的 25MB / 100MB / 10 个合理，保留；MCP 不要走 base64。** `cafe mcp` 是本地 stdio 进程，应接受本地文件路径由 MCP server 自己读盘上传；base64 只留给 agent 内存里生成的小内容，解码后上限建议 ≤5MB。限额放进 `CafeConfig.attachments`，`cafe config set attachments.maxMb` 天然可用。上传必须流式写临时文件、边收边算 size/sha，不能走全量 `readJson`；thread 配额在 `order/create` 时校验。
- **Q4：做缩略图，但纯浏览器端缩放，服务端零生成。** 不引入 sharp/native 依赖。响应 MIME 只对 png/jpeg/webp/gif 保留真实类型并加 `X-Content-Type-Options: nosniff`；SVG/HTML/未知一律 `application/octet-stream`，点击仍走 `?download=1` 的 attachment。`<img>` 渲染本身不执行 SVG 脚本，安全规则保得住；token 走 query（与 SSE 一致）。

### 评审发现的 blocking 缺口（实现前必须补进 spec）

1. **Attachment 缺 origin host**：follow-up 可以来自第三台 Host，同一 Thread 的附件可来自多台机器；`uploader` 是 optional 且语义不同，不能兼任“去哪台机器拉 blob”。
2. **上传时还没有 threadId**：存储路径 `artifacts/<threadId>/…` 与“先上传再发 Order”矛盾。需要 `artifacts/_staging/<id>`，`order/create` 时 move 到 thread 目录，并清理 staging 孤儿。
3. **Web/CLI 的跨 Host 下载路径不存在**：浏览器只跟本地 daemon 说话，也没有 CORS；需要本地 daemon 的流式代理 GET，并维护 `attachmentId → (threadId, host, path)` 索引。
4. **pull 与开工 / ack 的时序**：见 Q2 的三点，是“远端 Barista 能引用文件内容”能否成立的关键。
5. **旧 daemon 静默丢附件**：zod 默认 strip、`CreateOrderParams.parse` 会丢掉新字段。客户端必须做能力检测（`/api/health` 的 version），不支持就本地报错，不发半个 Order；不要升 `PROTOCOL_VERSION`。
6. **Barista 怎么读到文件**：Bridge 的 prompt 只有 body/history，Order 元数据没有本地路径。要么 daemon 在 prompt 注入落盘绝对路径，要么给 Barista 侧一个列举/下载工具。

后续要记一笔（不阻塞第一阶段）：thread 配额记账的 source of truth、retention/prune 同时删 artifacts、并发上传/in-flight pull 合并、MCP schema 同步、Web 上传进度（XHR/ReadableStream）、同 Thread 同 sha 去重。

## 待用户确认

- **Q1**：第一阶段是否同时支持 Barista reply 附件，还是先只做 Customer → Barista？（评审建议：协议都定，第一阶段先 Customer→Barista；reply 先同 Host。）
- **Q2**：跨机器走 pull-from-origin（建议）还是 push-with-order？（评审建议：pull，直连 origin，不经 Root。）
- **Q3**：默认限额 25MB / 100MB / 10 个是否合适？是否要允许按 Host 配置覆盖？（评审建议：保留，放进 config，MCP 改传路径。）
- **Q4**：图片是否要缩略图预览，还是第一阶段全部只做下载？（评审建议：做，纯浏览器缩放。）