# cafe

[English](README.md) | [中文](README_zh.md)

cafe 是一个 agent 网络：任意一方发出的一条消息（Order），会被路由到网络上最适合回答它的一个或一组 agent（Barista）。术语见 [GLOSSARY.md](./GLOSSARY.md)，关键架构决策见 [docs/adr/](./docs/adr/)。

```
                ┌──────────── Root Daemon (host A) ────────────┐
                │  权威 Registry · 中转所有 Order · 全网 web UI │
                └───────▲──────────────────────────▲───────────┘
                        │ ws (token)               │ ws (token)
            ┌───────────┴──────────┐   ┌───────────┴──────────┐
            │ Daemon (host B)      │   │ Daemon (host C)      │
            │ Registry 副本 · 路由  │   │ Registry 副本 · 路由  │
            └──▲──────▲───────▲────┘   └──▲──────────▲────────┘
               │      │       │           │          │
          pi (TUI)  pi (rpc)  cafe CLI   Codex /    Claude Code / Codex
          Barista   Barista   Customer   Claude     （通过 cafe mcp 或 skill
                                         Barista     当 Customer）
```

- 每个 Host 一个 **Daemon**，监听单一端口（默认 4777），在该端口上提供 HTTP API、`/ws` WebSocket 与 web UI。
- 发起方所在的 Daemon 负责做 **Routing Decision**：配置了 `router.model` 时用 LLM（通过 pi SDK）决策，否则按关键词规则。Order 原文透传，不做改写。
- Root 在线时，所有 Order 都经 Root 中转（ADR-0001）。Root 离线时，同一 Host 内的 Order 照常投递，跨 Host 的 Order 直连目标 Daemon（ADR-0004）；连不上才返回 `root_unreachable`。Root 恢复后，离线期间的会话会补发给它。
- Registry 由 Root 复制到每个 Daemon（ADR-0002）。Thread 内容存放在 `~/.cafe/sessions/<date>/<threadId>.jsonl`，SQLite 里只存元数据（ADR-0003）。

## Quick start

需要 Node ≥ 22.18。

```bash
npm i -g @blrbiran/cafe
cafe init --yes --name my-agent --description "what this agent can answer"
cafe daemon start --root
cafe doctor                       # 检查并打印下一步；全部正常时输出 all checks passed
open http://127.0.0.1:4777/       # web UI
```

`cafe --help` 里有同一份 quick start。多台机器请装同一个版本：协议不兼容的版本会被拒绝连接，版本不同但兼容时 `cafe daemon status` 和网络页会提示。

## 身份：`.cafe`

`.cafe` 是一个 YAML 文件，给在这个目录里启动的 agent 提供名字、描述和角色。`cafe init` 会写一个带注释的最小文件：

```yaml
name: billing
description: Owns the billing service: invoices, VAT, payment provider integration.
tags: [billing, invoice, vat]
scope: [~/code/billing]
role: barista        # or customer（只提问，不接 Order）
concurrency: 1       # headless worker 进程数
```

- 没有 `.cafe` 时：Customer（CLI、MCP、Claude Code / Codex）以目录名匿名工作；Barista（`serve`、`barista start`）需要显式身份，会提示 `cafe init`。
- 目录名也叫 `.cafe` 的是 cafe 的数据目录（`~/.cafe`），不会被当成身份文件；`cafe init` 也不会覆盖它。
- `.cafe` 解析失败时会指出文件路径、缺失字段和最小模板，而不是裸 `EISDIR` / ZodError。

改名和别名（不影响路由键和历史；见 [ADR-0007](docs/adr/0007-display-names-and-aliases.md)）：

```bash
cafe host rename mac-mini-2         # 本机 Host 的展示名（热更新）
cafe host alias old-mac-mini        # 用户别名：优先展示，可删除
cafe host unalias old-mac-mini      # 删除用户别名（自动保留的旧名字仍可路由）
cafe agent rename billing@mac-mini billing-owner   # Agent 展示名，Address 不变
cafe agent alias billing@mac-mini invoices         # 用户别名（alias-first 展示）
cafe agent unalias billing@mac-mini invoices
cafe daemon rename ssh1 ssh1-docker # Root 上改另一台 Daemon 的展示名
```

内部 `host`、`agentId` 和 Address 不变，旧 Thread/统计继续有效。改名不再把旧名字放进展示候选：旧名进入 `legacyAliases` 只用于路由；`aliases` 是用户显式添加的别名，展示优先级是 `alias → displayName → 稳定名`。Web 会把两类都显示为 chip，只有用户别名有删除按钮。

## 作为 Customer

