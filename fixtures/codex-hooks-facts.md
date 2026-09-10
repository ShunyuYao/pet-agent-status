# Codex CLI hooks 实测事实（US-006 前置门）

> 实测环境：codex-cli 0.153.4，macOS，2026-09-10。实录方式：临时 `CODEX_HOME` 挂记录 hook，
> 真跑 `codex exec --dangerously-bypass-hook-trust`，stdin 原样落盘（`fixtures/codex-events/*.json`）。
> 证据分级：【实录】= 真实会话抓到；【二进制确认】= CLI 二进制 wire 结构里确认存在、未实录。

## 配置

- 配置文件：`$CODEX_HOME/hooks.json`（默认 `~/.codex/hooks.json`）。
- **schema 与 Claude Code settings.json 的 hooks 段同构**，以下形状实测生效：

```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "/abs/path/hook.sh"}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "/abs/path/hook.sh"}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "/abs/path/hook.sh"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "/abs/path/hook.sh"}]}]
  }
}
```

- 支持字段（二进制确认）：`matcher`、`timeout`/`timeoutSec`、`disableAllHooks`、`if`、`async`。
- **hook trust 机制**：hooks.json 新增/变更后，交互式 TUI 首启会弹「Hooks need review →
  Trust all and continue」；信任状态存 `hooks.state`。非交互旁路 flag：
  `--dangerously-bypass-hook-trust`。**installer 不得自动写 hooks.state**（尊重安全机制）；
  接入成功后面板需提示「下次启动 Codex 时请确认信任本插件钩子」。

## 事件与 payload（stdin JSON，一事件一进程调用）

| 事件 | 证据 | 字段（实录全集） |
|---|---|---|
| `SessionStart` | 【实录】 | `session_id` `transcript_path` `cwd` `hook_event_name` `model` `permission_mode` `source` |
| `UserPromptSubmit` | 【实录】 | 上述 + `prompt` `turn_id` |
| `Stop` | 【实录】 | 上述 + `stop_hook_active` `last_assistant_message` `turn_id`（无 `prompt`/`source`） |
| `SessionEnd` | 【实录】 | `session_id` `transcript_path` `cwd` `hook_event_name` `reason` |
| `PermissionRequest` | 【二进制确认】 | wire 结构存在（`PermissionRequestHookSpecificOutputWire`），待实录；映射 waiting，实现须容忍未知字段 |
| `PreToolUse` / `PostToolUse` / `PreCompact` / `PostCompact` / `SubagentStart` / `SubagentStop` / `Interrupt` | 【二进制确认】 | 同名 wire 结构存在；映射同 PROTOCOL.md Claude Code 表（Interrupt→done 待定，先按 running 链路忽略） |

## 映射结论（写进 PROTOCOL.md Codex 表）

- `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse` → `running`
- `PermissionRequest` → `waiting`（Codex 的权限等待事件，对应 Claude Code 的 Notification）
- `Stop` → `done`；`SessionEnd` → `ended`
- **`threadId` = `session_id` 本身**（UUID v7 形态，如 `01a08ab6-557f-77b3-bc37-3553f712b2e0`，
  即 `codex://threads/<id>` 可用的线程号）——状态文件 `threadId` 直接写 `session_id`。
- `agent:'codex'`；`tty`/`pid` 采集方式同 Claude Code hook（进程自查）。

## 实录夹具

`fixtures/codex-events/`：session-start.json / user-prompt-submit.json / stop.json /
session-end.json（本次实录原文，仅 transcript_path 中的临时目录路径已泛化）。
PermissionRequest 夹具按 Claude Code Notification 结构 + `hook_event_name:"PermissionRequest"`
预置，标注「待实录校准」。
