# 状态文件协议 schema:3（兼容读取 schema:1/2）

> 改协议 = 升 `schema` 并保持向后兼容读取；先改本文件再改代码。

## schema:3 状态可靠性规则（2026-09-20）

以下规则为当前协议；旧版本记录只做兼容读取，不据旧语义补推成功。

- 新写入 schema:3，读取接受 1/2/3。除原字段外允许 `read`（boolean）、`runId`（本地 UUID 执行代次）。`turnId` 仍只写来源提供的真实回合 UUID。
- 新增原始态 `idle`（无执行）、`failed`（明确失败）、`stopped`（明确取消/退出）、`waiting-input`（明确等待用户输入）。`done` 指本轮正常结束，不表示用户整个目标完成。
- `SessionStart` 只写 idle；已有记录时不覆盖执行或结果。闲置 Notification 不续运行心跳；只有明确、可归属的新事件才改变当前执行。`SessionEnd` 写 stopped（空会话仍删除）；明确 Stop 写 done。
- `UserPromptSubmit` 开始新的本地 runId；该代次在工具、等待和结束事件间保持。App 优先以 turnId 为代次，WorkBuddy 以新活动段创建 runId。已读和心跳不能改变代次。同轮已读单调保持；迟到的 hasUnreadTurn:true 不撤销已读。
- Codex App 周期核对所有已跟踪 App 记录：当前记录的同回合明确 completed 时主动落 done，不要求先收到 IPC。明确 failed/interrupted 分别落 failed/stopped；结果映射的来源证据在 fixtures 中单独记录。
- 不为未曾跟踪的历史回合补建完成行；不同回合的终态不能结束当前回合。没有 turnId 的旧记录仅在起止时间能覆盖旧记录活动段时允许补正。
- 已读通知只更新 read，且只关联已经确认结束的同回合；不得给运行回合预先标记已读。通知不带回合 ID，不能强行归给通知到达时正在执行的回合。
- 同回合终态不能被 rollout 活动、队列变化、旧数据库投影复活；不同且明确开始的新回合才恢复运行。
- `ts` 表示状态证据更新时间；仅更新 read 保留 ts/since/runId/turnId。磁盘读取时间不当作状态证据时间。
- 陈旧运行不再推导 unknown/idle/完成，改为快照的 `sync-paused`，保留原始状态与最后证据时间，不计入运行/等待/完成，不触发完成气泡，不因 idle 超时消失。坏文件只形成诊断计数，不伪造会话行。
- 已确认 done/failed/stopped 的事实不因展示驻留时间改变；驻留后可移除展示。legacy ended 只表示结束，不推断正常成功。
- App 等待批准通道尚未在当前安装版验证可达。只读被动 IPC 不处理未经验证的批准消息，也不以文件停更猜等待；设置必须披露能力限制。
- 旧读者不支持 schema:3。回退插件需同时回退 hooks 写入器并备份/移走 schema:3 状态目录，由真实来源重新采集；不把新状态有损转为 done。用户数据不自动删除。

## 目录与文件

- 目录：`~/.local/state/pet-agent-status/`（测试用 `PET_AGENT_STATUS_DIR` 覆盖）。
- 每个会话一个文件：`<sessionId>.json`。`sessionId` 只允许 `[A-Za-z0-9._-]`，其余字符写入前替换为 `_`（防路径穿越）。
- **写入必须原子**：同目录写临时文件（`.tmp-` 前缀）后 `rename` 覆盖。
- 同会话写入经 `.json.lock` 串行，再原子 rename。锁等待最长 1 秒；确认锁持有进程不存在才清除遗留锁。超时写入失败由 hook 静默处理。
- SessionEnd 不覆盖已有 done/failed/stopped 结果。没有已确认结果时为 stopped。终态展示 25 分钟后移除，磁盘记录保留作为重启屏障。插件不自动删除历史文件。

