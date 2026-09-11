# 状态文件协议 schema:1（冻结）

> 改协议 = 升 `schema` 并保持向后兼容读取；先改本文件再改代码。

## 目录与文件

- 目录：`~/.local/state/pet-agent-status/`（测试用 `PET_AGENT_STATUS_DIR` 覆盖）。
- 每个会话一个文件：`<sessionId>.json`。`sessionId` 只允许 `[A-Za-z0-9._-]`，其余字符写入前替换为 `_`（防路径穿越）。
- **写入必须原子**：同目录写临时文件（`.tmp-` 前缀）后 `rename` 覆盖。
- 会话正常结束（SessionEnd/退出）：hook 把 `state` 置 `ended` 并保留文件；采集器把 `ended` 视为 done 的终态展示后按 idle 淡出规则移除展示（文件由采集器在超过 24h 后清理）。

## 字段（schema:1）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | number | 是 | 恒 `1` |
| `agent` | `'claude-code'`\|`'codex'` | 是 | 会话来源厂牌 |
| `sessionId` | string | 是 | 会话唯一 id（Claude Code 用 hook 输入的 `session_id`） |
| `cwd` | string | 是 | 会话工作目录（绝对路径） |
| `project` | string | 是 | 展示名：`basename(cwd)` |
| `tty` | string\|null | 是 | 会话终端 tty（如 `/dev/ttys004`），拿不到为 null |
| `pid` | number\|null | 是 | agent 进程 pid（error 推导做存活探测），拿不到为 null |
| `state` | string | 是 | `running`\|`waiting`\|`done`\|`ended`（推导态 error/idle/unknown 只在采集器内存与面板，不落盘） |
| `lastEvent` | string | 是 | 产生本次写入的原始事件名（如 `UserPromptSubmit`/`Notification`/`Stop`） |
| `ts` | number | 是 | 本次写入的 Unix 毫秒 |
| `threadId` | string | 否 | Codex 线程 id（UUID，供 `codex://threads/<id>` 深链接） |
| `source` | `'hook'`\|`'ipc'`\|`'reconcile'` | 否 | 数据来源，hook 写入缺省为 `'hook'` |

未知字段读取时忽略不报错；缺必填字段的文件按损坏跳过（不 crash 采集器）。

## 事件 → state 映射（hook 侧）

| Claude Code hook 事件 | 写入 state |
|---|---|
| `SessionStart` | `running` |
| `UserPromptSubmit` | `running` |
| `PreToolUse` / `PostToolUse` | `running` |
| `Notification`（权限请求/等待输入） | `waiting` |
| `Stop` | `done` |
| `SessionEnd` | `ended` |

Codex CLI 事件映射（US-006 按本机实测事实补全，来源 `fixtures/codex-hooks-facts.md`：
codex-cli 0.153.4 实测。证据分级：【实录】= 真实会话抓到 payload；【二进制确认】= CLI 二进制
wire 结构里确认事件存在但未实录，按同名 Claude Code 行映射）：

| Codex CLI hook 事件 | 写入 state | 证据 |
|---|---|---|
| `SessionStart` | `running` | 实录 |
| `UserPromptSubmit` | `running` | 实录 |
| `PreToolUse` / `PostToolUse` | `running` | 二进制确认 |
| `PermissionRequest`（权限等待，对应 Claude Code 的 `Notification`） | `waiting` | 二进制确认 |
| `Stop` | `done` | 实录 |
| `SessionEnd` | `ended` | 实录 |

Codex 侧附加约定：

- `agent` 恒 `'codex'`；`tty`/`pid` 采集方式同 Claude Code hook（hook 进程自查，`pid` 写 `ppid`）。
- `threadId` = Codex 的 `session_id` 本身（UUID v7 形态，即 `codex://threads/<id>` 可用的线程号）。
  **仅在 `session_id` 通过 UUID 形态校验时写入**；不合形态则不写（协议里 `threadId` 是选填，不造假值）。
- Codex 未在上表的事件（`PreCompact`/`PostCompact`/`SubagentStart`/`SubagentStop`/`Interrupt` 等
  二进制里存在但语义待实录）一律按未知事件忽略退出 0，不猜测映射。

## 采集器推导态（不落盘）

- `error`：文件 state 为 `running`/`waiting` 且 `ts` 距今 > 60s 且 `pid` 非 null 且进程不存活。
- `done`（展示驻留）：state 为 `done`/`ended` 且 `ts` 距今 ≤ 5min，按「已完成」绿展示（2026-09-10 修订，对齐 DESIGN.md 图例）。
- `idle`：done/ended 超 5min 驻留窗，或任何状态 `ts` 距今 > 20min；idle 超 20min 从面板移除。
- `unknown`：文件损坏/schema 高于当前支持版本/来源语义不明。**绝不映射为 done**。

## Codex App 来源（US-8，source:'ipc'）

App 任务与 CLI 会话在协议上同构，只有两处差别：
- `tty` 为 null（App 任务没有终端），`threadId` 必填且为 UUID —— 跳转据此走深链接而非 tty 聚焦
  （判定唯一实现在 `lib/codex-deeplink.js#pickNavigator`）。
- `source: 'ipc'` 标明来自实时增强通道；`'hook'` 仍是 CLI 主通道。

IPC 只作为**增益信号**（当前仅「App 正在跟随哪个会话」），不作为会话存在性的唯一来源：
未实录确认语义的事件一律忽略，**绝不映射成 done**（见 `fixtures/codex-ipc-facts.md` §5）。

## 路径覆盖约定（测试隔离）

| 环境变量 | 覆盖对象 | 默认 |
|---|---|---|
| `PET_AGENT_STATUS_DIR` | 状态目录 | `~/.local/state/pet-agent-status` |
| `PET_AS_CLAUDE_SETTINGS` | Claude Code 配置 | `~/.claude/settings.json` |
| `PET_AS_CODEX_HOOKS` | Codex CLI hooks 配置 | `$CODEX_HOME/hooks.json`，`CODEX_HOME` 缺省 `~/.codex` |
| `CODEX_HOME` | Codex 主目录（hooks 配置与 IPC socket 同源认它） | `~/.codex` |
