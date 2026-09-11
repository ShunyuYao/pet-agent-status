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
| `form` | `'cli'`\|`'app'` | 否 | 会话形态；缺省按 `'cli'` 读。`'app'` = Codex App 任务（2026-09-11 起由 IPC 摄入写入；schema 仍为 1——选填字段做加法，旧读者按未知字段忽略，不破坏向后兼容） |
| `title` | string | 否 | 会话标题兜底（US-9，schema:1 加法）。hook 在 `UserPromptSubmit` 时取 `prompt` **首个非空行、64 码点截断**写入；**首见定名**——同会话后续写入保留既有 title，不随后续 prompt 改名。这是「不采集会话正文」纪律的显式让步，边界即上述两条：只许首行 + 截断，任何路径都不许落完整 prompt。展示层优先级：Codex 线程目录 AI 标题 > 终端标签标题（两者均采集器现查、不落盘，见 fixtures/terminal-titles-facts.md）> 本字段 > `project` |
| `since` | number | 否 | **活跃段起点**（Unix 毫秒）：本会话这一轮进入活跃组（`running`/`waiting`）的时刻。由 `writeStatus` 维护：前一记录也在活跃组则继承（工具调用、批准后恢复都不重置），否则等于本次 `ts`。面板 `mm:ss` 计时用它；陈旧/error/idle 推导仍用 `ts`（最后心跳）。缺省读者回退 `ts`（schema:1 加法，2026-09-11 修「工具调用把计时归零」缺陷时引入） |

未知字段读取时忽略不报错；缺必填字段的文件按损坏跳过（不 crash 采集器）。

## 事件 → state 映射（hook 侧）

| Claude Code hook 事件 | 写入 state |
|---|---|
| `SessionStart` | `running` |
| `UserPromptSubmit` | `running` |
| `PreToolUse` / `PostToolUse` | `running` |
| `Notification` **且是权限请求** | `waiting` |
| `Notification` **且是闲置提醒**（`matcher:'idle_prompt'`，或 message 含「waiting for your input」） | `running` |
| `Stop` | `done` |
| `SessionEnd` | `ended` |

**`Notification` 必须按语义分流，不许一律当 `waiting`**（2026-09-11 真机缺陷，
实录根因见 `fixtures/waiting-accuracy-facts.md`）：它是通用通知事件，官方 matcher 至少有
`permission_prompt`（真在等批准）与 `idle_prompt`（闲置约 60s，语义是「等你说话」）两类。
把闲置提醒也写成 `waiting`，面板就会对一个只是没人理的会话显示「等待你批准」。

判别优先级：先认结构化的 `matcher`/`notification_type`，缺席才退回 `message` 文本启发式。
**方向性必须保守——拿不准一律按 `waiting`**：漏报会让用户错过真正在等他批准的会话
（那正是本插件存在的理由），误报只是多看一眼。故只在**确认是闲置类**时才降级，
绝不反向猜测。官方未公布逐字 message 字符串，所以文本判据只能是兜底而非主判据。

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

App 任务与 CLI 会话在协议上同构，差别有三处：
- `tty` 为 null（App 任务没有终端），`threadId` 必填且为 UUID —— 跳转据此走深链接而非 tty 聚焦
  （判定唯一实现在 `lib/codex-deeplink.js#pickNavigator`）。
- `source: 'ipc'` 标明来自实时增强通道；`'hook'` 仍是 CLI 主通道。
- `form: 'app'`；`sessionId` = `conversationId`（UUID）本身，`cwd` 为空串、`project` 为品牌名
  `Codex App`（IPC 广播不携带工作目录，不猜、不从别的消息里凑）。

### IPC 事件 → state 映射（2026-09-11 实录，来源 `fixtures/codex-ipc-facts.md` §4/§8）

| IPC 广播 | 写入 state | 语义依据 |
|---|---|---|
| `thread-queued-followups-changed`（带 `conversationId`） | `running` | 实录：提交任务时刻发出（队列清空/变化=该会话有新活动）。属启发式，误报由采集器 3min 无新事件转 unknown 兜底 |
| `thread-read-state-changed` 且 `hasUnreadTurn === true` | `done` | 实录×2 + 反例×1：仅在回合结束时刻发出，运行中不发（时序实验见 facts §8）。**这是唯一允许映射为 done 的 IPC 信号** |
| `thread-read-state-changed` 且 `hasUnreadTurn === false` | `ended`（仅更新已存在的 `source:'ipc'` 记录，绝不新建） | 用户在 App 里读过了 = 已结束展示；对没见过的会话新建一条 `ended` 是在报旧闻 |
| `thread-stream-following-changed` | 不落盘 | 只进内存 following 集合，供聚焦（focus）同级优先 |
| 其余（含 `thread-stream-state-changed`） | 忽略 | 实录证实被动外部 client **收不到** stream-state 广播（facts §8）；未实录语义一律不猜 |

摄入保护：同 `sessionId` 已存在 `source` 非 `'ipc'` 的记录（CLI hooks 写的，含 tty 更富）时，
IPC 摄入**跳过不覆盖**。IPC 记录的清理走既有 idle 淡出与 24h 文件清理，无独立生命周期。

IPC 仍是**可关闭的增强通道**（设置里可关，故障自动停用退回 Hooks）；
未实录确认语义的事件一律忽略，**绝不映射成 done**（见 `fixtures/codex-ipc-facts.md` §5/§8）。

## 路径覆盖约定（测试隔离）

| 环境变量 | 覆盖对象 | 默认 |
|---|---|---|
| `PET_AGENT_STATUS_DIR` | 状态目录 | `~/.local/state/pet-agent-status` |
| `PET_AS_CLAUDE_SETTINGS` | Claude Code 配置 | `~/.claude/settings.json` |
| `PET_AS_CODEX_HOOKS` | Codex CLI hooks 配置 | `$CODEX_HOME/hooks.json`，`CODEX_HOME` 缺省 `~/.codex` |
| `CODEX_HOME` | Codex 主目录（hooks 配置与 IPC socket 同源认它） | `~/.codex` |