## 字段（schema:3；兼容读取 schema:1/2）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | number | 是 | 新写入恒 `3`；读取接受 `1`、`2`、`3` |
| `agent` | `'claude-code'`\|`'codex'`\|`'workbuddy'` | 是 | 会话来源厂牌（`'workbuddy'` 为 2026-09-12 加法，旧读者对未知厂牌按损坏跳过——可接受：旧版本插件本就不会有 workbuddy 写入方） |
| `sessionId` | string | 是 | 会话唯一 id（Claude Code 用 hook 输入的 `session_id`） |
| `cwd` | string | 是 | 会话工作目录（绝对路径） |
| `project` | string | 是 | 展示名：`basename(cwd)` |
| `tty` | string\|null | 是 | 会话终端 tty（如 `/dev/ttys004`），拿不到为 null |
| `pid` | number\|null | 是 | agent 进程 pid（同步有效性探测），拿不到为 null |
| `state` | string | 是 | `idle`\|`running`\|`waiting`\|`waiting-input`\|`done`\|`failed`\|`stopped`；兼容读取 `ended`，不推断成功 |
| `lastEvent` | string | 是 | 产生本次写入的原始事件名（如 `UserPromptSubmit`/`Notification`/`Stop`） |
| `ts` | number | 是 | 最后状态证据时间（Unix 毫秒），已读变化不刷新 |
| `runId` | string | 否 | 本地执行 UUID；新写入生成，无上游编号时以 UserPromptSubmit 或新的活动段创建，心跳不重置。 |
| `read` | boolean | 否 | 结果是否已读；不改变执行结果、时间或回合编号。 |
| `turnId` | string | 否 | schema:2 新增：Codex App 当前回合 UUID。用于完成屏障与重启恢复；CLI/hook 不必写。旧记录无此字段时，新回合开始时间必须严格晚于旧记录 `ts` 才可从终态恢复运行。 |
| `threadId` | string | 否 | Codex 线程 id（UUID，供 `codex://threads/<id>` 深链接） |
| `source` | `'hook'`\|`'ipc'`\|`'reconcile'`\|`'poll'` | 否 | 数据来源，hook 写入缺省为 `'hook'`；`'poll'` = WorkBuddy SQLite 轮询（2026-09-12 加法） |
| `form` | `'cli'`\|`'app'` | 否 | 会话形态；缺省按 `'cli'` 读。`'app'` = Codex App 任务（2026-09-11 起由 IPC 摄入写入；最早作为 schema:1 的选填字段引入，schema:2 继续保留） |
| `title` | string | 否 | 会话标题兜底（US-9，schema:1 加法）。hook 在 `UserPromptSubmit` 时取 `prompt` **首个非空行、64 码点截断**写入；**首见定名**——同会话后续写入保留既有 title，不随后续 prompt 改名。这是「不采集会话正文」纪律的显式让步，边界即上述两条：只许首行 + 截断，任何路径都不许落完整 prompt。展示层优先级：Codex 线程目录 AI 标题 > 终端标签标题（两者均采集器现查、不落盘，见 fixtures/terminal-titles-facts.md）> 本字段 > `project` |
| `since` | number | 否 | **活跃段起点**（Unix 毫秒）：本会话这一轮进入活跃组（`running`/`waiting`/`waiting-input`）的时刻。由 `writeStatus` 维护：前一记录也在活跃组且没有明确切换 turnId 则继承（工具调用、批准后恢复都不重置；明确的新回合重新计时），否则等于本次 `ts`。面板 `mm:ss` 计时用它；同步新鲜度判断仍用 `ts`（最后心跳）。缺省读者回退 `ts`（schema:1 加法，2026-09-11 修「工具调用把计时归零」缺陷时引入） |

未知字段读取时忽略不报错；缺必填字段的文件按损坏跳过（不 crash 采集器）。

## 事件 → state 映射（hook 侧）

| Claude Code hook 事件 | 写入 state |
|---|---|
| `SessionStart` | `idle` |
| `UserPromptSubmit` | `running` |
| `PreToolUse` / `PostToolUse` | `running` |
| `Notification` **且是权限请求** | `waiting` |
| `Notification` **且是闲置提醒**（`matcher:'idle_prompt'`，或 message 含「waiting for your input」） | `idle`（已有记录不覆盖、不刷新心跳） |
| `Notification` 无明确权限/闲置语义 | 忽略，不猜等待批准 |
| `Stop` | `done` |
| `SessionEnd` | `stopped`（**空会话例外**：前一条记录仍停在 `SessionStart` 时删除状态文件，见下） |

