# cafe

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
          pi (TUI)  pi (rpc)  cafe CLI   pi (TUI)   Claude Code / Codex
          Barista   Barista   Customer   Barista    （通过 cafe skill 当 Customer）
```

- 每个 Host 一个 **Daemon**，监听单一端口（默认 4777），在该端口上提供 HTTP API、`/ws` WebSocket 与 web UI。
- 发起方所在的 Daemon 负责做 **Routing Decision**：配置了 `router.model` 时用 LLM（通过 pi SDK）决策，否则按关键词规则。Order 原文透传，不做改写。
- Root 在线时，所有 Order 都经 Root 中转（ADR-0001）。Root 离线时，同一 Host 内的 Order 照常投递，跨 Host 的 Order 直连目标 Daemon（ADR-0004）；连不上才返回 `root_unreachable`。Root 恢复后，离线期间的会话会补发给它。
- Registry 由 Root 复制到每个 Daemon（ADR-0002）。Thread 内容存放在 `~/.cafe/sessions/<date>/<threadId>.jsonl`，SQLite 里只存元数据（ADR-0003）。

## 包结构

| 包 | 作用 |
|---|---|
| `packages/protocol` | 线协议类型与 zod schema、`Peer`（请求/响应/通知）、`CafeClient`（agent 侧客户端）、`.cafe` 查找 |
| `packages/daemon` | Daemon/Root、Registry、Router（rules / LLM）、Store、HTTP+WS 服务器、headless Barista supervisor |
| `packages/cli` | `cafe` 命令 |
| `packages/pi-extension` | pi 扩展：让 pi 成为 Barista（TUI 或 headless），并提供 `cafe_ask` 等工具 |
| `packages/web` | web UI（React 19 + Vite + Tailwind v4），构建后由 Daemon 托管 |
| `skills/cafe` | 给 Claude Code / Codex / pi 用的 skill |

## 安装

需要 Node ≥ 22.18。

```bash
npm i -g @blrbiran/cafe          # 命令是 cafe
cafe daemon start --root          # 本机作为 Root（或 cafe daemon install --root：开机自启）
pi -e "$(cafe pi-extension-path)" # 让 pi / omp 接入
cafe skill install                # 给 Claude Code / Codex 装 skill
```

发布（维护者）：`npm version <x.y.z>` → `npm run test:release`（打包、装到临时目录并冒烟测试，不调用模型）→ `npm publish ./release`。见 [`docs/specs/v2-7-publishing.md`](docs/specs/v2-7-publishing.md) 和 [`docs/specs/v2-8-versions-reconnect-release-test.md`](docs/specs/v2-8-versions-reconnect-release-test.md)。

多台机器请装同一个版本：协议不兼容的版本会被拒绝连接，版本不同但兼容时 `cafe daemon status` 和网络页会提示。

## 开发

需要 Node ≥ 22.18。源码是 TS，直接靠 Node 的 type stripping 运行，无需编译。

```bash
npm install
npm run typecheck
npm test                     # vitest：多 daemon 端到端测试（假 barista、假 LLM）
npm run build:web            # 构建 web UI → packages/web/dist

npm link --workspace @cafe/cli    # 可选：把 `cafe` 装到 PATH
cafe daemon start --root          # 本机作为 Root
cafe barista start --dir ~/code/some-repo   # 用 headless pi 起一个 Barista（需要已安装 pi）
cafe ask "这个问题谁懂？"
open http://127.0.0.1:4777/
```

在 pi 里接入（TUI Barista）：

```bash
pi -e "$(cafe pi-extension-path)"     # 仓库里即 packages/pi-extension/src/index.ts
# 或在 ~/.pi/agent/settings.json 的 "extensions" 中加入该路径
```

让 Claude Code / Codex / 任意脚本当 Barista（每个问题跑一次命令，prompt 走 stdin，stdout 即回答，输出 `CAFE_DECLINE: 原因` 表示婉拒）：

```bash
cafe serve --preset claude --dir ~/code/billing    # 或 --preset codex，或 --exec "<任意命令>"
```

给 Claude Code / Codex 安装 skill：`cafe skill install`。它会创建软链 `~/.claude/skills/cafe` 和 `~/.agents/skills/cafe`。

## 配置

`~/.cafe/config.yml`（可用 `CAFE_HOME` 覆盖目录）：

```yaml
mode: daemon               # daemon | root
host: mac-mini
port: 4777
token: <shared token>      # 来自局域网的连接必须携带；来自 loopback 的连接免 token
root: 192.168.1.10:4777    # mode=daemon 时填写
router:
  model: anthropic/claude-haiku-4-5   # 走 pi 的 auth.json；不填则用规则路由
  fallback: rules          # rules | root（本地没有 LLM 时请 Root 代为路由）
  learn: true              # 参考最近 7 天的婉拒记录，在描述同样匹配的 Barista 之间排先后
discovery: true            # 局域网 mDNS：Root 应答，未配 root 的 Daemon 自动查找
retention:
  days: 90                 # 可选；不设则永不自动清理，用 `cafe prune --older-than N [--yes]` 手动清
```

路由主要看 Barista 的描述；`router.learn` 只是辅助：最近在类似问题上婉拒过的 Barista 会排到后面，但不会被排除，也不会盖过描述更匹配的 Barista。`cafe stats` 查看每个 Barista 最近 7 天回答、婉拒的次数和常婉拒的话题。详见 [`docs/specs/v2-1-routing-hints.md`](docs/specs/v2-1-routing-hints.md)。

`cafe root set <addr>` 和 `cafe config set <k> <v>` 会同时更新文件和正在运行的 Daemon。

同一局域网内，没配 `root` 的 Daemon 会通过 mDNS 自动找到 Root（只找到一个时才会自动连），`cafe root discover` 可手动查看；token 仍需手动设置。`cafe daemon install` 让 Daemon 开机自启、崩溃后自动重启（macOS launchd / Linux systemd --user），`cafe daemon uninstall` 撤销。详见 [`docs/specs/v2-3-discovery-autostart.md`](docs/specs/v2-3-discovery-autostart.md)。Root 换了 IP 后，启动时会主动回连 `knownDaemons` 中记录的各 Daemon，把新地址告诉它们。

## oh-my-pi

同一个 pi 扩展也能在 oh-my-pi（omp）里用：`omp -e packages/pi-extension/src/index.ts`，headless 用 `cafe barista start --dir <dir> --agent omp`。差异处理见 [`docs/specs/v2-6-oh-my-pi.md`](docs/specs/v2-6-oh-my-pi.md)。

## v1 范围外（已预留接口）

- Daemon 之间直连（P2P）、三级及以上层级、mDNS 自动发现
- oh-my-pi 扩展适配
- 开机自启（launchd）、Thread 数据清理、全文检索
