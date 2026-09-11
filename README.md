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
| `child_process` spawn `open` | 点击 Codex App 任务时经 `codex://threads/<id>` 深链接跳转 | 仅跳转动作时 |
| `net` 连接 `~/.codex/ipc/ipc.sock` | Codex App 实时增强（**默认开，面板设置里可关**）：只读监听任务动态与跟随状态 | 开关打开时（默认）；故障自动停用 |
| `fs`/`node:sqlite` **只读** `~/.codex/sqlite/codex-dev.db`、`~/.codex/session_index.jsonl` | 会话行显示 Codex 自己生成的线程标题 | 只读，30s 缓存；读不到自动降级为目录名 |

另使用宿主 SDK：`storage`（含实验开关持久化）`pet`（bubble/playAnim/speak）`pet.badge`
（宠物脚下折叠徽标，需宿主 ≥0.19.0，老宿主自动降级）`ui`（面板开关）`events` `scheduler`。

### Codex App 实时增强（默认开，实验；面板 ⚙ 设置里可关）

连接 Codex App 的本地 IPC（`~/.codex/ipc/ipc.sock`，仅当前用户可访问）**只读监听**，做两件事：
① 把 App 里的任务摄入为面板会话行（提交 → 运行中；回合完成 → 已完成；映射表冻结在
`PROTOCOL.md`，只映射实录确认过语义的事件，绝不误报完成）；② 感知你正在 App 里跟随哪个
任务，让宠物聚焦它。该接口未获官方稳定性承诺，任何异常都会自动停用并退回默认的钩子通道。
点击 Codex App 任务行时经系统 `open codex://threads/<id>` 跳转（只接受 UUID 形态的任务 id）。
实测事实见 `fixtures/codex-ipc-facts.md`。

**不上传任何数据**；状态文件只含任务标识、目录名、状态、时间戳与**会话标题**——
标题取自首条 prompt 的**首行（64 码点截断）**，这是状态文件里唯一一段对话来源的文本，
除此之外不采集对话正文。Codex 会话优先显示 Codex 自己生成的线程标题（只读查
`~/.codex` 线程目录，不落入状态文件）。无遥测、无自更新、无远程资源。

## 开发

纯 JS、Node 22+、零构建。测试全部离线：`for t in tests/*-test.js; do node "$t"; done`。
协作规则见 `AGENTS.md`。自治开发循环（Ralph）：`./scripts/ralph/ralph.sh --phase all 10`
（需 `RALPH_SKIP_APP=1`，本仓库 verify 不起 Electron）。

## License

MIT