**别的 agent 起的子进程会话一个字节都不落盘**（2026-09-12 用户需求，实录
`fixtures/nested-session-facts.md`）：判据是**进程祖先链上除自己这个 claude 外还有第二个
claude**（`lib/nested-session.js`）。这类会话（`claude -p …` 跑在某个 agent 的 Bash 工具里）
的 tty 与 pid 都是从父会话**继承**来的，点它会跳到父会话的终端；结束时还会计进「刚办完」。
比对 comm 的 basename 且**区分大小写**——Claude Desktop App 主进程是大写 `Claude`，
不区分就会把 App 会话整个误杀。ps 读不出来/链断了/匹配不到 claude 一律按「不是子进程」
照常显示（fail-open：漏一条是噪音，错删是丢信息）。Task 工具的 subagent 不产生独立会话，
本来就不在面板上（实测，facts §1）。

**空会话结束时删除状态文件，不许留「已完成」**（2026-09-12 真机缺陷，实录见
`fixtures/claude-desktop-facts.md` §6）：Claude Desktop App 每开一个会话窗口都会甩出一个
不到 1 秒的空会话——只有 `SessionStart`→`SessionEnd`，没有提问也没有工具调用。
照常写 `ended` 会让面板显示绿色「已完成」、计进汇总胶囊与徽标、宠物还为它喊一声，
而它什么都没干——这是**误报完成**。判据方向性保守：只有能证明「一步都没往前走」
（已有 `source:'hook'` 记录且 `lastEvent === 'SessionStart'`）才删；拿不到前一条记录
（hook 中途才装、目录被清过）时不做推断，写 `stopped`。

**`Notification` 必须按语义分流，不许一律当 `waiting`**（2026-09-11 真机缺陷，
实录根因见 `fixtures/waiting-accuracy-facts.md`）：它是通用通知事件，官方 matcher 至少有
`permission_prompt`（真在等批准）与 `idle_prompt`（闲置约 60s，语义是「等你说话」）两类。
把闲置提醒也写成 `waiting`，面板就会对一个只是没人理的会话显示「等待你批准」。

判别优先级：先认结构化 `matcher`/`notification_type`。只认 `permission_prompt` 为批准等待，`idle_prompt` 为闲置；陌生类型忽略。没有类型时只匹配已知权限请求或闲置措辞，未知措辞不猜。

Codex CLI 事件映射（US-006 按本机实测事实补全，来源 `fixtures/codex-hooks-facts.md`：
codex-cli 0.153.4 实测。证据分级：【实录】= 真实会话抓到 payload；【二进制确认】= CLI 二进制
wire 结构里确认事件存在但未实录，按同名 Claude Code 行映射）：

| Codex CLI hook 事件 | 写入 state | 证据 |
|---|---|---|
| `SessionStart` | `idle` | 实录 |
| `UserPromptSubmit` | `running` | 实录 |
| `PreToolUse` / `PostToolUse` | `running` | 二进制确认 |
| `PermissionRequest`（权限等待，对应 Claude Code 的 `Notification`） | `waiting` | 二进制确认 |
| `Stop` | `done` | 实录 |
| `SessionEnd` | `stopped` | 实录 |

Codex 侧附加约定：

- `agent` 恒 `'codex'`；`tty`/`pid` 采集方式同 Claude Code hook（hook 进程自查，`pid` 写 `ppid`）。
- `threadId` = Codex 的 `session_id` 本身（UUID v7 形态，即 `codex://threads/<id>` 可用的线程号）。
  **仅在 `session_id` 通过 UUID 形态校验时写入**；不合形态则不写（协议里 `threadId` 是选填，不造假值）。
- Codex 未在上表的事件（`PreCompact`/`PostCompact`/`SubagentStart`/`SubagentStop`/`Interrupt` 等
  二进制里存在但语义待实录）一律按未知事件忽略退出 0，不猜测映射。

