# v3-1 原生支持 Codex 和 Claude Code（调研 + 决策题）

状态：**只做了调研，等用户回答 Q72–Q79**（2026-11-19）。用户要求本轮只调研，下个 session 回答决策题后再实现。

## 现状

- Codex / Claude Code 当 Barista：只有 `cafe serve --preset codex|claude`，每个问题跑一次 `codex exec` / `claude -p`。追问没有上下文，不能中途取消，正在用的 TUI 会话收不到 Order。
- 当 Customer：只能靠 skill 调 `cafe` CLI。
- 对照：pi / omp 有扩展，Order 在空闲时作为 follow-up 注入当前会话；headless 由 supervisor 托管 `pi --mode rpc`。

目标是三种角色：
1. **headless 常驻 Barista**：由 daemon 托管，一个 cafe Thread 对应一个 Codex thread / Claude session，追问有上下文。
2. **TUI 会话当 Barista**：Order 推进用户正在用的会话。
3. **Customer 走 MCP**：`cafe mcp` 提供 `cafe_ask` 等工具，不用 skill。

## 调研结论

| | Codex（本机 codex-cli 0.170.0，源码 `/Users/biran/code/skills/agent/codex`） | Claude Code（官方文档 code.claude.com，2026-11） |
|---|---|---|
| 1 headless | **可行**。`codex app-server`（stdio JSON-RPC，无 `jsonrpc` 字段，和 cafe 的 Peer 同风格）。`initialize` + `initialized` → `thread/start`（或 `thread/resume`）→ `turn/start {threadId, input}`；完成看 `turn/completed`；回答取 `item/completed` 里 `agentMessage` 的 `final_answer`（没有就取最后一条）；取消用 `turn/interrupt`。服务端会发审批请求（`item/commandExecution/requestApproval` 等），**必须回应否则 turn 卡住**。备选：`codex exec --json` + `codex exec resume <id>`，每题一个进程 | **可行**。三种：A `claude -p "<msg>" --resume <session_id> --output-format json`（每题一个进程，最简单）；B 常驻 `claude -p --input-format stream-json --output-format stream-json`；C Agent SDK `query()` + 流式输入（`interrupt()` 可取消）。权限：`--permission-mode dontAsk` + `--allowedTools`，或 `--permission-prompt-tool` / SDK `canUseTool` |
| 2 TUI | **可行，有前提**。TUI 会连上共享的 app-server 守护进程（`~/.codex/app-server-control/app-server-control.sock`，需用户先 `codex app-server daemon start`；否则 TUI 用进程内 server，外部连不上）。注入用实验接口 `thread/queue/add`（`codex queue` 用的就是它），**线程空闲时自动开始**，正好对应 pi 扩展"空闲时注入"。审批由用户在 TUI 里处理，桥接方不能代答。推断未验证：TUI 是否正常显示别的客户端发起的 turn | **部分可行，只能靠 channels**（研究预览）。channel 是声明 `claude/channel` 能力的 MCP 服务器，发 `notifications/claude/channel`，用一个 reply 工具回复。自定义 channel 不在白名单，需要 `--dangerously-load-development-channels`，`-p`/SDK 下无效；协议可能变。hooks 不能在空闲时发起 turn。未读：文档里的 cross-session-messaging |
| 3 MCP Customer | **可行**。`~/.codex/config.toml` `[mcp_servers.cafe] command="cafe" args=["mcp"]` 或 `codex mcp add cafe -- cafe mcp`。默认单次工具调用超时 **300 s**（`tool_timeout_sec` 可调） | **可行，稳定**。`claude mcp add --transport stdio cafe -- cafe mcp`；也可以做成 plugin，一起打包 MCP 服务器、skill、hooks。工具调用超过 **2 分钟**会自动转后台（`-p` 下结果会丢），长任务要做成"先返回 ticket，再取结果" |

主要风险：
- **Codex**：`thread/queue/*` 等是实验接口，随版本可能变 → 启动时探测方法是否存在。只能用 `~/.codex/auth.json` 的登录。
- **Claude**：`-p` 默认会执行项目 `.claude/settings.json` 的 hooks 和 `.mcp.json`（`--bare` 可避免，但 `--bare` 只认 API key）。官方政策：第三方产品不得让用户用 claude.ai 订阅登录，除非事先获批。个人自用属于灰色地带，**分发给别人时应要求 API key**。
- **两边共同**：headless Barista 默认**不能自动批准写操作**。

## 决策题（编号接 Q71）

- **Q72 先做哪些角色**
  - 推荐：**先做 1（headless）和 3（MCP Customer）**，两边都做。
  - 2（TUI）放第二阶段：Codex 用 app-server 守护进程 + `thread/queue/add`；Claude 的 channels 只做可选实验。
- **Q73 Codex headless 用什么**
  - 推荐：**`codex app-server`**。一个 Barista 一个常驻进程，记住 cafe Thread → Codex thread，支持流式和取消。
  - 备选：`codex exec resume`，更简单，但不能取消，也没有进度。
- **Q74 Claude headless 用什么**
  - 推荐：**A `claude -p --resume <session_id> --output-format json`，每题一个进程**。最稳，没有常驻状态要管，用 SIGINT 取消。
  - 冷启动慢的话，再换成 C（Agent SDK，会多一个依赖）。
- **Q75 headless Barista 的默认权限**
  - 推荐：**只读**。Codex 用 `approvalPolicy: never` + `read-only` 沙箱，所有审批请求一律 decline。Claude 用 `--permission-mode dontAsk` + 只读工具（Read / Grep / Glob 等）。
  - 每个 Barista 可以在 `.cafe` 或 `barista start` 上显式放开到"可写工作区"。永远不默认全权限。