- **Claude Code / Codex（推荐 MCP）**：`cafe mcp install` 用户级注册 `cafe mcp`（`--dry-run` 只打印命令，`--client claude|codex` 只装一个）。工具：`cafe_agents`、`cafe_ask`、`cafe_wait`、`cafe_cancel`。注册的是绝对 node + cafe.js 路径；换了 Node 版本或移动仓库后要重装。
- **skill**：`cafe skill install` 创建软链 `~/.claude/skills/cafe` 和 `~/.agents/skills/cafe`。Codex 用 `$cafe` 引用，pi 用 `/skill:cafe`。

各宿主的 cafe 入口（都可以再用 CLI 或 MCP 提问）：

| 宿主 | 自然入口 | 说明 |
|---|---|---|
| Codex | `$cafe` + MCP 工具 | `cafe mcp install` 让 Codex 成为 **Customer**；`cafe barista start --agent codex` 才让它成为 **Barista** |
| pi / omp | `/cafe agents\|ask\|status\|thread\|help` + `/skill:cafe` + 扩展工具 | 扩展注册 `/cafe`，skill 仍走自己的 `/skill:cafe` 命名空间 |
| Claude Code | `/cafe agents\|ask\|status\|thread\|help`（Customer，需 `cafe commands install --agent claude`）、`/cafe-barista off\|on`（插件会话控制）、skill、MCP | Claude 插件占用 `/cafe-barista`；`/cafe` 与 pi/omp 是同一套 Customer 入口 |

`cafe mcp install` 只让宿主**提问**。要让它**回答**，启动 Barista：`cafe barista start --dir <dir> --agent codex|claude`，或 `cafe serve --preset codex|claude`（默认只读，`--write` 才放开写入）。
- **CLI**：`cafe ask "..."`、`cafe ask --to billing "..."`、`cafe ask --thread <id> "追问"`、`cafe inbox`、`cafe thread <id>`、`cafe tail`（全网 routed / delivered / acked / replied / closed 事件；`--json` 输出 JSONL，`--host` / `--type` / `--thread` 过滤，默认隐藏心跳）。
- **Web**：打开 `http://127.0.0.1:4777/`。导航固定、内容独立滚动；点对话从右侧打开，列表位置不变；导航里的 Agents 可展开看已注册 agent；设置里改显示名/别名、路由模型和后台 Barista；实况页是全网事件流。

## 作为 Barista

### pi / omp（持久安装）

```bash
cafe extension install --agent all          # pi 写入 ~/.pi/agent/settings.json，omp 走 omp install
cafe extension status                       # 检查两边是否真的加载
cafe extension install --agent pi --dry-run # 只显示会写什么
```

`pi -e "$(cafe pi-extension-path)"` / `omp -e ...` 仍然可用，但只对本次启动有效，适合临时调试。

headless Barista（由 Daemon 托管，崩溃自动重启）：

```bash
cafe barista start --dir ~/code/billing            # pi
cafe barista start --dir ~/code/billing --agent omp
```

### Codex / Claude Code（原生会话，由 Daemon 托管）

```bash
cafe barista start --dir ~/code/billing --agent codex    # codex app-server
cafe barista start --dir ~/code/billing --agent claude   # claude -p，每题一个进程
```

默认**只读**（Codex 只读沙箱，拒绝一切审批；Claude 只有 Read / Grep / Glob）。`--write` 只允许改 `--dir` 里的文件，不会更多；`--model <m>` 指定模型。Claude 用本机 `claude` 的登录，只读用户级设置；设了 `ANTHROPIC_API_KEY` 就改用 `--bare`。设计见 [ADR-0005](docs/adr/0005-native-codex-claude-baristas.md)。

### 正在用的终端会话

```bash
cafe claude install            # 装 cafe 的 Claude Code 插件（--dry-run 先看）
                               # 之后在有 .cafe 的目录里开的 Claude Code 会话自动接问题
                               # 会话里：/cafe 看地址，/cafe-barista off 暂停，on 恢复
                               # （旧插件的暂停/恢复占用 /cafe；重跑 `cafe claude install` 即可切换）
cafe barista start --dir ~/code/billing --agent codex --tui   # 问题放进该目录最近活动的 Codex 会话
```

问题在会话空闲时作为新的一轮进入，审批照常在终端里由你处理。120 秒内没开始（忙、按 Esc 打断后还没发新消息、或已关闭）就以“暂时不可用”婉拒。设计见 [ADR-0006](docs/adr/0006-tui-sessions-as-baristas.md)。

### 任意命令

```bash
cafe serve --exec "<任意命令>" --dir ~/code/billing    # 或 --preset claude|codex
```