## 采集器展示与同步健康（不落盘）

- `idle` 不产生执行行。done/failed/stopped 事实不会随时间变成 idle；25 分钟后移除展示。
- 活跃记录超过 3 分钟没有证据，或超过 60 秒且已确认进程不存在，显示 `sync-paused`；raw 保留最后状态、ts 保留最后证据时间。同步暂停不计运行、等待或完成，不因超时自动消失，用户可点击确认并收起；新活动可重新显示。
- 读取异常只形成 diagnostics。已在本次运行中读到过的记录暂时损坏时保留最后记录，活跃状态显示同步暂停；首次读到坏文件不伪造任务。没有会话时目录尚未创建是正常情况。
- 旧 `ended` 一律表示停止，不推成功。旧记录缺 runId/read 仍可读取，不自动改写历史文件。
- summary.done 仅计 5 分钟内、未读的正常完成；failed/stopped 不计。summary.syncPaused/waitingInput 分别统计同步暂停和等待输入，面板、启动器、徽标共享行集合。
- 宠物以会话+回合/执行代次识别迁移。首次看到历史 done 不补报；同轮 done 不重复提醒，新轮不受旧轮 5 分钟节流影响。提醒元数据经宿主 storage 保存 30 天，等待提醒仍以 5 分钟节流。
- 点击收起独立于执行结果；storage 保存 at/runId/ts，同轮终态的重复写入不重新出现，新轮立即解除收起。同步暂停行恢复新证据后可重新出现。兼容旧的数值时间戳记录，不删除原状态文件。

## Codex App 来源（US-8，source:'ipc'）

App 任务与 CLI 会话在协议上同构，差别有三处：
- `tty` 为 null（App 任务没有终端），`threadId` 必填且为 UUID —— 跳转据此走深链接而非 tty 聚焦
  （判定唯一实现在 `lib/codex-deeplink.js#pickNavigator`）。
- `source: 'ipc'` 标明来自实时增强通道；`'hook'` 仍是 CLI 主通道。
- `form: 'app'`；`sessionId` = `conversationId`（UUID）本身，`cwd` 为空串、`project` 为品牌名
  `Codex App`（IPC 广播不携带工作目录，不猜、不从别的消息里凑）。

### IPC 事件 → state 映射

| IPC 广播 | 行为 |
|---|---|
| `thread-queued-followups-changed` | 只有最新回合明确 inProgress 才记录活动；终态队列清理不能复活旧任务。普通提交不保证发此帧。 |
| `thread-read-state-changed` | 先核验同轮结果；只有已结束的同轮记录才更新 read。运行期间的通知不预先标记新轮已读，不为陌生历史任务创建完成行。 |
| `thread-stream-following-changed` | 不落盘；只用于 App 归属和同级聚焦。 |
| 其余 | 忽略，尤其不假设被动 client 能收到 `thread-stream-state-changed`。 |

ipc/reconcile 属于同一 App 摄入来源，可互相更新；不得覆盖 hook 记录。

### rollout 活动与回合屏障（source:'reconcile'，2026-09-12 修订）

**Codex App 子 Agent 过滤（2026-09-13）**：按已知候选线程 ID，只读
`state_5.sqlite.threads.source/thread_source` 与 `thread_spawn_edges` 的父子 ID。
结构化 `source.subagent`、明确的 `thread_source=subagent/guardian_review`，或合法的
spawn 父子关系，均证明该线程是内部子 Agent（包括 review/compact/guardian）。
新 IPC/rollout 摄入跳过这些线程；历史 ipc/reconcile 状态也在聚合之前排除，不进入
面板、计数、聚焦、App 完成点、徽标或宠物联动。父任务仍按自身事件显示。
关闭 IPC 增强后，历史记录仍执行该过滤；不删除历史文件，沿用既有过期清理。

身份只存在采集器内存，不新增或改变状态文件字段（写 schema:3，兼容读 schema:1/2）。
只缓存已经确认的子 Agent；查不到、缺列、锁库、未知来源均不猜，后续采集重试。
元数据延迟时可能短暂沿用原显示，确认后即排除；已确认身份在本次运行内不因数据库
短暂失效而回退。重启后重新核验。不得以标题、目录缺席、普通 fork 信息或未知来源
为依据隐藏用户任务。hook 来源不受 App 过滤影响。

