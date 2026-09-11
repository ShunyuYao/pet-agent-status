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
- 离线门禁只是下限；用户可感知的功能/修复另须真宿主 E2E，见下节「端到端测试（硬规矩）」。

## 端到端测试（硬规矩，对齐宿主仓 AGENTS.md 的 E2E 纪律）

离线单测证明不了「装进真宿主还能跑」——SDK 面、panel CSP、事件桥、徽标名额都只在真宿主里才暴露问题。因此：

- **每个用户可感知的功能或修复，必须至少配一条真宿主 E2E**：把本插件旁加载进**隔离宿主实例**跑通完整链路（状态文件 → tool 采集 → 面板行/宠物联动/徽标），断言用户可观测结果。隔离两要素缺一不可：显式 `PET_USERDATA_DIR` 指临时目录（绝不碰日常共享 profile），独立 `--remote-debugging-port`（本仓惯用 9335+，别抢 9222——那是宿主仓主实例与其它并发会话的）。
- **禁止模拟鼠标点像素**：宠物窗口鼠标穿透且像素命中不可靠。交互一律经 CDP 在对应 renderer console 执行 JS、或 `Input.*` 派发真实输入事件；断言 DOM 与状态，不断言「某函数被调用」。
- **E2E 窗口首帧前必须隐藏**：用宿主的预启动隐藏参数，不许先弹窗再最小化（会闪屏抢焦点）。只有隐藏渲染证明不了的原生行为（焦点、真实穿透、窗口拖动/贴边）才允许可见测试，且要先告知用户。
- **修 bug 先复现**：没在自动化里复现出用户描述的现象，就不算定位到根因，不许动代码。修完重跑同一路径确认现象消失，并顺带检查相邻功能没被弄坏。
- **输入必须是用户/系统真实动作的等价物**：伪造状态文件、真实 hook 事件 JSON 喂 stdin、CDP 输入事件都算；直接 set 内部标志再断言，是与实现同源的自证，不作数。
- E2E 脚本放 `tests/e2e/`，**不进** `tests/*-test.js` 离线门禁（离线套件保持不联网、不起 Electron 的性质）；但每个功能收尾、以及发版/上架 registry 前，相关 E2E 必须跑过全绿并在提交信息里写明跑了哪条。
- **现有 E2E：`tests/e2e/dismiss-e2e.js`**（旁加载安装 → 面板渲染 → 点完收起 → 新动静复现 → 运行中不收起）。
  改动涉及面板渲染、跳转、状态推导、安装管线时都要跑它。
- **断言前先证明「这条路真的通着」**：本轮首跑就栽过——夹具写了 `tty: null`，面板压根没给那行绑点击，
  「点完消失」的断言测的是空气。凡是测交互，先断言该元素处于可交互态，再测交互结果。
- **发版清单（每次都走完，不许凭 CI 绿灯就宣称发布完成）**：
  离线 12 套件 → 相关 E2E → commit+tag → CI success → Release 产物 sha256 与本地一致 →
  **registry 更新并经 GitHub API（非 raw，raw 有 CDN 缓存）回读确认实际内容**。
  漏过一次：0.5.1 的 CI 绿了但 registry 还停在 0.5.0，用户从市场装不到。

## 环境与工程惯例

- Node 22+，纯 JS（无 TypeScript、无构建步骤）；panel 为单文件 `panel/panel.html`（内联
  script/style，宿主 panel CSP 为 `script-src 'self' 'unsafe-inline'`）。
- 路径可覆盖约定（测试隔离用）：状态目录 `PET_AGENT_STATUS_DIR`、Claude 配置
  `PET_AS_CLAUDE_SETTINGS`、Codex 配置 `PET_AS_CODEX_HOOKS`，默认值见 PROTOCOL.md。
- commit：中文直述主题，前缀 story 编号，trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 不发版、不打 tag、不 push（由维护者做）。
- 文案双语：`locales/zh-CN.json` + `locales/en.json`，代码里不硬编码中文。
