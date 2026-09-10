# Ralph Codebase Knowledge — pet-agent-status

> 跨运行持续积累。实施/验证 agent 每次开始前必读。

## 项目形态（先建立正确心智模型）

- 这是**桌宠宿主的插件**，不是独立应用：入口是 `manifest.json` + `tool/index.js`（宿主
  utilityProcess 里跑，`activate(pet)` 收到 SDK 对象）+ `panel/panel.html`（宿主 BrowserWindow
  里加载，`window.pet` 由宿主 preload 注入）。**本仓库自己跑不起来 UI**，离线测试就是全部门禁。
- 宿主契约只读参考路径见 `AGENTS.md`「宿主契约」节；**不得使用 sdk-surface.js 里不存在的
  `pet.*` 方法**（panel 上下文没有 scheduler/net，tool 才有）。
- `pet.scheduler.every(ms, fn)` 是异步的（返回 Promise 的 taskId，必须 await 存 id），最小间隔
  被宿主钳到 1000ms；插件 deactivate 时宿主自动取消定时器，但自己 `setInterval` 的要自己清。
- panel↔tool 只经 `pet.events.emit/on`；事件名带 `agent-status:` 前缀防撞。

## 测试模式（本仓库的"真实通道"边界）

- hook 脚本测试：用 `fixtures/` 里的真实事件 JSON 喂 stdin（`node hooks/xxx.js < fixture.json`
  或 spawn 写 stdin），断言状态文件内容。**不许直调脚本内部函数自证**。
- 路径隔离：所有测试用 `mkdtemp` 临时目录 + `PET_AGENT_STATUS_DIR`/`PET_AS_CLAUDE_SETTINGS`
  环境变量覆盖，绝不读写真实 `~/.claude`、`~/.local/state`。
- panel DOM 测试：`jsdom`（已装在 devDependencies）加载 `panel/panel.html`，注入 mock
  `window.pet`（events.on 触发快照），断言渲染出的 DOM（行数/排序/class/文案）。
- osascript 不真跑：跳转模块设计成「生成 AppleScript 文本的纯函数 + 薄执行壳」，测试断言
  生成文本与目标 tty/应用匹配；真实聚焦冒烟由监工做。
- 时间相关逻辑（stale/idle/节流）把 `now` 作为可注入参数，测试不 sleep。

## 已知事实

- Claude Code hooks 官方事件：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
  Notification / Stop / SessionEnd（stdin 收 JSON，含 session_id/cwd 等字段）。映射表在
  PROTOCOL.md，hook 侧只写 running/waiting/done/ended 四种，推导态归采集器。
- Codex CLI 的 hooks 机制**待监工本机实测**（`fixtures/codex-hooks-facts.md`）；该文件不存在时
  US-006 不许开工（防照猫画虎写出对不上真实事件名的实现）。