- 运行活动仍只读取 rollout 的文件名与 stat，不读取会话正文。mtime 距今 ≤30s
  是心跳候选，**不是**完成后重新运行的充分条件。
- 每轮只读 `thread_history_1.sqlite.thread_turns` 的最新回合编号、状态、起止时间
  （按 rollout_ordinal 排序）。只认 `inProgress/completed/failed/interrupted`；未知值
  不作活动证据，不读取 error_json、thread_items 或其他正文列。
- 历史任务续聊可能使用 `rollout-<时间>-<App线程ID>_<运行线程ID>.jsonl`。
  只从 `state_5.sqlite.threads` 按 App 线程 ID 返回且通过路径校验的 rollout_path
  解析此对应关系：以运行线程 ID 查询回合，面板、IPC、状态文件与跳转仍保留 App
  线程 ID。近期文件发现也取下划线前的 App ID，不额外创建内部运行线程行。
  不混用旧 App ID 下的终态回合；找不到运行线程元数据时沿用既有缺失元数据保护。
  仅调整内部元数据关联，状态文件字段及含义不变，写 schema:3。
- 每两秒核对已跟踪 App 任务的最新回合。记录带 turnId 时要求完全相同；旧记录无 turnId 时要求起止时间覆盖其活动段。completed→done、failed→failed、interrupted→stopped。不依赖 IPC 通知，不补建陌生历史结果。
- 终态 ts 取上游结束时间（不晚于当前时间、也不早于已保存的证据时间），仅更新已读不刷新。
- 写入已核验完成记录时保存该回合 `turnId`。已完成/失败/停止的记录，
  只有明确的**不同回合**且状态为 `inProgress` 才能由 rollout 恢复 running。
  同一回合收尾写入、mtime 不变、插件重启均不能穿过该屏障。
- 对 schema:1 或尚无 turnId 的终态记录，需最新 inProgress 回合的 started_at
  严格晚于记录 ts 才允许恢复。数据库缺失/锁住/schema 漂移时保持终态，
  不凭 mtime 猜新回合；无回合依据的队列消息不作为新回合来源。
- 最新回合已经 completed/failed/interrupted 时，不再以 rollout 给 running 续心跳。
  数据库中同回合终态直接纠正记录；不能将磁盘读取时间当作运行心跳。
- 归属保护不变：已有 ipc/reconcile 记录或 App following，且不可覆盖 hook 来源。
- 运行期间 ≥20s 刷新 ts，since 继承规则不变；心跳仅延续运行态。
- 近期目录用于发现文件；另对已有 App 记录/following 线程，从
  `state_5.sqlite.threads` 按 id 只读 rollout_path，缓存并直接 stat，以支持旧任务。
  路径必须位于当前 CODEX_HOME/sessions 内、文件名 UUID 匹配，拒绝符号链接逃逸。
  查不到路径时继续使用近期发现的路径，不每轮递归历史目录。
- 与 IPC 增强共用 codexIpcEnabled 开关；失败不影响 CLI 与面板。

IPC 仍是**可关闭的增强通道**（设置里可关，故障自动停用退回 Hooks）；
未实录确认语义的事件一律忽略，**绝不映射成 done**（见 `fixtures/codex-ipc-facts.md` §5/§8）。

## WorkBuddy 来源（source:'poll'，2026-09-12）

腾讯 WorkBuddy（CodeBuddy 系办公 Agent 桌面 app）。事实与活体验证实录见
`fixtures/workbuddy-facts.md`：官方权威状态就在 SQLite `~/.workbuddy/workbuddy.db`
的 `sessions.status` 列，任务运行期间实时写库（§5 实录 pending→planning→working→completed），
所以**单一信号：只读轮询该表**，不逆向 IPC、不拼多信号。

