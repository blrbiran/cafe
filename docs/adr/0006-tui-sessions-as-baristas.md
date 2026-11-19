# 正在使用的 Claude Code / Codex 终端会话当 Barista：Claude 用 mod，Codex 用会话队列

v3-1 第二阶段（Q84–Q88，2026-11-19）。目标和 pi 扩展一样：问题在会话空闲时进入用户正在用的终端会话，那一轮的最终回答就是 Reply，用户在终端里看得到问题和回答。

## 决定

1. **Claude Code 用 mod，不用 channels。** cafe 提供一个 Claude Code 插件（`claude-plugin/`，`cafe claude install` 用户级安装）。mod 在每个交互式会话里启动子进程 `cafe session-host`，由它注册身份、接 Order、心跳；mod 用 `$.prompt.submit` 提交（会话空闲时才开始新的一轮），用 Order 里的标记行（`[cafe order <id>]`）在 `turn.start` 认出那一轮，在 `turn.complete` 取 `answer`；取消用 `$.turn.abort`。两边通过 session-host 的 stdout（JSON 行）和它的 Unix socket（HTTP）通信。channels 是研究预览，要每次加 dangerous 参数，忙时会合并事件，也没有结束信号，所以不用。
2. **自动加入，可暂停**（Q85 A）：装了插件后，目录里有 Barista `.cafe` 的交互式会话自动成为 Barista（`mode: tui`，`agent: claude`）；`-p` 和 SDK 会话不加入；`/cafe off` / `/cafe on` 暂停、恢复（暂停时离开网络）。
3. **Codex 用会话队列**（Q86 A）：`cafe barista start --dir <dir> --agent codex --tui [--thread <id>]` 起一个受托管的桥接进程（一个进程，不管 concurrency）。每个问题用自己的 `codex app-server` 调 `thread/queue/add` 放进该目录最近活动的 Codex 会话，Codex 在空闲时开始，TUI 显示它。结果从 `thread/turns/list` 读，按 `clientUserMessageId` 对上。我们的 app-server 不加载那个会话，所以不会自己跑这一轮。这条路不依赖共享 app-server 守护进程（cmux 包装和 `-c` 参数会让 TUI 用内置服务，它每几秒检查一次队列）。
4. **权限沿用会话自己的**（Q87 A）：cafe 发起的这一轮和用户自己输入的一样，审批在终端里由人处理，Barista 从不回答审批请求。网页显示"终端里（有人在用）"，不标只读。
5. **120 秒没开始就撤回**：会话忙、被打断后暂停、或已关闭时，Order 以"暂时不可用"婉拒；Codex 队列里的那条同时删除，避免以后会话加载时再跑。

## Consequences

- 用户在终端按 Esc 打断一轮后，Claude（mod 提交被拒）和 Codex（队列暂停派发）都要等用户发下一条消息才继续接 cafe 的问题；期间到达的问题 120 秒后婉拒。
- Codex：开始后无法从外部打断（那一轮在 TUI 的进程里），取消只撤回还没开始的问题，已开始的照常跑完，回答丢弃。另一进程读到的 `interrupted` 且没有 `completedAt` 表示还在跑。
- Codex：没有"TUI 当前打开的是哪个会话"的接口，默认取该目录最近活动的非临时会话，不对时用 `--thread` 指定。
- 都依赖较新的接口：Claude mods（v2.1.287+，变化快），Codex `thread/queue/*`（实验接口，需要 `experimentalApi`）。升级后先跑免费检查（见 spec）。