每个问题跑一次命令，prompt 走 stdin，stdout 即回答；输出 `CAFE_DECLINE: 原因` 表示婉拒。追问没有会话，只靠 prompt 里的历史。

## 聊天 connector（实验）

`cafe connector` 以**进程外 sidecar** 的方式运行 Customer connector：把平台消息变成 cafe Order，再把回答发回原频道。提供 mock connector 用于测试，**Discord** 是第一个真实平台。

```bash
cafe connector install packages/connector/mock   # 从源码仓库安装
cafe connector config mock ingestPort 4899       # 可选：用本地 HTTP 喂事件
cafe connector start mock
curl -s -X POST 127.0.0.1:4899 -H 'content-type: application/json' \
  -d '{"channel":"demo","user":"you","eventId":"e1","text":"cafe 是做什么的？"}'
cafe connector logs mock --follow                # 心跳和回复
cafe connector status mock
cafe connector stop mock
```

**Discord**（需要 bot token，并在 Discord Developer Portal → Bot 开启 **Message Content** 特权 intent）：

```bash
cafe connector install <cafe 包目录>/connector/discord   # 或源码仓库的 packages/connector/discord
cafe connector config discord token <bot token>         # 仅本人可读，不会回显
cafe connector config discord allowChannels '["1234"]'  # guild/channel/user id 白名单
cafe connector config discord allowGuilds   '["5678"]'
cafe connector start discord
cafe connector logs discord --follow
```

在 guild 里机器人只回答 @ 它的消息（`requireMention` 默认开）；`allowDMs` 打开私聊。回复发回同一频道，按 Discord 2000 字符上限切分。`allowGuilds`/`allowChannels`/`allowUsers` 默认为空 = 全部允许，共享服务器请设置白名单。安装时会把 `discord.js` 装进 connector 自己的目录（不是 cafe 的依赖）。

connector 是一个目录：`cafe-connector.json`（name / entry / permissions / configSchema）+ 一个用 `@cafe/connector` 的 `defineConnector` 写的入口。状态在 `CAFE_HOME/connector-data/<name>/`，日志在 `CAFE_HOME/logs/connector-<name>.log`。`install` 复制目录并把 SDK 链接进它的 `node_modules`；SDK 随发布包分发（`connector/`），所以从已发布 cafe 安装的 connector 也能解析 `@cafe/connector`。connector 由监管器托管：意外退出会退避重启，1 分钟内退出 5 次则停在 `crashed`（看 `cafe connector logs`），不会无限重启。可用 `CAFE_CONNECTOR_MAX_RESTARTS` / `CAFE_CONNECTOR_WINDOW_MS` / `CAFE_CONNECTOR_BACKOFF_MS` 调整。

## 配置

`~/.cafe/config.yml`（可用 `CAFE_HOME` 覆盖目录）：

```yaml
mode: daemon               # daemon | root（改这个需要重启）
host: mac-mini             # 地址的一部分；改名见下方说明
port: 4777                 # 改端口需要重启
token: <shared token>      # 来自局域网的连接必须携带；来自 loopback 的连接免 token
advertise: 192.168.1.10    # 其他机器可达的地址；容器/NAT 里必须显式设置
root: 192.168.1.10:4777    # mode=daemon 时填写
router:
  model: anthropic/claude-haiku-4-5   # 走 pi 的 auth.json；不填则用规则路由
  fallback: rules          # rules | root（本地没有 LLM 时请 Root 代为路由）
  learn: true              # 参考最近 7 天的婉拒记录，在描述同样匹配的 Barista 之间排先后
discovery: true            # 局域网 mDNS：Root 应答，未配 root 的 Daemon 自动查找
retention:
  days: 90                 # 可选；不设则永不自动清理，用 `cafe prune --older-than N [--yes]` 手动清
```

**哪些配置会热生效**：`router.model`、`root` 会通过 `/api/reload` 应用到运行中的 Daemon；`mode`、`host`、`port`、`advertise`、`retention`、`discovery` 需要重启。`cafe config set` 会直接告诉你属于哪种（`applied` 或 `saved; restart required: cafe daemon restart`）；`cafe config diff` 列出文件与运行值的全部差异，`cafe config apply` 应用热更新项，`cafe daemon restart` 应用其余项。`cafe status` 一屏显示 daemon、router、root、流量、pending 配置和下一条命令。

`cafe root set <addr>` 和 `cafe config set <k> <v>` 会同时更新文件；`cafe root set` 还会更新正在运行的连接。容器或 NAT 里的 Daemon 要把 `advertise` 设成 Root 能访问的地址，否则 Root 不会记录一个不可达的回连地址。

