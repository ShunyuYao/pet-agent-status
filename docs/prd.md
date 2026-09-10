# PRD: agent-status 插件（本仓库范围）

> 完整产品背景在宿主仓 `docs/prd-agent-status-plugin.md`（2026-09-10 定稿）。本文件是其中
> **插件仓部分**的执行版；宿主侧手势/轮盘（原 US-5）与二期（折叠徽标、Codex App IPC）不在本仓库本轮范围。
> 权威附件：`PROTOCOL.md`（状态文件协议，已冻结）、`DESIGN.md`（UI 规格）、`AGENTS.md`（三条红线）。

## 概述

把本机 Claude Code / Codex CLI 会话状态实时显示在桌宠上：hooks 写状态文件 → tool 采集器
轮询推导五态 → panel 会话列表 + 宠物动画/气泡联动 → 点击行跳回终端（iTerm2/Terminal.app 精确，
其它终端激活兜底）。合规路径：manifest + `pet.*` SDK + nodeAccess 声明披露（见 README）。

## 目标

- agent 完成/待批准 3 秒内宠物给出可感知信号。
- 看到状态 → 回到对应终端 ≤ 2 次点击。
- 零宿主内核改动：宿主现有插件运行时原样加载本插件。

## 用户故事

- **US-001 协议库 + 插件骨架**：manifest（tool+panel）+ 状态文件读写库（原子写/解析校验/损坏容错）+ locales 骨架。
- **US-002 Claude Code hooks 一键接入**：hook 脚本（stdin JSON → 状态文件）+ settings.json 合并写入器（备份/幂等/可卸载）。
- **US-003 采集器状态机**：轮询、error/idle/unknown 推导、快照经 events 推给 panel、宠物联动（节流/勿扰降级）。
- **US-004 panel UI**：按 DESIGN.md 的会话列表 + 空态 + 排序 + 徽标两层区分 + 行内错误条。
- **US-005 跳回终端**：tty→iTerm2/Terminal.app 精确聚焦，进程树推断兜底激活，失败原位报错。
- **US-006 Codex CLI 接入**：按 `fixtures/codex-hooks-facts.md`（监工实测提供）同构接入，`agent:'codex'`。

各故事验收细则见 `scripts/ralph/criteria/US-00X.md`。

## 非目标

折叠徽标窗口形态；Codex App IPC/深链接；气泡可点击；其它 agent（Cursor/Gemini）；
token 统计；远程通知；tmux 内 tty 定位（兜底激活即可）。

## 成功指标

- 全部离线测试绿；三条红线（AGENTS.md）零违反。
- 真实 Claude Code 会话冒烟（由监工在宿主环境执行）：running/waiting/done 三态迁移 + 面板呈现 + 跳转命中。
