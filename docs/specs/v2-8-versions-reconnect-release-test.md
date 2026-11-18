# v2-8 版本兼容、本机重连、发布包自测

状态：已实现（2026-11-19）。用户选了 handoff 建议里的 1、2、6；界面按原型 Q71 的推荐 A 实现（用户不在场时按推荐执行，待审核）。

## 1. 版本兼容

发布以后，各台机器可能装着不同版本。

| 情况 | 行为 |
|---|---|
| 协议版本（`PROTOCOL_VERSION`）不同 | `initialize` 直接拒绝，错误码 `protocol_mismatch`，消息写明双方 host、cafe 版本、协议号和升级命令（`npm i -g @blrbiran/cafe@<对方版本>`）。被拒的子节点在日志里反复出现 `root handshake failed: …` 直到升级 |
| 协议相同、cafe 版本不同 | 照常连接。Root 日志记一行；`cafe daemon status` 列出各机器版本并警告；网络页每台机器多一行「版本」，顶部出现提示条，和中心节点版本不同的机器标橙色 |

实现：
- `InitializeParams.cafeVersion`、`DaemonRecord.version`（都可选，旧版本没有时显示「未知（0.1.0 之前）」）。
- Daemon 的版本由 CLI 传入（`runDaemon({ version })`，来自 `cafe --version` 同一来源）；测试默认 `"dev"`。
- `/api/health` 带 `version`。
- `PROTOCOL_VERSION`、`DEFAULT_PORT`、`onlineVersions()` 放在不依赖 zod 的 `@cafe/protocol/version`，web 只从这里导入，避免把 zod 打进前端（曾因此从 274 kB 涨到 338 kB）。
- 原型：https://claude.ai/artifact/SVLEJhirFrxq7ugMipjeiZ

**以后改协议时**：只有不兼容的线协议改动才加 `PROTOCOL_VERSION`；新增可选字段不加。

## 2. 发布包自测

`npm run test:release`（`scripts/test-release.mjs`）：构建 `release/` → `npm pack` → 装到临时全局 prefix → 用临时 `CAFE_HOME` 和随机端口驱动安装后的 `cafe`。检查：tarball 内容（必须有的文件、不能有 `.ts`/`node_modules`/sourcemap）、`--version` 与包一致、`pi-extension-path`、daemon 启动、web 页面、`/api/health` 版本、`cafe serve` 问答、`skill install`（临时 HOME）、装了 pi 时 headless pi 用打包后的扩展注册、`daemon stop`。不调用模型，不碰 `~/.cafe`。

参数：`--skip-build` 复用现有 `release/`；`--with-optional` 同时安装可选依赖 pi-coding-agent 并检查 LLM 路由能加载（需要联网，约 40 MB）。

发布流程因此变为：`npm version x.y.z` → `npm run test:release` → `npm publish ./release`。

## 6. 本机重连等待上限

`CafeClient` 断线重连的等待时间按指数增长。上限原来一律 30 秒，现在连本机 daemon（`127.0.0.1` / `localhost` / `::1`）时是 5 秒，连其他机器仍是 30 秒；可用 `reconnectMaxMs` 覆盖。原因：本机 daemon 由 launchd 或 `cafe daemon start` 几秒内就能起来，pi TUI Barista 不该等半分钟才回来。web UI 自己的重连上限是 10 秒，没改。
