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
