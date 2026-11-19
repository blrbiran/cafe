# v4-2 受控升级、重启与回滚

状态（2026-11-19）：spec 草案，来源 dogfooding #27。**只写 spec，不实现。** 待用户确认 Q1–Q5 后进入实现。

## 为什么

cafe 自己就挂在 cafe 网络上：维护 agent 收到一条 Order，改代码、跑测试、打包，然后需要让本机和其它机器的 daemon 用上新版本。今天只能手动 `npm i -g @blrbiran/cafe` + `cafe daemon stop/start`，没有 staging、健康检查、回滚，也没有“升级期间正在跑的 Order 怎么办”的约定。升级失败时可能留下半安装状态。

第一阶段的重点不是“全网自动升级”，而是**一台机器上的升级是受控的、可验证、可回滚的**。

## 目标与非目标

目标：

- 从本地 release tarball（或 npm 版本）升级一台 Host，升级前有 checksum 和协议兼容检查。
- 升级过程有 drain；正在执行的 Order 要么完成，要么明确标为可重试，不静默丢失。
- 新版本起不来时自动回到 last-known-good，并保留日志。
- 所有动作有结构化结果和审计记录（CLI + `cafe update status`）。

非目标（第一阶段不做）：

- 进程内热替换（HMR）。
- Root 自动向全网广播升级、canary、分批编排。
- 代码签名 / 供应链 attestation。
- 自动从 npm 拉取并无人值守升级（可用 `--version` 显式触发，但默认不自动）。

## 当前代码事实

- `runDaemon()` 在进程启动时读取配置并创建 Daemon；没有模块重载。
- Web 静态资源在 `startServer()` 时读入内存；重新 `build:web` 后必须重启。
- `POST /api/reload` 只处理 router/root，不重载代码或 Web 资源。
- `cafe daemon install` 只生成 launchd/systemd 服务，负责崩溃重启，没有版本管理。
- `DaemonRecord.version` 只用于显示版本差异；同协议不同 cafe 版本只 warning。
- 没有 updater、staging 目录、原子切换、健康检查和回滚。
- `recover()` 只恢复 origin 侧未完成的 Thread；Barista 侧重启后依赖重新连上。

## 方案比较

### A. 独立 updater + releases 目录 + 原子切换（建议）

```
~/.cafe/releases/<version>/       解包后的发布包
~/.cafe/current -> releases/<v>   符号链接
~/.cafe/update.json               current / lastGood / pending / log
```

`cafe update apply` 由 CLI（不是 daemon 进程自己）执行：校验 → staging → drain → stop → 切换 current → start → 健康检查 → 失败切回 lastGood。CLI 天然独立于 daemon，避免“自己替换正在运行的自己”。release 包已经由 `scripts/build-release.mjs` 生成，路径和 `files` 都稳定。

### B. 包装 `npm i -g`（不推荐作为主路径）

直接跑 `npm i -g @blrbiran/cafe@x`，再重启 daemon。实现最少，但没有原子切换、没有 last-known-good、失败时 npm 可能留下混合的全局包；离线/内网也不可用。可作为 `--version` 时的下载步骤，最终仍落到 A 的 releases 目录。

### C. 进程内重载（拒绝）

Node 没有可靠的模块热替换；daemon、CLI、Web 资源、pi extension 都绑定进程生命周期。目标应定义为“滚动升级 / 无缝重启”，不是 HMR。

**建议 A。**

## 设计（方案 A）

### 1. 命令

```bash
cafe update check                  # 当前版本、可用版本、协议兼容性
cafe update status                 # current / lastGood / pending / 最近一次结果
cafe update apply --file <tgz>     # 从本地 release 包升级（离线可用）
cafe update apply --version <x>    # 从 npm 下载后走同一条 apply 路径
cafe update rollback               # 回到 lastGood
cafe daemon drain --timeout <s>    # 等待正在执行的 Order，停止接收新 Order
cafe daemon restart                # 已有；升级 apply 内部复用它
```

所有命令支持 `--json`；`apply` / `rollback` 返回：

```ts
{
  ok: boolean;
  from: string;
  to: string;
  switched: boolean;
  health: { ok: boolean; version?: string; error?: string };
  rolledBack: boolean;
  drained: { waitedMs: number; openThreads: number; retryable: string[] };
}
```

### 2. 文件布局与状态

```
~/.cafe/releases/<version>/        解包目录（只读）
~/.cafe/current -> releases/<v>    daemon 启动时用 current 里的代码
~/.cafe/update.json                { current, lastGood, pending, updatedAt, log: [...] }
~/.cafe/update.lock                并发升级锁
```