记录形态：`agent:'workbuddy'`、`form:'app'`、`source:'poll'`、`tty:null`、
`sessionId` = DB 的会话 UUID、`cwd`/`project` 取自 DB `cwd` 列（真路径，非品牌名兜底）、
`pid` = WorkBuddy 内嵌 serve 进程 pid（`~/.workbuddy/sessions/<pid>.json` 心跳文件里
最新鲜的一个；拿不到为 null）——采集器可据此识别同步中断。
`title` 取 DB `custom_title` > `title`（AI 起的短名，非会话正文），走 `normalizeTitle`
清洗与「首见定名」；首写时 DB 还没起名则后续写入自然补上。

### DB status → state 映射（判据来源 fixtures/workbuddy-facts.md §3.2/§5，status 比较一律 LOWER）

| DB status | 写入 state | 附加判据 |
|---|---|---|
| `working` / `planning` | `running` | `updated_at` 距今 ≤ 180s（运行期实测 1–5s 一写，180s = 36 倍余量；防 App 被强杀后 status 永远停在 working 的僵尸行） |
| `pending` 且 `last_activity_at` **非空** | `waiting-input` | 语义是 awaiting_input（agent 等用户答复）。**新建**该行要求 `updated_at` ≤ 180s（不报旧闻）；已有记录则持续心跳维持 |
| `pending` 且 `last_activity_at` **为空** | 不落盘 | 刚建的空会话（fixtures §5：创建时刻 last_activity_at=None），报 waiting 就是 0.8.2 修掉的那类「闲置误报」 |
| `completed` | `done`（**只更新已存在的 poll 记录，绝不新建**） | 启动时扫到的历史 completed 是旧闻（同 IPC ended 的只更新规则） |
| `failed` / `error` | `failed`（只更新不新建） | 不计成功，不发成功气泡 |
| `terminated` / `archived` | `stopped`（只更新不新建） | 用户自己取消/归档的，无需驻留提醒 |
| 其余 / 未知 status | 忽略 | 未实录语义不猜，**绝不映射为 done**（同 IPC 纪律） |

### 长期约束

- **可写性**：只写 `source:'poll'` 的记录（或不存在的）；hook/ipc/reconcile 记录一律不碰。
  心跳节流 ≥20s 刷新 `ts`（防 3min stale 兜底误伤长任务），`since` 继承由 `writeStatus`
  统一维护（计时不归零，同 0.8.3 教训）。
- **全失败静默降级**：DB 文件不存在（没装 WorkBuddy）→ 无行为；`node:sqlite` 不可用
  （宿主 Node < 22.13）→ 模块整体停用；**DB 锁错误按常态跳过本轮**、沿用上轮状态——
  fixtures §5 实录 App 启停窗口期会连续数秒锁死，据此判「不可用」就是误报。
  每轮 open readOnly → 查 → close，不持久连接（避免占着句柄妨碍 App 迁移 schema）。
- **跳转**：`workbuddy://chat/<sessionId>`（asar 实录路由，`/task/<id>` 的 deeplink 形态；
  id 必须过 UUID 校验才拼 URL，同 codex 深链接白名单精神）。判定唯一实现仍在
  `codex-deeplink.js#pickNavigator`（workbuddy 分支）。
- 内部存储无稳定性承诺（同 Codex rollout 纪律）：schema 变了查询报错 → 静默降级，
  绝不 crash 采集器；发现新任务时查询白名单列、`deleted_at IS NULL`、LIMIT 20；每个已跟踪任务再按 ID 查询，终态不会因掉出最近 20 条而漏收。
- 本来源 v1 无独立开关（没装 WorkBuddy 即自然无行为）；将来要加开关走 storage 键
  `workbuddyEnabled`，别复用 codex 的 `codexIpcEnabled`。

## 同一终端窗口只显示当前那条会话（2026-09-12）

用户实测：一个终端窗口同时出现「运行中 / 空闲 / 已完成」三条行。成因是同一个窗口先后
跑过多个会话（退出重开、`claude -c` 续接，或该窗口里的 agent 起过 `claude -p` 子进程——
后者已在 hook 侧拦掉），每条各占一行，旧的在 done 绿驻留 5 分钟 + idle 20 分钟里一直挂着。

