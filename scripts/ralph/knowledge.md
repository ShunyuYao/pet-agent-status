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
  > 2026-09-10 更新：该文件与 `fixtures/codex-events/*.json` 实录夹具已由监工提供
  > （Codex CLI 0.153.4，commit abb7290），US-006 前置门**已解锁**。

## 状态文件命名铁律（US-001 返工换来的，别再踩）

- 状态目录里区分「正式状态文件」与「写入中的临时文件」**只按 `.json` 后缀**：
  正式 = `<sanitizedSessionId>.json`；临时 = `.tmp-<id>-<pid>-<rand>.tmp`（不带 `.json`）。
- **任何地方都不许用 `.tmp-` 前缀判定文件性质**。`.tmp-` 是 PROTOCOL.md 白名单
  `[A-Za-z0-9._-]` 允许的合法 sessionId 内容，不是文件类型标记 —— 靠前缀过滤会把
  `.tmp-session` 这种真会话静默吃掉（records 少一条且 unknownCount 为 0，无诊断）。
- 推论（写测试时注意）：夹具里造临时文件必须与 `writeStatus` **真实产出同形**（`.tmp` 结尾）。
  上轮缺陷之所以溜过 18 条测试，就是因为夹具造的 `.tmp-halfway.json` 是现实中不存在的形态。

## 删除粒度必须等于身份粒度（US-002 第 3 轮返工换来的）

改用户配置时，**认领用什么粒度判定，就必须用什么粒度删除**。US-002 的 `isOurs` 按
「分组内某条 command」认领，却按**整个分组**删除 —— 用户把自己的命令追加进本插件写出的
那个分组（Claude Code 的 `hooks.<Event>[].hooks` 是数组，允许一组多条，手改配置时这么干
最顺手）时，他那条会被连带抹掉且无任何提示。这是不可逆的用户配置丢失。

推论（写「不误伤」类测试时注意）：**造了「不同分组共存」的用例不等于覆盖了「同一分组共存」**。
两者是不同的容器层级，前者绿不代表后者不炸 —— 上一版正是只造了前者才让缺陷溜过 21 条测试。
凡是「只删自己的」需求，用例都要同时覆盖「兄弟容器」与「同容器内兄弟元素」两种共存形态。
另：分组里还剩用户内容时，本插件的 marker 字段要一并去掉（那组已不属于本插件）。