- `current` 是符号链接；daemon 的 autostart 服务执行 `node <current>/dist/cli.js daemon start`，因此切换链接即切换版本。
- 升级器每次只写临时目录，成功后 `rename` 成 `releases/<version>`，再原子替换 `current`。
- `lastGood` 只在健康检查通过后更新。

### 3. apply 流程

1. 取锁；如果已有升级进行中，`update_busy`。
2. 校验包：`package.json` 的 `name === "@blrbiran/cafe"`、版本合法、协议版本兼容、文件清单包含 `dist/cli.js` 和 `web/index.html`；有 checksum 时校验。
3. 解包到 `releases/.staging-<ulid>/`，校验后 rename 到 `releases/<version>/`。
4. `cafe daemon drain --timeout 30`：停止接受新 Order，等待 origin 侧未完成的 Thread 关闭；超时的 Order 记录为可重试并返回列表。
5. 记录 `pending`，停止 daemon（launchd/systemd 不会在手动 stop 后自动拉起）。
6. 原子切换 `current`；启动 daemon；轮询 `/api/health`（带版本）最多 30s。
7. 健康检查通过：`lastGood = 新版本`，清 `pending`，输出 `ok: true`。
8. 失败：切回旧链接，重启，确认旧版本健康；输出 `rolledBack: true` 和日志路径。升级期间不删除旧 release。

### 4. drain 的语义

- `draining` 状态下 `/api/orders` 返回 `daemon_draining`；已有 Thread 的 follow-up 也拒绝。
- 只等待 **origin 在本机** 的未完成 Order；Barista 侧正在执行的 Order 不可能 drain（它由另一个 daemon 跟踪），daemon 停止时按现有 `unavailable` 路径失败，并在 `update status` 里列出 threadId，便于重试。
- `--timeout` 到期后不阻塞升级，返回 `retryable: [threadId…]`。
- 不引入新的维护协议；drain 是本机状态。

### 5. 健康检查

- `/api/health` 已返回 version、router、host、isRoot；升级后必须版本等于目标版本。
- 额外检查：`/api/snapshot` 能返回、registry 连接数不为 0（Root）、Root 连接恢复（child，最多等 10s）。
- 失败定义：进程退出、30s 内没有健康响应、版本不符、Root/child 连接在 10s 内未恢复。

### 6. 权限与安全

- `cafe update apply/rollback` 默认只允许本机 loopback + 文件系统权限；不接受通过 Order 自动触发。
- 来自 Web/聊天 connector 的请求不能直接升级；必须由人执行 CLI 或显式审批。
- checksum 可选（`--sha256`）；没有 checksum 时打印警告。
- 升级器不执行 release 包里的任意脚本；只运行 `dist/cli.js`。

### 7. 与 autostart 的关系

- `cafe daemon install` 生成的服务指向 `~/.cafe/current/dist/cli.js`，而不是某个具体 release 路径。
- 已安装的旧服务可能指向旧路径：`cafe update apply` 检测到后提示重新运行 `cafe daemon install`，或自动更新 plist/unit 中的路径。
- 不使用 autostart 的机器（前台 `cafe daemon start`）升级后由 apply 自己拉起。

## 验收判据

- 维护 agent 通过 cafe thread 收到任务，改代码、构建 release、`cafe update apply --file` 成功；`/api/health` 返回新版本，Web 加载新构建，Agents/Root 连接自动恢复。
- 升级前有未完成 Order：drain 等待；超时的 thread 出现在 `retryable`，不是静默消失。
- 故意让新版本启动失败：自动切回 lastGood，旧版本恢复服务，`update status` 能看到失败原因。
- checksum 错误、协议不兼容、并发升级、包名不对分别有明确错误，且不留下半安装状态。
- `cafe update rollback` 在任意时刻能回到 lastGood。
- 升级失败后旧 release 和日志仍在。
- `cafe daemon install` 生成的服务指向 `current`；升级后无需手动改服务文件。

## 待用户确认

- **Q1**：第一阶段是否接受“升级时短暂停机 + drain”？还是要求先做双进程/端口热切换？（建议：接受短暂停机。）
- **Q2**：`cafe update apply --version` 从 npm 下载是否是第一阶段目标，还是只支持 `--file`？（建议：先 `--file`，`--version` 复用下载后走同一路径。）
- **Q3**：checksum 是必填还是可选？（建议：可选 + 警告；签名留第二阶段。）
- **Q4**：是否需要 Web 也提供“检查更新/升级”按钮？（建议：第一阶段只做 CLI；Web 只显示版本和 `update status`。）
- **Q5**：升级失败后是否自动回滚并重启，还是只回滚、等人确认？（建议：自动回滚并重启，结果写进 `update.json` 和日志。）