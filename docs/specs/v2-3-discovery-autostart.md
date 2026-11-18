# v2-3 局域网发现 + v2-4 开机自启

状态：已实现（2026-11-19）。用户不在场，设计问题按推荐答案先做，**待用户审核**（见文末）。

## 局域网发现（mDNS）

- Root 在局域网上应答 `_cafe._tcp.local` 的 PTR 查询，TXT 里带 `host=` 和 `addr=ip:port`（`advertise` 或第一个局域网 IPv4）。用 `multicast-dns` 包（纯 JS，依赖 dns-packet、thunky）。
- 没配 `root` 的子 Daemon 启动后每 15 s 查一次；**恰好找到一个** Root 就 `root set` 过去（写进 config.yml），找到多个就只在日志里列出，等用户 `cafe root set`。
- `cafe root discover [--timeout ms]` 列出局域网上的 Root。
- 只发现地址，**不发 token**：新机器仍需 `cafe config set token <Root 的 token>`，否则握手被拒（日志里是 `unauthorized`）。
- `discovery: false` 关闭（Root 不应答、子 Daemon 不查找）。环境变量 `CAFE_DISCOVERY=0` 同样关闭，测试默认用它，避免测试 Daemon 出现在真实局域网上；`CAFE_MDNS_SERVICE` 可改服务名。
- tailnet 一般不转发组播，跨 tailnet 仍需 `cafe root set`。

## 开机自启

- `cafe daemon install [--root] [--dry-run]`：macOS 写 `~/Library/LaunchAgents/dev.cafe.daemon.plist` 并 `launchctl bootstrap gui/<uid>`；Linux 写 `~/.config/systemd/user/cafe.service` 并 `systemctl --user enable --now`。其他平台报错并提示用 `cafe daemon start`。
- 只在崩溃后重启（launchd `KeepAlive.SuccessfulExit=false`，systemd `Restart=on-failure`），`cafe daemon stop` 是正常退出，不会被拉起。
- 服务里固定了当前的 `node` 绝对路径、`bin/cafe.js` 路径、`CAFE_HOME` 和安装时的 `PATH`（去重、去掉不存在的目录），这样 headless Barista 能找到 `pi` / `claude` / `codex`。**升级 Node（nvm 换版本）或移动仓库后要重新 `cafe daemon install`。**
- 安装前若已有手动启动的 daemon，会先让它退出再交给服务。
- `cafe daemon uninstall` 停止并删除服务文件。

## 待用户审核的默认选择

1. 发现默认开启（`discovery: true`）。
2. 多个 Root 时不自动选。
3. 只支持 macOS / Linux 的用户级服务，不做系统级服务。
4. 未在用户真实机器上执行过 `daemon install`（会改动 `~/Library/LaunchAgents` 并接管正在运行的 daemon），只校验了生成的 plist（`plutil -lint` 通过）。