判据（`lib/aggregate.js#supersedeSameTerminal`，对齐「点得进去才显示」原则）：按 **tty 分组**，

- 组内有现役会话（running/waiting）→ 现役的全留，已结束的全部隐藏（窗口已被现役会话占着，
  点旧行只会跳到同一个窗口，而那里跑的是别的会话）；
- 组内全部已结束 → 只留最新那条（别让一个窗口堆出一串「已完成」）；
- **tty 为 null 的行不参与**：App 任务（Codex App / Claude App）不属于任何终端窗口，
  可以同时有多条，绝不互相顶掉；
- **现役会话一律保留**：同一 tty 上若有多条 running/waiting（分屏残留、异常未收尾）全留——
  顶掉一个正在等你批准的会话是丢信息，比多显示一行糟得多。

隐藏发生在汇总之前：被顶掉的行不计进 `summary`（徽标/胶囊/宠物提醒同源，否则会为一条
根本不显示的行喊「刚办完」）。

## 按落点过滤：点不进去的会话不显示（2026-09-12）

原则（用户拍板）：面板里的每一条，点下去都要能真正到它对应的地方。落点只有三种，
都是已有能力：tty → 聚焦终端窗口；Codex/WorkBuddy → 深链接；Claude App → 激活 App。

判据（`lib/aggregate.js`）：**`tty == null` 且 `canJumpWithoutTty(row)` 为假 → 整行隐藏**，
计入 `summary.hiddenNoTarget`，面板底部如实说明条数。

- **不得改用 `canJump === false` 当判据**：那一档包含「有 tty 但认不出终端 App」
  （冷门终端、ps 缓存抖动），会话真实存在于某个终端里，按它过滤会误藏。tty 非空一律保留。
- tty 检测的准确性与失准方向见 `fixtures/nested-session-facts.md` §9（三组真机对照）：
  唯一失准是「无终端但祖先有终端时继承父 tty」，方向是多给入口，不会误藏。
- 坏文件以诊断计数展示，不参与任务数量。
- `summary` 是 panel/徽标/联动的共同契约，新增字段必须同步 `tests/aggregate-test.js`
  与 `tests/tool-lifecycle-test.js` 里逐字段全等的那两条断言。

## 路径覆盖约定（测试隔离）

| 环境变量 | 覆盖对象 | 默认 |
|---|---|---|
| `PET_AGENT_STATUS_DIR` | 状态目录 | `~/.local/state/pet-agent-status` |
| `PET_AS_CLAUDE_SETTINGS` | Claude Code 配置 | `~/.claude/settings.json` |
| `PET_AS_CODEX_HOOKS` | Codex CLI hooks 配置 | `$CODEX_HOME/hooks.json`，`CODEX_HOME` 缺省 `~/.codex` |
| `CODEX_HOME` | Codex 主目录（hooks 配置与 IPC socket 同源认它） | `~/.codex` |
| `PET_AS_WORKBUDDY_HOME` | WorkBuddy 数据目录（DB 与 serve 心跳文件同源认它） | `~/.workbuddy` |
| `PET_AS_CLAUDE_APP_SUPPORT` | Claude Desktop App 数据目录（会话元数据：AI 标题与归属） | `~/Library/Application Support/Claude` |
| `PET_AS_PS_OUTPUT` | 进程表（子进程会话判定用，测试注入实录 ps 输出） | 实跑 `ps -eo pid=,ppid=,tty=,comm=` |
| `PET_AS_TTY` | 会话 tty（测试钉死；tty 检测依赖环境，CI 上完全没有 tty） | 由 fd/ps 反查 |

### 有界诊断记录

宿主 storage 的 `statusTransitions` 最多保存最近 100 条、30 天内采集到的状态变化，字段白名单为 sessionId、runId、state、raw、read、at、evidenceAt、source、event、reason。仅记录采集器观察到的快照迁移，不承诺捕获两次采集之间的每个源事件。不保存标题、路径、正文或批准参数；相同状态的心跳不追加记录。重启恢复并去重，写失败在后续采集重试。
