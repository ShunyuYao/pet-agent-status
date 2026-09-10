# pet-agent-status

桌宠（吐梨邦）插件：把本机 **Claude Code / Codex** 会话状态实时显示在桌宠上——
插件面板里看多会话列表，任务完成/等待批准时宠物用动画和气泡提醒你，点击会话行一键跳回对应终端。

- 状态来源：Claude Code / Codex CLI 官方 hooks → 本机状态文件（协议见 `PROTOCOL.md`）
- UI 规格：`DESIGN.md`（Figma 同源）
- 安装：宿主设置页「插件 → 手动安装」选择本仓库目录（开发者模式），或等市场上架

## 权限披露（nodeAccess）

本插件按桌宠插件平台的 **nodeAccess 声明披露制** 使用以下 Node 内建能力，除此之外只经 `pet.*` SDK：

| 能力 | 用途 | 范围 |
|---|---|---|
| `fs` 读写 `~/.local/state/pet-agent-status/` | 读取会话状态文件（本插件 hooks 自己写入的数据） | 仅该目录 |
| `fs` 读写 `~/.claude/settings.json`、`~/.codex/hooks.json` | 「一键接入/移除钩子」时合并写入 hooks 条目，写前自动备份 | 仅接入/卸载动作时；不碰 Codex 的 `hooks.state` 信任文件 |
| `child_process` spawn `ps` | 按会话的 tty 反查它属于哪个终端 App（决定这一行能否跳转） | 只读进程表，10 秒缓存 |
| `child_process` spawn `osascript` | 点击会话行时聚焦 iTerm2 / Terminal.app 对应窗口标签页 | 仅跳转动作时 |

**不采集也不上传任何对话内容**；状态文件只含任务标识、目录名、状态与时间戳。
无遥测、无自更新、无远程资源。

## 开发

纯 JS、Node 22+、零构建。测试全部离线：`for t in tests/*-test.js; do node "$t"; done`。
协作规则见 `AGENTS.md`。自治开发循环（Ralph）：`./scripts/ralph/ralph.sh --phase all 10`
（需 `RALPH_SKIP_APP=1`，本仓库 verify 不起 Electron）。

## License

MIT
