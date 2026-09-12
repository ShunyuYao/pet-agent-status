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
2. **设计红线**：最新在线 Figma 是视觉权威；`DESIGN.md`、`docs/design/*.png` 和测试都是缓存。实现前读取当前节点；若缓存落后，先更新规格和断言再改实现。不得为了让旧测试通过而保留旧尺寸。

   **画过设计稿的功能，实现必须逐项对照设计稿，不许只对照文字规格**（2026-09-12 教训）：
   底栏 App 启动器在 Figma 里画的是**三个真实彩色 App 图标**（从本机 .app 抽出的
   AppIcon），实现却复用了会话行那套**单色厂牌 SVG**，出来是灰底白描边的剪影 ——
   尺寸、间距、居中全都符合我自己写的文字规格，唯独**长得不是设计稿那个样子**，
   E2E 还全绿（断言只问「画出来了吗」，没问「画的是不是那张」）。
   - **有设计稿就必须开图比对**：`get_screenshot` 拉设计稿、真宿主截一张实现图，
     两张并排看。文字规格（多少 px、什么间距）只是设计稿的**投影**，对齐投影 ≠ 对齐原图。
   - **断言要问「是哪张图」而不是「有没有图」**：`!!querySelector('svg,img')` 这种
     存在性断言对「画错了但画了」恒真。素材类断言要钉住可识别特征
     （如 data URI 前缀/尺寸/关键色值），否则就是把渲染层假阳性写进门禁。
   - 素材来源不确定时**先问用户**，别拿手边现成的顶上去。
3. **协议红线**：状态文件读写严格符合 `PROTOCOL.md` schema:2（兼容读取 schema:1）；改协议=升 schema 并保持向后
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
- 每条新测试必须有命名 npm 入口，并纳入离线或相关领域门禁；UI 改动运行 `npm run test:ui`（离线 + 隐藏宿主 UI E2E）。
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
- **取证工具本身也要验伪**（2026-09-11 教训）：查「等待批准误报」时，用 Claude Code 的会话
  transcript（`~/.claude/projects/*/<sessionId>.jsonl` 里的 `hook_success` attachment）统计
  hook 触发次数，得出「本插件 hook 从没跑过」——**是错的**。transcript 只记录**有 stdout 的
  hook**，而本插件按「绝不打扰会话」铁律静默无输出，因此永远不出现在里面。
  差点据此改错地方。判定「hook 有没有跑」要看**状态文件的 `ts` 是否前进**，不是看 transcript。
  一般化：拿一个工具当判据前，先确认它对**已知为真**的情形给出阳性，否则整条推理链都是空的。
- **输入必须是用户/系统真实动作的等价物**：伪造状态文件、真实 hook 事件 JSON 喂 stdin、CDP 输入事件都算；直接 set 内部标志再断言，是与实现同源的自证，不作数。
- E2E 脚本放 `tests/e2e/`，**不进** `tests/*-test.js` 离线门禁（离线套件保持不联网、不起 Electron 的性质）；但每个功能收尾、以及发版/上架 registry 前，相关 E2E 必须跑过全绿并在提交信息里写明跑了哪条。
- **Codex 状态修复 E2E：`npm run test:codex-state-e2e`**：完成屏障、旧任务续聊、已读、重启及宠物气泡。改 Codex 摄入、rollout 扫描或回合元数据读取时必跑。
- **现有 E2E：`tests/e2e/dismiss-e2e.js`**（旁加载安装 → 面板渲染 → 点完收起 → 新动静复现 →
  运行中不收起 → 设置视图「关于」区与 ui.copyText 桥）。
  改动涉及面板渲染、跳转、状态推导、安装管线时都要跑它。
- **`tests/e2e/waiting-accuracy-e2e.js`**（0.8.2）：闲置提醒不被误报成「等待你批准」。
  输入是 spawn 真 hook 喂真实事件 JSON（不手写状态文件——手写等于绕过被修的代码）。
  **改 `lib/claude-events.js` 的事件映射、或改面板状态渲染时必跑。**
  根因取证见 `fixtures/waiting-accuracy-facts.md`。
- **该用例必须预置 `config.plugins.grants` 再启宿主**：宿主装外部插件会弹真实授权确认窗，
  而 `PET_E2E_HIDDEN` 下窗口不可交互，必然落到「拒绝」分支（`status=disabled` /
  `reason=用户拒绝授权`），插件永远激活不了。预置 grants 等价于用户点了「同意并启用」，
  走宿主自己的 savedSet 短路，不绕过权限逻辑。
- **剪贴板内容在本用例里读不回来，别再试**：宿主各 preload 都没有回读通道，renderer 侧
  `navigator.clipboard.readText()` 恒抛 "Document is not focused"（隐藏窗无真实焦点，
  CDP `Emulation.setFocusEmulationEnabled` 也不满足该权限检查，两种写法都实测失败）。
  故改为断言「真宿主 panel 桥确实暴露 ui.copyText」+「点击后按钮给出已复制反馈」两条，
  **不留"读不到就算过"的弱断言**——那是假绿。
- **断言前先证明「这条路真的通着」**：本轮首跑就栽过——夹具写了 `tty: null`，面板压根没给那行绑点击，
  「点完消失」的断言测的是空气。凡是测交互，先断言该元素处于可交互态，再测交互结果。
- **发版清单（每次都走完，不许凭 CI 绿灯就宣称发布完成）**：
  离线 12 套件 → 相关 E2E → commit+tag → CI success → Release 产物 sha256 与本地一致 →
  **registry 更新并经 GitHub API（非 raw，raw 有 CDN 缓存）回读确认实际内容**。
  漏过一次：0.5.1 的 CI 绿了但 registry 还停在 0.5.0，用户从市场装不到。

## 并发纪律：写新代码一律开 worktree（硬规矩）

代价换来的教训（2026-09-11）：两个会话同时在主检出的 main 上修同一个 bug，互相覆盖对方
未提交的文件，一份读侧修复一度被冲掉——离线测试还全绿，靠事后逐行核对才发现。因此：

- **写新代码、新功能、修 bug，一律先开独立 worktree**，不在主检出（`~/projects/pet-agent-status`
  的 main）上直接改：`git worktree add ../pet-agent-status-<主题> -b <类型>/<主题>`，在
  worktree 里开发、提交、跑门禁与 E2E。
- **结束后合并回 main**：先在 worktree 里拉齐 main 解决冲突，合并后在**主检出**再跑一遍
  离线套件 + 相关 E2E 确认没问题。
- **确认没问题后删掉 worktree 与分支**：`git worktree remove ../pet-agent-status-<主题>`
  + `git branch -d <分支>`，不留长期活着的旁支。
- 主检出只做四类事：读代码、跑测试、合并、文档/规则类小改。多会话并行时尤其如此——
  两个会话绝不同时在同一个检出（worktree 也算）里写文件。

## 环境与工程惯例

- Node 22+，纯 JS（无 TypeScript、无构建步骤）；panel 为单文件 `panel/panel.html`（内联
  script/style，宿主 panel CSP 为 `script-src 'self' 'unsafe-inline'`）。
- 路径可覆盖约定（测试隔离用）：状态目录 `PET_AGENT_STATUS_DIR`、Claude 配置
  `PET_AS_CLAUDE_SETTINGS`、Codex 配置 `PET_AS_CODEX_HOOKS`，默认值见 PROTOCOL.md。
- commit：中文直述主题，前缀 story 编号，trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 不发版、不打 tag、不 push（由维护者做）。
- 文案双语：`locales/zh-CN.json` + `locales/en.json`，代码里不硬编码中文。
