# v2-7 可发布的 npm 包

状态：**已实现，未发布**（2026-11-19）。Q60–Q64 按推荐执行，包名按用户决定为 `@blrbiran/cafe`（Q65 先选了 `agent-cafe`，后改为用户自己的 scope）。发布本身由用户执行。

## 决定

| 编号 | 决定 |
|---|---|
| Q60/Q65 | 包名 `@blrbiran/cafe`（用户 npm 账号 blrbiran 的 scope）；命令名仍是 `cafe`。可用 `CAFE_PACKAGE_NAME` 覆盖 |
| Q61 | 只发一个包：cli + daemon + protocol + pi 扩展 + 构建好的 web + skill |
| Q62 | esbuild 打包；仓库内开发仍直接跑 `.ts` |
| Q63 | `skills/cafe/` 打进包里，`cafe skill install` 链接包内路径 |
| Q64 | 手动发布：`npm version` + `npm publish`，不做 CI |

## 包内布局

`npm run release:build` 生成 `release/`（不入库）：

| 路径 | 内容 |
|---|---|
| `bin/cafe.js` | 过滤 sqlite 的 ExperimentalWarning，再加载 `dist/cli.js` |
| `dist/cli.js` | cli + daemon + protocol，npm 依赖全部打进去（ws 的可选原生模块除外） |
| `dist/pi-extension.js` | pi / omp 扩展；`@earendil-works/*`、`typebox` 不打包，由 pi / omp 加载扩展时提供 |
| `dist/proc/guard.mjs` | 原样复制 |
| `web/` | web 构建产物 |
| `skills/cafe/` | skill |

`package.json` 里 `pi.extensions` 指向 `dist/pi-extension.js`，`publishConfig.access` 为 `public`（scoped 包默认私有）。

`@earendil-works/pi-coding-agent` 是 **optionalDependency**：只有配置了 `router.model` 才需要；装不上时自动退回规则路由。

## 路径查找（先找打包布局，再回退到仓库）

| 查找 | 顺序 |
|---|---|
| daemon → pi 扩展 | `CAFE_PI_EXTENSION` → `dist/pi-extension.js`（与 `dist/cli.js` 同目录）→ `@cafe/pi-extension` → 仓库路径 |
| daemon → web | `../web/index.html`（相对 `dist/`）→ `@cafe/web` → 仓库路径 |
| pi 扩展 → cli | `../bin/cafe.js`（相对 `dist/`）→ `@cafe/cli` → 仓库路径 |
| cli → skill | `../skills/cafe` → 仓库 `skills/cafe` |
| `cafe --version` | 包内 `package.json` → 仓库根 `package.json` |

新命令 `cafe pi-extension-path` 打印扩展路径，用法 `pi -e "$(cafe pi-extension-path)"`。

## 发布流程

```bash
npm version 0.1.1           # 改根 package.json 并打 tag
npm run release:pack        # 构建 web + 打包 → release/，tarball → release-out/
tar tzf release-out/*.tgz   # 看内容
npm publish ./release       # 需要已 npm login
```

## 已验证（2026-11-19）

`npm pack` 得到 11 个文件（含 LICENSE）、352 kB。在临时 prefix 里 `npm i -g` 后，用临时 `CAFE_HOME` 验证：`--version`、`pi-extension-path`、daemon 启动并托管 web、`cafe serve` 问答、headless pi 用打包后的扩展注册为 Barista、`skill install`（临时 HOME）、配置 `router.model` 时从可选依赖加载 LLM 路由。均未调用模型。

## 后续决定

- Q69：MIT（根目录 `LICENSE`，根 `package.json#license`，构建时带进包里）。
- Q70：`@earendil-works/pi-coding-agent` 保留为 optionalDependency。