同一局域网内，没配 `root` 的 Daemon 会通过 mDNS 自动找到 Root（只找到一个时才会自动连），`cafe root discover` 可手动查看；token 仍需手动设置。`cafe daemon install` 让 Daemon 开机自启、崩溃后自动重启（macOS launchd / Linux systemd --user），`cafe daemon uninstall` 撤销。详见 [`docs/specs/v2-3-discovery-autostart.md`](docs/specs/v2-3-discovery-autostart.md)。

路由主要看 Barista 的描述；`router.learn` 只是辅助：最近在类似问题上婉拒过的 Barista 会排到后面，但不会被排除，也不会盖过描述更匹配的 Barista。`cafe stats` 查看每个 Barista 最近 7 天回答、婉拒的次数和常婉拒的话题。详见 [`docs/specs/v2-1-routing-hints.md`](docs/specs/v2-1-routing-hints.md)。

## 验证与排障

```bash
cafe doctor               # daemon、身份、extension、skill、router、root 逐项检查，并给下一条命令
cafe daemon status
cafe agents               # 应该能看到自己的 Barista（address、role、status）
open http://127.0.0.1:4777/
```

“装了 extension，但 Web UI 里没有 Agent”按这个顺序查：

1. `cafe extension status`：pi 的 settings 里有没有 cafe 条目、omp 是否 link 成功；
2. 宿主要重启才会重新加载扩展；`cafe daemon status` 看 Daemon 是否在跑；
3. `cafe init` 确认当前目录有可解析的 `.cafe`；
4. `cafe doctor` 会把以上结果和下一步一起打印出来。

日志：`~/.cafe/daemon.log`、`~/.cafe/logs/barista-*.log`；Thread 原文在 `~/.cafe/sessions/<date>/<threadId>.jsonl`。

## 包结构

| 包 | 作用 |
|---|---|
| `packages/protocol` | 线协议类型与 zod schema、`Peer`（请求/响应/通知）、`CafeClient`（agent 侧客户端）、`.cafe` 查找 |
| `packages/daemon` | Daemon/Root、Registry、Router（rules / LLM）、Store、HTTP+WS 服务器、headless Barista supervisor |
| `packages/cli` | `cafe` 命令；`src/bridge/` 是 Codex / Claude Code Barista 的桥接，`src/mcp.ts` 是 `cafe mcp` |
| `packages/pi-extension` | pi 扩展：让 pi 成为 Barista（TUI 或 headless），并提供 `cafe_ask` 等工具 |
| `packages/web` | web UI（React 19 + Vite + Tailwind v4），构建后由 Daemon 托管 |
| `skills/cafe` | 给 Claude Code / Codex / pi 用的 skill |

## 开发

源码是 TS，直接靠 Node 的 type stripping 运行，无需编译。

```bash
npm install
npm run typecheck
npm test                     # vitest：多 daemon 端到端测试（假 barista、假 LLM）
npm run build:web            # 构建 web UI → packages/web/dist

npm link --workspace @cafe/cli    # 可选：把 `cafe` 装到 PATH
cafe daemon start --root
cafe barista start --dir ~/code/some-repo
cafe ask "这个问题谁懂？"
open http://127.0.0.1:4777/
```

### 升级已有的源码安装

Daemon 是长进程：`npm run build:web` **不会**让正在运行的 Daemon 切到新代码。更新文件后必须重启：

```bash
git pull
source ~/.bash_profile          # Node ≥ 22.18（nvm）；直接 ssh 登录可能还是 Node 18
npm install
npm run build:web
npm link --workspace @cafe/cli
cafe daemon restart             # 必须：构建不会自动重载 daemon
cafe extension install --agent pi
cafe extension install --agent omp   # 可选；omp install 是 omp plugin install 的别名
cafe daemon status              # version 应与 package.json 一致
cafe status                     # 一屏看 daemon / router / pending 配置
cafe doctor
```

换 Node 版本（或移动仓库）后，`cafe daemon install`、`cafe mcp install`、`cafe claude install` 记录的绝对路径会失效，需要重跑。容器或 NAT 里要把 `advertise` 设成 Root 能访问的地址。正在运行的 pi / omp 会话要重启宿主才会加载新扩展。

发布（维护者）：`npm version <x.y.z>` → `npm run test:release`（打包、装到临时目录并冒烟测试，不调用模型）→ `npm publish ./release`。见 [`docs/specs/v2-7-publishing.md`](docs/specs/v2-7-publishing.md)。

## oh-my-pi

同一个 pi 扩展也能在 oh-my-pi（omp）里用：`cafe extension install --agent omp`，headless 用 `cafe barista start --dir <dir> --agent omp`。差异处理见 [`docs/specs/v2-6-oh-my-pi.md`](docs/specs/v2-6-oh-my-pi.md)。
