# WorkBuddy（腾讯）会话状态调研实录

2026-09-11 首轮调研（静态 + 本机活体安装检查）；同日晚完成活体验证（§5）。
采集纪律与 codex-ipc-facts.md 相同：只看结构/元数据/键名，不采会话正文。

## 1. WorkBuddy 是什么

- 腾讯 CodeBuddy 团队 2026-03 推出的全场景 AI 办公工作台（"AI Agent 办公新范式"），
  与 CodeBuddy 共底座：CodeBuddy 管开发、WorkBuddy 管办公。
- **没有桌宠形态**：公开资料定位是"数字员工/办公搭子"；asar 全文搜
  `desktop-pet` / `desktopPet` / `桌宠` / `pet-window` / `petWindow` 零命中
  （`companion` 命中全是 Kotlin 语法高亮词表）。
- 本机已装 `/Applications/WorkBuddy.app`，5.2.2，Electron 37（bundle id
  `com.workbuddy.workbuddy`），调研时正在运行。

## 2. 进程拓扑（运行期实测）

- 主进程 Electron + 常规 Helper 进程，`--user-data-dir=~/.workbuddy/app`。
- 关键子进程：
  - `daemon-app-server-entry.js --stdio`（守护进程服务）；
  - `cli/bin/codebuddy --serve --port 57344`——**内嵌 codebuddy CLI（2.106.4）以
    本地 HTTP 服务模式跑 Agent**，MCP 配置里带 Bearer token（进程参数可见，勿外传）；
  - `sidecar-entry.js --token <uuid>`；
  - 内置 MCP app（ardot 设计 / weixinpay 等）。
- `~/.workbuddy/sessions/<pid>.json` 是 serve 进程的注册/心跳文件：
  `{pid, lastHeartbeat, sessionId:"interactive-<pid>", url:"http://127.0.0.1:<port>",
  kind, version, updatedAt}`，运行期间 lastHeartbeat 持续刷新。
  ——这是「WorkBuddy 的 agent 服务活着」的最廉价探针。
- 本地端口 `127.0.0.1:57344` 无鉴权可连通（未知路由返回 `No mapping found`），
  有 HTTP API 面但路由未探明；按被动只读纪律未做枚举。

## 3. 会话状态存储（核心发现）

### 3.1 SQLite `~/.workbuddy/workbuddy.db`（WAL，只读打开可行）

`sessions` 表直接就有状态列：

```
id TEXT PK, cwd, user_id, title, custom_title,
status TEXT NOT NULL DEFAULT 'Pending',
created_at, updated_at, last_activity_at, deleted_at,
is_playground, source_mode, is_background_automation, model,
expert_id…, permission_mode, use_sandbox_cli, mode, project_id
```

另有 `automations` / `automation_runs`（定时任务，thread 级 status）与
`session_usage`。`journal_mode=wal`，app 占用时 `file:...?mode=ro` 读取实测成功。

### 3.2 状态机（asar 源码字符串析出）

- 写入口：`updateSessionStatus(id, status, updatedAt)` →
  `UPDATE sessions SET status = ?, updated_at = ?`；
  持久化点之一：`deps.database.updateSessionStatus(finalEntry.id, finalEntry.status, …)`。
- 派生函数 `deriveTaskStatus(state)`（注释明说它产出 `SessionInfo.status`）：
  `archived` / `pending`（awaiting_input 或 turnSeq==0）/ **`planning`**（running+planning 阶段）/
  **`working`**（running）/ `terminated` / `error` / `failed` / `completed`。
- 关停清扫：`UPDATE sessions SET status='Terminated' WHERE LOWER(status) NOT IN
  ('completed','failed','terminated','archived')`——终态集合即这四个（比较是
  LOWER 的，落库大小写混用：默认 'Pending'、有 "Completed" 也有 "completed"）。
- ~~待活体验证~~ **已验证（§5）**：`working`/`planning` 在任务运行期间实时写库。

### 3.3 rollout 文件（与 Claude Code 同款布局）

`~/.workbuddy/projects/<路径转码目录>/<sessionId>.jsonl` + 同名子目录。
与 codex/claude 的 rollout 一样，任务运行期应持续追加——**mtime 新鲜度信号
可以直接复用本插件现成的 codex-rollout-activity 模式**（stat-only 不读内容）。
差异：目录按项目路径分组（无日期层级），扫描策略要改成「按目录 mtime 挑活跃项目」。

### 3.4 辅助信号

- `~/.workbuddy/tasks/<sessionId>/N.json`：todo 清单（类 Claude Code todos），
  `{subject, description, activeForm, status, id, createdAt, updatedAt}`。
- `~/.workbuddy/app/sessions.json`：会话索引
  `{conversationId, userId, workDir, startedAt, resumedAt}`——无状态字段，只能定位。
- `~/.workbuddy/logs/`、`traces/<n>/`：运行日志，未析出。

## 4. 结论（接入本插件的可行性排序）

1. **首选：SQLite 只读轮询**——`sessions.status` 是官方权威状态且含
   `working/planning` 运行态与 `last_activity_at`，`mode=ro` + WAL 并发读实测可行，
   无需逆向任何私有 IPC。风险：内部存储无稳定性承诺（7 月旧库仍兼容说明
   schema 靠 ALTER 演进，较稳）；全失败静默降级即可。
2. 兜底：projects/ jsonl mtime 新鲜度（现成模式），可兼作 3.2 待验证项的保险。
3. 探针：sessions/<pid>.json 心跳判「服务是否活着」。
4. 不走：57344 HTTP API（路由未知、无文档）、IPC 逆向（无必要，SQLite 已够）。

## 5. 活体验证实录（2026-09-11 晚，无需用户参与）

方法：带 `--remote-debugging-port=9340` 重启 WorkBuddy，CDP 走真实输入管线
（focus → `Input.insertText` → Enter 键事件）发一个最小任务（「请只回复 ok」），
同时 0.5s 轮询 `mode=ro` 只读 SQLite + projects/ jsonl mtime。录得完整序列：

```
23:54:03 DB 3dc39631 status=pending    updated_at=…040325 last_activity_at=None
23:54:03 JSONL 3dc39631 创建 size=0
23:54:04 DB 3dc39631 status=planning   （jsonl 同步开始追加，size=17540）
23:54:06 DB 3dc39631 status=working    （updated_at 秒级刷新，两次写入）
23:54:11 DB 3dc39631 status=completed  last_activity_at 同步落终值
```

结论确认：
- **`sessions.status` 是实时写的**（pending→planning→working→completed 各态独立落库，
  秒级粒度），`updated_at` 运行期持续刷新——SQLite 只读轮询单一信号即可覆盖
  运行中/结束两侧，不需要像 Codex 那样拼 IPC+rollout 双信号。
- jsonl rollout 与 DB 同步追加，兜底信号同样成立。
- **注意**：app 启动/关闭窗口期 DB 短暂锁死（openError/OperationalError 连续数秒），
  只读轮询必须把锁错误当常态静默跳过，不得据此判「WorkBuddy 不可用」。
- 验证残留：会话 3dc39631（「请只回复 ok」）留在用户 WorkBuddy 历史里，无害。

