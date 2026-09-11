# Codex App IPC 实测事实（US-8 前置门）

> 实测环境：**Codex 跑在 ChatGPT.app 内**（`/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/`，
> 版本 152.0.7977.83），codex-cli 0.153.4，macOS，2026-09-11。
> 探针方式：只读连接 + 握手后被动监听，只记录消息名与字段名、**不记录任何内容**。
> 证据分级：【实录】= 本机真实抓到；【调研】= 飞书调研文档所载、本次未复现。

## 1. socket 与进程

- 路径：`~/.codex/ipc/ipc.sock`（目录 0700、socket 0600，仅当前用户可访问）。
- **持有者是 `ChatGPT` 主进程**（`lsof` 实测，PID 归属 ChatGPT.app），不是独立的 codex 进程。
  ⚠️ 因此「Codex App 是否在跑」不能用 `pgrep Codex.app` 判断——探测时我因此误判过一次。
  可靠判据只有一条：**能否连上这个 socket**。
- App 未运行时 socket 文件可能残留；连接会失败（ENOENT/ECONNREFUSED），据此判定不可用。

## 2. 帧格式（实录，与调研一致）

4 字节小端无符号长度前缀 + UTF-8 JSON 正文。

## 3. 握手（实录）

发：
```json
{"type":"request","requestId":"<uuid>","sourceClientId":"initializing-client",
 "method":"initialize","params":{"clientType":"<任意标识>"}}
```
收：`{type:'response', requestId, resultType, method, handledByClientId, result}` —— 握手成功。

## 4. 实录到的消息

| 消息 | 证据 | 顶层字段 | params 字段 |
|---|---|---|---|
| `response` / initialize | 【实录】 | `type, requestId, resultType, method, handledByClientId, result` | — |
| `broadcast` / `thread-stream-following-changed` | 【实录】 | `type, method, sourceClientId, targetClientIds, params, version` | **`conversationId, hostId, following`** |
| `client-discovery-request` | 【实录】 | `type, requestId, request` | — |

**关键收获**：`following` 广播带 `conversationId` + `following` 布尔，这正是「宠物本体聚焦哪个会话」
所需的信号（对齐 agent-status 已有的 `summary.focus` 优先级机制）。

## 5. 【调研】未复现的事件（实现须按 unknown 处理）

`thread-stream-state-changed`（snapshot/patches）、`thread-read-state-changed`、
`thread-archived`/`thread-unarchived`、`thread-queued-followups-changed`、`query-cache-invalidate`。
本次 25 秒被动窗口内未触发（需要 App 内有活动任务才会发）。
**实现对这些一律按「未知事件」忽略，绝不猜测语义映射成 done——「绝不误报完成」是硬红线。**

## 6. 深链接（scheme 注册实录）

`lsregister -dump` 确认 `codex:` scheme 已注册（claimed schemes 含 `codex:`，归属 ChatGPT.app）。
格式 `codex://threads/<thread-id>`；调研实测两次跳转成功（含未加载、工作目录不同的任务）。
- **只接受 UUID 形态的 id 再拼 URL**，绝不拼接任意输入。
- `open` 返回成功 ≠ 页面真的打开（任务可能已删除/迁移）。无法从该协议获得呈现确认。

## 7. 稳定性边界

内部路由与内部 IPC **均无公开稳定性承诺**。实现必须封装成可关闭、可替换的适配器：
解帧失败/握手失败/未知版本 → 立即停用 IPC，退回 Hooks 通道，不影响面板既有功能。

## 8. 2026-09-11 第二轮实测：被动通道的真实事件面（App 任务摄入的依据）

> 探针方式同 §3（只读连接+被动监听），三次连接窗口，期间由用户在 Codex App
> （ChatGPT.app 内）真实提交并跑完两个任务。原始帧存维护者本机会话记录。

### 8.1 `thread-stream-state-changed` 对被动外部 client 不广播【实录·反证】

两个任务全程（提交→运行→出结果）被动连接**一帧 stream-state 都收不到**，
即便 App 正在跟随（following:true）该会话。结论：它只定向发给 App 内部订阅方
（`broadcast` 帧带 `targetClientIds`，只发目标 client）。**被动摄入不能依赖它**；
主动订阅 = 向未知 method 发请求，违反 §5 红线，不做。

