# Codex App 子 Agent 误收录（US-8，2026-09-13）

## 只读实测

代码基线 `78f3486`。本机插件状态目录 23 条 Codex 记录中，5 条与
`~/.codex/state_5.sqlite` 的子 Agent 身份吻合：来源分别为 4 条 IPC、1 条 rollout reconcile。
这只是磁盘记录，不代表面板当时同时显示 5 条；未读取真实会话正文。

可用元数据：

- `threads.source`：主任务为 `vscode` / `cli` 等字符串；子任务为 JSON，
  例如 `{"subagent":{"thread_spawn":{"parent_thread_id":"<UUID>","depth":1,"agent_path":"/root/child"}}}`。
- 还有 `{"subagent":{"other":"guardian"}}`；全部结构化子 Agent 32 条，其中
  7 条 thread_spawn、25 条 guardian。
- `threads.thread_source`：这 32 条里 12 条 `subagent`、20 条 `guardian_review`。
  只认 `thread_source=subagent` 会漏掉一部分内部任务。
- `thread_spawn_edges(parent_thread_id,child_thread_id,status)`：7 条明确 spawn 关系，
  以上 5 条误收录均存在对应关系。此表不是普通的用户 fork 关系。
- 以上 5 条不在 App `local_thread_catalog`；目录缺席只能旁证，不能用来过滤用户任务。

官方 [App Server 的线程来源过滤](https://learn.chatgpt.com/docs/app-server#list-threads-with-pagination--filters)
区分 subAgent / subAgentReview / subAgentCompact / subAgentThreadSpawn / subAgentOther，
并提供父/祖先线程筛选。这不构成本地数据库或私有 IPC 的稳定性承诺。

## 自动化复现与修复边界

`npm run test:codex-subagent` 使用临时 SQLite/日志文件与真实形态 IPC 帧，走生产
采集器和聚合器。修复前先证明父任务链路有效，再对明确子 Agent 输入 following、
活动、完成、已读事件，实际留下 `state=ended` 状态文件，触发“子 Agent 不应落盘”断言失败。

修复在摄入与聚合之前共用元数据身份，覆盖既有状态、增强开关和重启；保持父任务、
hook 记录和身份未知的任务。确认过的子 Agent 身份只在内存中缓存，不修改状态 schema，
不删除用户历史记录。元数据未到或库不可用时未知任务保守保留，恢复后重试分类。

`npm run test:codex-subagent-e2e` 使用首帧隐藏的隔离真宿主、临时 profile、独立动态
调试端口、预置插件授权。断言生产面板 DOM、汇总、聚焦、真实徽标、App 完成点和气泡：
子 Agent 不出现，父任务运行/完成仍正确，历史子 Agent 在关闭增强、重启与新回合后不复活。
测试已纳入 `test:codex-state` / `test:codex-state-e2e`，随离线与 UI 门禁运行。
