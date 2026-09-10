# pet-agent-status — 项目协作规则（单一来源）

桌宠（吐梨邦）的 agent-status 插件：把本机 Claude Code / Codex 会话状态实时显示在桌宠上
（插件面板会话列表 + 宠物动画/气泡联动 + 点击跳回终端）。**这是一个宿主插件，不是独立应用。**

## 三条项目红线（每个 story 的固有验收维度）

1. **插件形态红线**：所有能力只经三条合规通道——① manifest 声明的 `pet.*` SDK；② 按
   nodeAccess 声明披露制使用的 Node 内建（仅限 README「权限披露」节列明的用途：读写
   `~/.local/state/pet-agent-status/`、接入时改 `~/.claude/settings.json` 与 Codex hooks 配置、
   跳转时 spawn `osascript`）；③ panel 内纯 HTML/JS（消费 `window.pet`，无框架、无 CDN、
   无远程资源）。**禁止**：要求宿主改代码才能跑、动态拼接 require、eval/new Function、
   自更新逻辑、采集会话正文。
2. **设计红线**：panel 视觉与交互以 `DESIGN.md` 为准（颜色 token、尺寸、排序规则、徽标两层
   区分、空态、文案），不得自行发明样式。对照图在 `docs/design/*.png`。
3. **协议红线**：状态文件读写严格符合 `PROTOCOL.md` schema:1；改协议=升 schema 并保持向后
   兼容读取，且必须先改 PROTOCOL.md 再改代码。

## 宿主契约（只读参考，绝不修改宿主仓）

宿主仓在本机 `/Users/shunyu/projects/desktop_pet/桌宠测试版`（只读参考）：

- manifest 格式与校验：`demo/core/plugin-runtime/manifest.js`（kind 取值：tool/panel/asset/skill/settings/service/dashboard-card；`entry.panel{src,width,height,title,transparent}`）
- SDK 可用面（tool/panel 上下文各自可见的方法）：`demo/core/plugin-runtime/sdk-surface.js`
- 参考插件（tool+panel 形态）：`demo/builtin-plugins/super-clipboard/`
- 类型定义：GitHub `ShunyuYao/pet-plugin-types`

**不得引用/假设 sdk-surface.js 里不存在的 `pet.*` 方法**；拿不准就去读那个文件。
本插件用到的面：`storage` `pet`（bubble/playAnim/speak）`ui`（openPanel/closePanel/setPanelPinned）
`events`（emit/on）`scheduler`（every/cancel，注意 await 取 id、最小间隔 1s）。

## 质量门禁（每次提交前）

- 改过的每个 `.js/.mjs` 文件 `node --check` 通过。
- `for t in tests/*-test.js; do node "$t"; done` 全绿（tests 全部离线：不联网、不起 Electron、
  不读写真实 `~/.claude` 与 `~/.codex`——一律用临时目录夹具 + 环境变量覆盖路径）。
- panel 的 DOM 断言用仓内已装的 `jsdom`（`require('jsdom')`）。
- 测试里派发的输入必须是「用户/系统真实动作」的等价物：hook 脚本用真实事件 JSON 喂 stdin，
  不许直调内部函数自证；断言用户可观测结果（文件内容/DOM/生成的 osascript 文本），
  不断言「某函数被调用」。

## 环境与工程惯例

- Node 22+，纯 JS（无 TypeScript、无构建步骤）；panel 为单文件 `panel/panel.html`（内联
  script/style，宿主 panel CSP 为 `script-src 'self' 'unsafe-inline'`）。
- 路径可覆盖约定（测试隔离用）：状态目录 `PET_AGENT_STATUS_DIR`、Claude 配置
  `PET_AS_CLAUDE_SETTINGS`、Codex 配置 `PET_AS_CODEX_HOOKS`，默认值见 PROTOCOL.md。
- commit：中文直述主题，前缀 story 编号，trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 不发版、不打 tag、不 push（由维护者做）。
- 文案双语：`locales/zh-CN.json` + `locales/en.json`，代码里不硬编码中文。
