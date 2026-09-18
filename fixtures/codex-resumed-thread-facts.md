# Codex 历史任务续聊漏检（2026-09-18）

只读取任务状态、SQLite 白名单元数据和文件 stat，未读取会话正文。

## 本机事实

- Codex App 列表中的一个历史任务显示 active，插件状态文件仍停在前一天。
- `state_5.sqlite.threads` 中，该 App 任务 ID 对应的路径为
  `sessions/2026/09/17/rollout-<时间>-<App线程ID>_<运行线程ID>.jsonl`。
  该文件在调查时持续更新，stat 的 mtime 距当前时间约 11ms。
- 同一个 `thread_history_1.sqlite.thread_turns`，用 App ID 查询时最新回合为
  前一天的 interrupted；用文件名后缀的运行 ID 查询时是今天的 inProgress。
  `state_5.sqlite.threads` 中只有原 App ID 的目录记录，没有该运行 ID 的独立任务。
- 旧实现只接受单 UUID 文件名，拒绝上述文件；即使只放宽文件名，按 App ID 查到的
  旧 interrupted 回合仍会阻止 running 心跳。这是两个必须一起修复的条件。

## 自动化反证与回归

- 修改产品代码前，`test:codex-rollout-activity` 的双 UUID 文件夹具得到空活动集合；
  `test:codex-state` 的旧任务终态 → 内部 ID 改变后续聊，未恢复 running。
- 修复后，同一路径保持 App ID 为状态文件、行及跳转标识，只用经过边界校验的
  rollout_path 中的运行 ID 查回合。新回合序号可以小于旧回合，不能混排两个 ID。
- 覆盖近期发现、历史路径、元数据缺失、任务 ID 不匹配、重启、迟到完成通知、
  真正完成、收尾写入与已读；现有符号链接逃逸和子 Agent 过滤用例继续保留。
- 真宿主用例纳入 `test:codex-state-e2e`：隔离用户目录、独立调试端口、首帧隐藏。

该映射基于本机内部存储事实，无公开稳定性承诺。未知文件格式或不可用数据库仍
按既有规则降级，未新增状态字段，也不采集会话内容。