- **Q76 Claude 的登录方式**
  - 推荐：**默认沿用本机 `claude` 的现有登录**（个人自用）。不加 `--bare`，但用 `--setting-sources` 限制只读用户级设置，避免执行项目 hooks。
  - 文档里写明：分发或团队使用时请配置 `ANTHROPIC_API_KEY`；配了 key 就自动加 `--bare`。
- **Q77 Customer 的 MCP 工具设计**
  - 推荐：`cafe mcp`（stdio）提供 `cafe_agents`、`cafe_ask`、`cafe_wait`。
  - `cafe_ask` 最多等约 100 秒（小于 Claude 的 2 分钟和 Codex 的 300 秒）：有回答就直接返回；没有就返回 threadId 和"还在处理"，再用 `cafe_wait` 继续等。
  - 另加 `cafe mcp install` 打印或执行 `claude mcp add …` / `codex mcp add …`。skill 保留作为备用。
- **Q78 怎么启动这类 Barista**
  - 推荐：沿用 `cafe barista start --dir <dir> --agent codex|claude`，和 omp 一样持久化在 `baristas.json`，由同一个 supervisor 托管。
  - `.cafe` 不加新字段。`cafe serve --preset` 保留给"每题一个命令"的简单场景。
- **Q79 追问和重启**
  - 推荐：cafe Thread → 外部会话 id 的映射存进 daemon 的 SQLite，daemon 或 Barista 重启后用 `thread/resume` / `--resume` 继续。
  - 同一个 Thread 同时只跑一个 turn，后来的 Order 排队。

## 实现前要先验证的（不需要用户）

- Codex：用 mock Responses provider（参考 ccloop 的 codex-qa harness，`/Users/biran/code/skills/orca/ccloop/reference/oh-my-openagent/.agents/skills/codex-qa/`）验证 `thread/queue/add` 的 turn 和 `clientUserMessageId` 的对应关系，以及 TUI 能否显示外部发起的 turn。`SandboxMode` 在线上的写法要按 `codex app-server generate-json-schema --experimental` 的输出为准。
- Claude：确认 `--setting-sources` 的写法；读 cross-session-messaging 文档。真实调用模型时每次都要用户同意。

## 附：调研原文要点

### Codex（来自本机源码，路径相对 `codex-rs/`）

- 方法名：`app-server-protocol/src/protocol/common.rs`；thread / turn / item 的结构：`v2/thread.rs`、`v2/turn.rs`、`v2/item.rs`、`v2/shared.rs`。
- 握手：`initialize {clientInfo, capabilities:{experimentalApi:true}}`，然后必须发 `{"method":"initialized"}`（`protocol/v1.rs:29-60`）。
- `thread/start {cwd, model?, approvalPolicy?, sandbox?, developerInstructions?, ephemeral?}` → `result.thread.id`；`thread/resume {threadId, excludeTurns:true}`。
- `turn/start {threadId, input:[{type:"text", text, text_elements:[]}], clientUserMessageId?}`；`turn/steer`；`turn/interrupt {threadId, turnId}`。
- 事件：`turn/started`、`item/started`、`item/agentMessage/delta`、`item/completed`、`turn/completed {turn:{status: completed|interrupted|failed}}`。不要依赖 `turn/completed` 里的 `turn.items`（`v2/thread_data.rs:430`）。
- `agentMessage.phase`：commentary | partial_answer | final_answer（`protocol/src/models.rs:1056`）。
- 审批：`AskForApproval` = untrusted | onRequest | never | granular（`v2/shared.rs:217`）；`SandboxMode`（`v2/shared.rs:346`）。审批请求的回应 `{decision: accept|acceptForSession|decline|cancel}`（`v2/item.rs:70`、`:1767`）。
- TUI 共享守护进程：`tui/src/lib.rs:466`、`tui/src/startup_orchestration.rs:364`；`--no-daemon`、`--oss`、`--profile` 会关掉共享。
- 队列：`tui/src/session_queue_commands.rs`；空闲时派发：`ext/queue/src/service.rs:275-290`、`:440`、`:588`。
- MCP 配置：`config/src/mcp_types.rs:397`；超时：`codex-mcp/src/rmcp_client.rs:124-125`（启动 30 s，单次调用 300 s）。
- ccloop 里已有可用的 Node app-server 客户端：`scripts/lib/app-server-client.mjs`（codex-qa skill 内）。

### Claude Code（官方文档）

- headless：https://code.claude.com/docs/en/headless.md（SIGINT 结束当前 turn 但保留进程，SIGTERM 退出 143）；CLI 参数：https://code.claude.com/docs/en/cli-reference.md
- SDK：https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md、https://code.claude.com/docs/en/agent-sdk/sessions.md、权限：https://code.claude.com/docs/en/agent-sdk/permissions.md（`canUseTool` 只在前面的 hooks、规则、模式都没决定时才会被调用；`bypassPermissions` 不受 `allowedTools` 约束）
- 认证与政策：https://code.claude.com/docs/en/authentication.md、https://code.claude.com/docs/en/agent-sdk/overview.md
- channels：https://code.claude.com/docs/en/channels.md、https://code.claude.com/docs/en/channels-reference.md（权限转发 `claude/channel/permission` 需要 v2.1.234+）
- hooks：https://code.claude.com/docs/en/hooks.md（`asyncRewake` 后台 hook 以退出码 2 唤醒，但这不是正式的 IPC 接口）
- MCP 与 plugin：https://code.claude.com/docs/en/mcp.md、https://code.claude.com/docs/en/plugins/components.md；长任务：MCP tasks（公测，v2.1.304+），`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`
