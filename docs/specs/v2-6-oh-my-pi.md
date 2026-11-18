# v2-6 oh-my-pi（omp）作为 Barista

状态：已实现并经用户同意（2026-11-19）。真实 omp 18.17.0 已验证：加载扩展并注册为 Barista；headless 问答、追问回到同一个 Barista、TUI 中注入的 Order 显示为 `☕ Order from …` 并在原处作答（模型 magpie/group/never-stuck，约 $0.11）。

## 结论

同一个 `packages/pi-extension/src/index.ts` 同时用于 pi 和 omp，不另写适配文件。omp 通过 Bun 加载钩子把 `@earendil-works/pi-coding-agent` / `pi-tui` / `typebox` 映射到自己的实现，并且认 `package.json#pi.extensions`。

## 运行时差异与处理

| 差异 | 处理 |
|---|---|
| omp 没有 `agent_settled` | omp 下改听 `agent_end`，`willContinue` 为真时跳过；是否中止看最后一条 assistant 消息的 `stopReason === "aborted"` |
| `before_agent_start` 事件里没有 `systemPromptOptions.sections`，而是 `systemPrompt: string[]` | 有 sections 就写 sections，否则返回 `{ systemPrompt: [...原有, cafe 说明] }`。omp 只在用户 prompt 前触发它，所以 Order 正文里本来就带的答题说明照旧保留 |
| `process.execPath` 是 omp 二进制 | 自动拉起 daemon 时，在 Bun 下改用 `node`（可用 `CAFE_NODE` 指定） |
| `deliverAs: "aside"` | 不用：它会把 Order 插进人正在进行的 run，回复会混入人的工作内容。继续用 `followUp` + 等空闲 |

判断是否在 omp 下：`process.versions.bun`，可用 `CAFE_HOST_AGENT=pi|omp` 强制。

## 用法

- 交互：`omp -e <cafe>/packages/pi-extension/src/index.ts`，或在 omp 配置的 `extensions` 列表里加入该路径。
- headless：`cafe barista start --dir <dir> --agent omp`（守护进程用 `omp --mode rpc --no-session -e <ext>` 启动；每个 Barista 可以单独指定，持久化在 baristas.json）。全局默认仍是 `CAFE_PI_BIN`，未设为 `pi`。
