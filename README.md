# pet-agent-status

桌宠（吐梨邦）插件：把本机 **Claude Code / Codex / WorkBuddy** 会话状态实时显示在桌宠上——
插件面板里看多会话列表，任务完成/等待批准时宠物用动画和气泡提醒你，点击会话行一键跳回对应终端。

- 状态来源：Claude Code / Codex CLI 官方 hooks → 本机状态文件（协议见 `PROTOCOL.md`）；
  WorkBuddy 零配置（只读轮询其本机 SQLite 会话表，没装即无行为）
- UI 规格：`DESIGN.md`（Figma 同源）
- 安装：宿主设置页「插件 → 手动安装」选择本仓库目录（开发者模式），或等市场上架
- 设置：宿主设置页「插件」里点本插件的**「打开面板」**，面板右上角 **⚙** 即插件设置
  （Codex App 实时增强开关、Claude Code / Codex CLI 钩子接入、关于与开源地址）

> 喜欢这个插件的话，欢迎去 GitHub 点个 ⭐️ Star：
> <https://github.com/ShunyuYao/pet-agent-status>

## 权限披露（nodeAccess）

本插件按桌宠插件平台的 **nodeAccess 声明披露制** 使用以下 Node 内建能力，除此之外只经 `pet.*` SDK：

| 能力 | 用途 | 范围 |
|---|---|---|
| `fs` 读写 `~/.local/state/pet-agent-status/` | 读取会话状态文件（本插件 hooks 自己写入的数据） | 仅该目录 |
| `fs` 读写 `~/.claude/settings.json`、`~/.codex/hooks.json` | 「一键接入/移除钩子」时合并写入 hooks 条目，写前自动备份 | 仅接入/卸载动作时；不碰 Codex 的 `hooks.state` 信任文件 |
| `child_process` spawn `ps` | 按会话的 tty 反查它属于哪个终端 App（决定这一行能否跳转） | 只读进程表，10 秒缓存 |
| `child_process` spawn `osascript` | ① 点击会话行时聚焦 iTerm2 / Terminal.app 对应窗口标签页；② 读取终端标签标题做会话名（Claude Code 把 AI 生成的标题推给了终端，磁盘上没有） | ① 仅跳转动作时；② 15s 缓存的只读查询，仅查已在运行的终端（不拉起 App），与跳转同一份自动化授权 |
| `child_process` spawn `open` | ① 点击 Codex App / WorkBuddy 任务时经 `codex://threads/<id>` / `workbuddy://chat/<id>` 深链接跳转；② 点击 Claude Desktop App 会话时 `open -b` 把 Claude App 提到前台（App 无会话寻址深链接，只兜底激活不假装精确） | 仅跳转动作时 |
| `fs` **只读** `~/Library/Application Support/Claude/claude-code-sessions/` | Claude Desktop App 会话的行标题（App 落盘的 AI 标题）与「这行是 App 会话」的归属判定 | 只读，30s 缓存；读不到自动降级（无标题、无跳转入口） |
| `net` 连接 `~/.codex/ipc/ipc.sock` | Codex App 实时增强（**默认开，面板设置里可关**）：只读监听任务动态与跟随状态 | 开关打开时（默认）；故障自动停用 |
| `fs`/`node:sqlite` **只读** `~/.codex/sqlite/codex-dev.db`、`~/.codex/session_index.jsonl` | 会话行显示 Codex 自己生成的线程标题 | 只读，30s 缓存；读不到自动降级为目录名 |
| `fs`/`node:sqlite` **只读** `~/.workbuddy/workbuddy.db`（+ `~/.workbuddy/sessions/` 心跳文件） | WorkBuddy 会话状态与标题（官方权威状态就在该表，实测见 `fixtures/workbuddy-facts.md`） | 每 2s 只读轮询；锁死/没装/驱动缺失一律静默降级 |

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

## 更新提醒

本插件通过 `updateReminders: true` 参与宿主的登录后新版提醒。发现新版时由宿主询问，
用户确认后才下载、安装；取消、关闭或超时均保留当前版本，插件不会自行下载执行代码。
需要支持此声明的宿主构建（该能力尚未随宿主发版）；旧宿主忽略此可选声明。
已安装的旧插件需先手动更新至包含本声明的版本，才会参与后续提醒。

This plugin opts into host-managed update reminders. The host checks after sign-in and
asks for confirmation before downloading or installing. Canceling, closing, or letting
the prompt expire keeps the current version. A supporting host build is required;
older plugin installations must first be manually updated to a version with this opt-in.

## 开发

纯 JS、Node 22+、零构建。测试全部离线：`for t in tests/*-test.js; do node "$t"; done`。
协作规则见 `AGENTS.md`。自治开发循环（Ralph）：`./scripts/ralph/ralph.sh --phase all 10`
（需 `RALPH_SKIP_APP=1`，本仓库 verify 不起 Electron）。

## License

MIT
