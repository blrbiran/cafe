# v2-7 可发布的 npm 包

状态：**部分完成，其余等用户决定**（2026-11-19）。

## 已做（不涉及决策）

包之间不再只靠仓库里的相对路径找彼此，先按包名解析，找不到再回退到原来的工作区路径：

| 位置 | 现在 |
|---|---|
| daemon → pi 扩展（supervisor 启动 headless pi 用） | `CAFE_PI_EXTENSION` → `import.meta.resolve("@cafe/pi-extension")` → `../../pi-extension/src/index.ts` |
| daemon → web 静态文件 | `@cafe/web/package.json` 所在目录的 `dist/` → `../../web/dist` |
| pi 扩展 → cli（自动拉起 daemon） | `import.meta.resolve("@cafe/cli")` → `../../cli/src/main.ts`（pi 用 jiti 加载时 `import.meta.resolve` 可能不存在，会走回退） |
| cli → skill（`cafe skill install`） | 仍是 `../../../skills/cafe`，见问题 Q63 |

## 等用户决定（编号接上次）

- **Q60 包名**：`@cafe/*` 在 npm 上大概率不属于你。推荐：先确认想用的 scope（例如你自己的 `@<你的 npm 用户名>/cafe-*`），或者发成一个不带 scope 的包（需查重名）。
- **Q61 发一个包还是多个**：推荐**一个包**（`cafe` CLI + daemon + protocol + pi 扩展 + 构建好的 web），用户只需 `npm i -g <名字>`；pi 扩展用 `pi -e $(npm root -g)/<名字>/pi-extension.js` 或 `cafe pi-extension-path` 打印路径。多包只在别人要单独用 protocol/client 时才有价值。
- **Q62 构建**：Node 不对 `node_modules` 下的 `.ts` 做类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），所以发布物必须是 JS。推荐用 esbuild 打成几个 ESM 文件（cli、pi 扩展、guard.mjs 原样复制），`node:sqlite` 等内置模块和 `@earendil-works/*` 作为 external；仓库内开发仍直接跑 `.ts`。
- **Q63 skill 放哪**：推荐把 `skills/cafe/` 一起打进包里，`cafe skill install` 从包内路径链接。
- **Q64 版本与发布流程**：推荐手动 `npm version` + `npm publish`，暂不做 CI 自动发布。

确认后再做：esbuild 脚本、`files` 白名单、`bin`、发布前 `npm pack` 检查内容、在干净目录 `npm i -g ./<tgz>` 后跑一遍冒烟测试。