### 8.2 实录到的新消息（相对 §4 新增）

| 消息 | 顶层字段 | params 字段 | 实录时机 |
|---|---|---|---|
| `broadcast` / `thread-read-state-changed` | `type, method, sourceClientId, params, version:3` | **`conversationId, hostId, hasUnreadTurn`**, `context{identity{kind,authMode}, executionHostKey}` | 回合结束时刻（两次任务各一条，均带 `hasUnreadTurn:true`） |
| `broadcast` / `thread-queued-followups-changed` | 同上, `version:1` | **`conversationId, messages[]`** | 提交任务时刻（队列变化） |
| `broadcast` / `client-status-changed` | `type, method, sourceClientId, version:0` | `clientId, clientType, status:'disconnected'` | 别的 client 断开时 |
| `broadcast` / `query-cache-invalidate` | 同上 | `queryKey[]` | 与 queued-followups 同刻 |

### 8.3 `hasUnreadTurn:true` = 回合结束的时序证据

- 任务一：提交 07:03:08Z（ide-context/queued-followups 帧），`hasUnreadTurn:true` 于 07:03:36Z（任务约 28s，出结果时刻）。
- 任务二（受控对时）：07:23:22Z 用户确认「还在跑」且 read-state 帧数为 0；07:24:27Z 帧到达，用户确认「刚跑完」。
- 反例：两个任务**运行中**均无 read-state 帧 → 它不是开始信号。

结论：`hasUnreadTurn:true` 可安全映射「回合完成（未读）」；`false` 表示用户已在 App 读过。
这是被动通道里唯一有资格映射成 done 的信号（映射表见 PROTOCOL.md「IPC 事件 → state 映射」）。

### 8.4 仍然拿不到的

- 会话的工作目录/标题（`ide-context` 是发给别的 client 的 discovery 请求，与会话无可靠关联）→ App 任务 `project` 用品牌名兜底。
- waiting（等批准）态：被动通道无对应信号，App 任务不会出现 waiting 行。
- 精确的任务失败信号：无；停留 running 超时由采集器转 unknown 兜底。

## 9. 2026-09-11 第三轮实测：会话标题在本地哪里（US-9 的依据）

- **App 与 CLI 共用 ~/.codex 线程库**：§8 实录 App 任务的 conversationId
  `01a08a1d-4f63-7e30-af03-48ae77b414b5`，在下面两处都查到同一条 AI 生成标题
  「查找 Codex 宠物多会话管理」——App 任务不是隔离存储。
- `~/.codex/sqlite/codex-dev.db` 表 `local_thread_catalog`（`thread_id → display_title`，
  另有 cwd/source_kind/时间戳）：由 App 的 app-server 维护（扫 rollout 生成），
  **App 在跑时当天更新**；实测覆盖 source_kind ∈ {cli, vscode}。读取需 node:sqlite
  （Node 22.5+ 内建；宿主 Electron 43 自带），一律 readOnly 打开。
- `~/.codex/session_index.jsonl`：每行 `{id, thread_name, updated_at}`。更新节奏不明
  （实测 mtime 落后当日会话一天+，exec 来源的会话未入索引）——只当次级兜底源。
- **rollout jsonl / thread_history_1.sqlite 均无标题字段**（session_meta 只有 cwd/originator 等）。
- IPC 被动帧里无标题（§8.4 维持成立）；ChatGPT.app 自身容器（com.openai.chat）的
  conversations-v3 是密文缓存、codex-taskItems 目录为空壳，均不可用。
- 两处皆**内部存储、无公开稳定性承诺**：实现（lib/codex-thread-titles.js）全失败路径
  静默降级，查不到就回落 hook 兜底标题/品牌名。

**Claude Code 侧对照结论**（同日实测 ~/.claude 全仓）：AI 生成的会话标题**不落盘**
（resume 列表标题是展示时临时派生；`~/.claude/sessions/<pid>.json` 的 name 是
`claude-39` 式派生编号，nameSource:'derived'）。本机能拿到的最好等价物 = 首条 prompt
首行截断，由 hook 经 `title` 字段写入（PROTOCOL.md）。
