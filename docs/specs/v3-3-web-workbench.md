# v3-3 Web 工作台：固定 Shell、紧凑列表、详情抽屉、设置

状态（2026-11-19）：Q101–Q107 已定；**已实现**（Web 工作台、Agents 侧栏、设置抽屉、实况、`cafe tail`、Claude 插件 `/cafe` 冲突回退）。

原型：[`docs/prototypes/web-workbench-2026-11-19.html`](../prototypes/web-workbench-2026-11-19.html)
截图：[`output/playwright/`](../../output/playwright/)（1440 / 1920 / 3440 / 390、设置、实况、浅色）

需求来源：dogfooding 台账 #10、#18、#19、#21、#22、#23、#24、#26、#30、#33。

## 为什么

现在 Web 是只读仪表盘，且是整页跳转：左侧导航会随长对话一起滚动，Feed 卡片像详情预览（一屏 3–5 条），点开对话会卸载列表、丢失滚动位置，所有配置动作都要回 CLI。用户预期的是一个可以常驻、快速扫读、就地操作的工作台。

## 目标

- 桌面端固定满高：导航和列表不动，只有内容区独立滚动；Language/Theme 常驻导航底部。
- Feed 一屏 10–12 条；整卡可点；保留 from、时间、轮次、状态、耗时、回答者、一行回答、回复数。
- 宽屏列表常驻 + 右侧详情；≥1600 三栏并列，900–1599 右侧抽屉覆盖（宽度 780px），<900 整页。
- 导航里的 Agents 可以展开成侧栏子列表，直接看到已注册 agent 的状态、名字、种类、地址；「查看全部 Agents」仍打开完整页。
- 设置抽屉：改名/别名、LLM 模型、Barista 列表与停止；写操作有成功/失败/重启提示。
- 新增 `cafe tail` 和 Web「实况」页，默认隐藏心跳。
- 修掉并行测试 flake（#6）。

## 非目标

- 不重做品牌/配色/字体；沿用现有 token 和 zh/en。
- 不在 Web 里做 token 轮换、升级、任意 shell、启动新 Barista（启动下一版）。
- 不做附件（#20）、通用 connector SDK（#28）、update apply/rollback（#27）。
- 不做完整 SQLite 事件表/FTS 和虚拟列表；本轮只做 Web 分页读取与 tick 收尾。
- 不改 Order 立即处理的语义，不恢复 confirm。

## 决定

- **Q101 A**：本轮做 UI + `cafe tail` + 测试 flake；服务端分页/规模优化下一轮。
- **Q102 A**：先本地原型，确认后改真实代码。
- **Q103 A**：列表常驻 + 右侧抽屉（900–1599 宽度 780px）；≥1600 并列分栏；窄屏整页。
- **Q104 A**：设置抽屉 = 改名/别名 + LLM 模型 + Barista 列表/停止。
- **Q105 A**：#14 先做离线 fake-model harness，真实模型抽样每次单独征求同意。
- **Q106 B**：≥2200px 时详情右侧加 280px 信息栏（状态/参与/路由/Thread ID/投递过程）。
- **Q107 A**：#14 本轮不做。

## 布局

```text
< 900px                         900–1599px                      ≥1600px
┌──────────────┐                ┌────┬──────────┬────────┐      ┌────┬──────┬──────────────┐
│ 顶部导航       │                │导航 │ 列表      │ 抽屉    │      │导航 │ 列表  │ 详情（并列）   │
│ 内容整页滚动   │                │满高 │ 常驻      │ 覆盖    │      │满高 │ 680px │ 剩余宽度      │
└──────────────┘                └────┴──────────┴────────┘      └────┴──────┴──────────────┘
```

- Shell：`h-dvh overflow-hidden`；`nav` 固定宽度、独立滚动；`main` 独立滚动。
- 内容宽度：Feed/Agents/Network 在 ≥1600 时 1360px、≥2000 时 1560px；详情正文最大约 820px，不拉满带鱼屏。
- 详情在 900–1599 覆盖右侧（780px），左侧列表仍可见；≥1600 时 `main` 让出详情宽度，列表和详情并列；≥2200 详情内部再分主列 + 280px 信息栏。
- 移动端导航变成顶部横条，设置入口保留在横条右侧；Agents 下拉以浮层展开；详情全屏。

## 导航

- 问答 / 网络 / 实况是页面切换。
- Agents 是展开项：点击后在导航里列出已注册 agent（状态点、名字、种类标签、Address、空闲/忙碌），底部「查看全部 Agents →」打开完整 Agents 页。
- 展开状态在切换页面后保留还是收起：默认收起，避免长期占高；移动端以浮层展示。

## Feed 卡片

- 整卡点击/Enter/Space 打开详情；`cursor: pointer`、focus ring；去掉 “Open conversation” 链接。
- 第一行：`from · 提问 · 相对时间 · N 轮` 在左，`状态 pill · 耗时` 在右。
- 标题最多 2 行（line-clamp），回答预览只留 1 行，`+N 个回答` 内联。
- padding 10–13px，卡片间距 8px，默认高度约 78–96px。
- 进行中卡片保留路由原因，但只在 hover title / 详情中显示，避免撑高。

