# 说明

本目录 payload 按 Claude Code 官方 hooks 文档字段结构预置（session_id/cwd/hook_event_name 等）。
监工做真实会话冒烟时会用实录 payload 替换/增补；结构冲突以实录为准并回写 PROTOCOL.md。

> 2026-09-10 更新：除 notification-permission.json（按官方文档结构预置，待实录）外，其余 6 个事件已替换为真实 Claude Code 会话实录（claude -p + --settings 录制壳，路径已脱敏）。
