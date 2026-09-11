# Claude Desktop App（Claude.app）会话状态调研实录

2026-09-11 实测于 macOS，Claude.app 1.20186.1（com.anthropic.claudefordesktop），终端 CLI 2.1.246。
调研问题：App 里的 Claude Code 会话状态能否被本插件直接获取、能否跳转。

## 结论速览

| 需求 | 结论 |
|------|------|
| 状态采集（running/waiting/done） | **hooks 生效**——App 本地 Code 会话跑的就是 CLI，读 `~/.claude/settings.json`，本插件的 hook 采集**零改动就能收到**（实测已收到，见 §3） |
| 会话标题 | App 侧 **AI 标题落盘**：`claude-code-sessions/<accountId>/<orgId>/local_*.json` 的 `title` + `titleSource:"auto"`（与 CLI「标题不落盘」相反） |
| 跳转到既有会话 | **无深链接**。`claude://code/new?q&folder` 只能开新会话；官方文档与 URL scheme 均无 session 寻址。只能 `open -a Claude` 激活 App 兜底 |
| 实时 IPC | **没有**。无 unix socket、无监听端口（与 Codex App 的 `~/.codex/ipc/ipc.sock` 不同） |
| App 里有没有桌宠 | 没有。feature flags 里的动物名（plushRaccoon/quietPenguin/chillingSloth）是内部功能代号，chillingSloth* = Claude Code desktop 系列，前两者本机 unavailable |

## 1. 形态：没有独立的 "Claude Code.app"

Claude Code 是 Claude.app（Claude for Desktop）内的能力。App 内嵌一份自己的 CLI：
`~/Library/Application Support/Claude/claude-code/<版本>/claude.app/Contents/MacOS/claude`
（本机 2.1.205，与终端 CLI 2.1.246 独立）。App 起会话时经 Electron 的
`node.mojom.NodeService` utility 进程跑 CLI——**不是**终端可见的 `claude` 进程，但行为等同 CLI。

## 2. 数据落点（App 专有）

`~/Library/Application Support/Claude/` 下：

- `claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json` —— **每个本地 Code 会话一份元数据**，字段实录：
  `sessionId`(local_ 前缀) / `cliSessionId`(**对应 CLI 会话 uuid，即 hooks 收到的 session_id**) /
  `cwd` / `originCwd` / `worktreePath` / `worktreeName` / `branch` / `sourceBranch` /
  `title` + `titleSource:"auto"`(**AI 标题，落盘！**) / `model` / `effort` / `permissionMode` /
  `createdAt` / `lastActivityAt` / `completedTurns` / `isArchived` / 可选 `sshConfig`(SSH 会话) /
  可选 `transcriptUnavailable:true`。
  **注意 mtime 会被 App 启动时批量重写**（本机两份 5 月的会话 mtime 是当天）——判活别只看 mtime，交叉 `lastActivityAt`。
- `git-worktrees.json` —— App 给会话开的隔离 worktree 登记（`.claude/worktrees/<形容词-名人-hash>`，分支 `claude/<同名>`）。
- `bridge-state.json` —— 本地 ⇄ claude.ai 云会话（`cse_` remoteSessionId）的桥接登记。
- `local-agent-mode-sessions/` —— 旧版「local agent mode」遗留（本机 3 月），新会话不写这里。
- 转录 jsonl **不进** `~/.claude/projects/`（找不到 App 会话的 jsonl；元数据还有 `transcriptUnavailable` 一说）。

## 3. hooks 生效的实证（本插件零改动可采集）

深链接 `open "claude://code/new?q=<prompt>&folder=<dir>"` 触发后：

- App 拉起 2 个 NodeService 子进程，随即本插件状态目录出现 **3 个新 state 文件**（`source:"hook"`）：
  - `bc2aa1d2-…`：`cwd` = 深链接里的 folder，`project` 取对，SessionStart→SessionEnd 都收到了；
  - 另两个 `cwd:/Users/shunyu` 的秒退会话（疑似 App 的预热/探测调用）。
- 即 App 会话走完整 hook 管线（与官方文档一致：Desktop 的 Local/SSH/WSL 会话读 settings hooks；
  **Cowork 不支持 hooks**，是公开 feature request，github.com/anthropics/claude-code issue #63360）。
- 特征：`tty:null`（无终端）→ 现有「按 tty 跳 iTerm/Terminal」链路对 App 会话必然落空；
  秒退的预热会话会在面板上闪一条 ended 行，接入时要考虑过滤（如 cwd=$HOME 且 0 轮次）。

## 4. 深链接实测

- `claude://code/new?q=<urlencoded prompt>&folder=<path>` 有效（本次即用它起的探针会话）；
  另有 `claude://cowork/new?q&folder&file`。官方帮助页：support.claude.com article 14729294。
- **没有** `claude://code/session/<id>` 之类打开既有会话的方案（文档 + Info.plist 均无）。
- `~/Applications/Claude Code URL Handler.app` 注册的是另一个 scheme `claude-cli://`（CLI 深链，LSBackgroundOnly）。

## 5. 对插件接入的建议（未实现，仅结论）

1. **状态**：什么都不用做，hooks 已覆盖——App 会话本来就会出现在面板上（tty:null）。
2. **标题**：App 会话可升级为读 `claude-code-sessions/**.json` 按 `cliSessionId` 反查 AI `title`
   （优先级可排在「终端标签标题」位——App 会话没有终端标签）。
3. **跳转**：tty 为 null 时对 claude-code 行退化为 `open -a Claude`（激活 App，不能定位到具体会话）。
4. **区分 App/CLI**：hook 载荷无显式来源字段；可用 `tty==null && ppid 链上有 Claude.app` 或
   cwd 命中 `.claude/worktrees/` + `claude-code-sessions` 里存在对应 `cliSessionId` 判定，
   类比 codex 的 `form:'cli'|'app'` 加一档。