## 详情抽屉

- 路由仍是 `#/threads/<id>`；桌面打开抽屉，移动端整页；直接访问 URL 可用。
- Esc / 关闭按钮 / 点击遮罩关闭；浏览器 Back 关闭；关闭后焦点回到触发卡片，列表滚动位置不变。
- 顶部 sticky：关闭、Thread id、状态、复制；正文上方是紧凑 context（状态/参与/轮次/路由）。
- 回答、追问、停止等待、投递过程保持现有语义与文案。
- 追问 composer 固定在抽屉底部；移动端同样固定。

## 设置抽屉

| 区块 | 动作 | 接口 |
|---|---|---|
| 这台机器 | 改显示名、增删别名 | `POST /api/host {displayName, aliases}` |
| 网络（Root） | 远程 Daemon 改名 | `POST /api/hosts/rename {host, displayName}` |
| 路由模型 | 列出模型、应用/清空、显示运行态 | `GET /api/router/models`、`POST /api/router {model}` |
| Agents | 改名、加别名 | `POST /api/agents/rename {address, displayName \| alias}` |
| 后台 Baristas | 列出、停止 | `GET /api/baristas`、`DELETE /api/baristas?dir=` |

- 写操作成功后显示实际运行态；失败显示可操作错误。
- 远端操作不可用时按钮置灰并说明原因（例如“只有中心节点能给其他机器改名”）。
- 需要重启的配置显示 `saved; restart required: cafe daemon restart`。

## 后端新增

1. `GET /api/router/models?search=` → `{ models: string[] }`，复用 `listRouterModels()`；结果缓存 60s，避免每次打开设置都初始化 pi。
2. `POST /api/router {model}`：
   - `null` / `""`：写空 `router.model`，`initRouter()` 切回 rules。
   - 其他：保存旧值，写新值，`initRouter()`；失败回滚旧值并重新初始化，返回 `{ok:false, router, model, error}`。
   - 成功返回 `{ok:true, router, model}`。
3. `GET /api/events` SSE：订阅 daemon 的 `thread` 事件，支持 `host`、`type`、`thread` 过滤；默认不推心跳；15s ping；`Last-Event-ID` 只补之后的页（本轮先支持从连接时刻开始，分页下一轮）。
4. `cafe tail [--host] [--type] [--thread] [--json]`：连接上面的 SSE，人类模式一行一条；`--json` 输出 JSONL；Ctrl-C 退出。

## 前端实现

- `Shell.tsx`：满高、独立滚动、响应式导航；新增「实况」和「设置」入口。
- `App.tsx`：`thread` 路由时同时渲染 `FeedPage`（保持挂载）和 `ConversationPage` 抽屉。
- `Feed.tsx`：紧凑卡片、整卡点击、去重复入口。
- `Conversation.tsx`：抽屉头部/关闭、focus 返回；移动端保留返回链接。
- 新 `ui/SettingsDrawer.tsx`、`pages/Live.tsx`。
- `store.ts`：切路由时保留列表；`Live` 用有界事件数组（最多 300 条，按 eventId 去重）；`useNow` 只在活跃卡片/活跃对话启用 1s tick。
- `api.ts`：新增上面的 daemon 方法。
- `i18n.ts`：zh/en 补齐新文案；不引入新的术语。
- `index.css`：新增 `clamp2`、抽屉/三栏/实况行所需的最小 utility；能复用现有 token 的不新增颜色。

## 验证

- `npm run typecheck`、`npm test` 跑两遍、`npm run test:claude-plugin`、`npm run check --workspace @cafe/web && npm run build:web`。
- 真实浏览器截图：390 / 900 / 1440 / 1920 / 3440；Feed、详情、设置、实况、浅色；检查无横向滚动、无双滚动条、焦点返回、Esc/Back。
- 新增测试：`POST /api/router` 的清空/切换/失败回滚；`/api/router/models` 形状（mock ModelRuntime）；`/api/events` 过滤与心跳隐藏；`cafe tail --json` 逐行可解析。
- #6：连续 5 次 `npm test`；bridge/codex-tui 改用 `waitFor` 或独立端口。
- 改完 daemon/web 后重启用户 daemon（launchd），再在浏览器确认。
- 打包/路径未改，不跑 `test:release`。

## 风险

- 抽屉打开时 Feed 保持挂载，渲染量增加；紧凑卡片 + `memo` + 粗粒度 tick 控制。
- 设置写操作涉及配置；所有错误必须回显，不允许静默成功。
- 详情并列后正文仍限制阅读宽度，避免带鱼屏行宽过长。
- 旧 daemon 没有 `displayName`/`aliases` 时回退到 `host`/`name`（协议字段已可选）。