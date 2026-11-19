# v3-2 标出每个 Agent 是哪种 agent

状态（2026-11-19）：Q81–Q83 按推荐通过，已实现。原型：https://claude.ai/artifact/X3F3dx2PtBQf3R5HwsiRL5

## 为什么

注册信息里只有 `mode`（tui / headless / cli / web），没有"是谁在跑"。网页把 `headless` 写成"后台 pi（无人值守）"，所以后台的 Codex / Claude Barista 被标成 pi，oh-my-pi 的终端被标成"终端里的 pi"，`cafe serve` 一律是"命令行"。用户想一眼看出每个 Barista（以及每个回答）出自哪种 agent。

## 决定

- **Q81 A**：Agents 卡片名字旁加种类标签（pi / oh-my-pi / Codex / Claude Code / 命令）；"运行方式"一行写全：怎么跑 · 权限。可改文件用警示色。
- **Q82 A**：对话页"交给了"和回答署名旁加同样的标签；查不到 Agent（已清理）时不显示。
- **Q83 A**：先不显示模型。

## 协议

`AgentIdentity` 加三个可选字段（旧 daemon 用 zod 解析时会丢掉，不影响连接；旧客户端不报，网页就不显示标签）。三个字段都只是普通字符串，不用 enum 也不限长度，这样以后的新取值也能在旧 daemon 上注册；长度由客户端截断：

| 字段 | 值 | 谁报 |
|---|---|---|
| `agent` | `pi` \| `omp` \| `codex` \| `claude` \| `command`（字符串，未知值原样显示） | pi 扩展（`isOmp()` 决定 pi / omp）、Bridge、`cafe serve` |
| `access` | `read-only` \| `write` | 只有 Bridge 报（pi / omp / 命令不知道自己的权限，不报） |
| `command` | `cafe serve` 跑的命令，最多 80 字符 | 只有 `cafe serve` |

## 显示

| 启动方式 | 标签 | 运行方式 |
|---|---|---|
| pi 终端 + 扩展 | pi | 终端里（有人在用） |
| `cafe barista start`（默认 pi） | pi | 后台运行 |
| oh-my-pi 终端 / `--agent omp` | oh-my-pi | 终端里（有人在用） / 后台运行 |
| `--agent codex` / `--agent claude` | Codex / Claude Code | 后台运行 · 只读 / 可以改文件 |
| `cafe serve` | 命令 | 每题运行一次 `<命令>`，追问不带上下文 |
| 没报 `agent`（旧版本） | 不显示 | 后台运行 / 终端里（有人在用） / 命令行 / 网页 |

`cafe agents` 列表的 mode 列换成 `种类·权限`（如 `claude·ro`），没报种类时退回 mode。
