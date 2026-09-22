# ASR-011：完成气泡保留宿主当前姿态

2026-09-22 用户确认：宿主先合并姿态保护，插件也独立修复。插件在新 worktree 开发；不发版、不打 tag、不推送。

## 行为决定与实现

任务完成仅请求 `pet.bubble`，不再请求 `pet.playAnim('unread')`。插件无法可靠获知宿主贴边、睡眠、拖拽等状态，因此由宿主处理气泡是否伴随说话动作。完成文字、状态行、徽标、批量合并、节流和已读逻辑保持原样。`DESIGN.md` 已同步本次用户确认的行为决定；没有改变界面布局或素材。

删除未接入真实状态的 `playAnimGuard`、未读动作常量与宿主动作名快照。旧“必须发送合法动作名”的测试随取消强制动画退役，改由单次/合并完成气泡断言和真实宿主姿态回归覆盖；不是回滚或删掉失败断言来制造通过。

## 复现与验收

新增 `npm run test:completion-pose-e2e`，纳入 `test:ui-e2e`：

- 通过真实 hook stdin 输入 UserPromptSubmit / Stop，先验证落盘 running，再等真实采集器渲染 running / done。
- 睡眠经公开 SDK 请求，贴边经宿主既有窗口位置与松手判定入口进入；不直接写 pet.state / edgeSide。
- 必须同时看到完成文字和完成行，且睡眠/左贴边/右贴边姿态跨下一轮真实快照仍保留。
- 修复前观察到 sleep → speak，断言失败；修复后同一路径三种姿态通过。
- 隔离临时 profile 与随机 CDP 端口，首帧前隐藏；不访问日常 Claude/Codex 配置，不控制用户鼠标。

所有 `tests/*-test.js` 离线测试通过。`npm run test:ui` 的布局、启动器、dismiss、waiting-accuracy、滚动、面板打开等均通过；首次在 Codex 测试末段因测试宿主进程退出而中断。单独重跑 codex-state-e2e（含子任务）、reliability-e2e、completion-pose-e2e 全部通过，完整 UI 门禁的各组成套件均完成。合并后另在主检出重跑离线套件和姿态 E2E。宿主修复 `7630bbc1` 已合并本地 main，并通过主检出姿态回归及契约门禁；这不等同于发布安装包。
