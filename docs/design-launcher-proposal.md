# 常驻徽标 + App 启动器（设计提案 · 2026-09-12）

Figma：`UJimpWGl2hGkrbzxIVCAK5` 第 ⑤ 区（y≈1920 起）
- `40:113` A · 徽标常驻三态
- `40:41`  C1 · 面板（有会话 + 新底栏）
- `40:81`  C2 · 面板空态（底栏照常在）
- `40:97`  D · 行为规格与待拍板三点

## 改动①：徽标常驻

现状 `lib/badge.js`「没有会话时 clear，不留空徽标」→ 宠物脚下空空，用户失去入口。

改为：无会话时发 **1 段 `muted` + 空文本**，视觉上只剩 chevron（24×28）。

**可行性已验证（读宿主源码）**：`runtime.js` `normalizeBadgeSegments` 要求
`raw.length >= 1`（空数组直接拒），但对 `seg.text` **只校验长度上限、不校验非空**，
故 `text:''` 合法。**无需改宿主。**

## 改动②：底栏换成 App 启动器

`panel.footer.hint`（"点击会话跳回终端 · 完成时宠物会提醒你"）换成一排可点 App 图标。

- 无待查看完成项时：未运行 → 拉起；已运行 → 切前台（`open -b <bundleId>`）。
- 有待查看完成项时：点图标或右上绿点，跳到列表顺序中的第一条该厂牌已完成会话，沿用会话行的导航与收起规则。有 tty 就定位终端，不按图标厂牌强制打开桌面 App；App 会话沿用已有深链接或激活兜底。
- **图标水平居中**（autolayout `primaryAxisAlignItems:'CENTER'`），图标数量变化自动保持居中
- 没装 → **整个图标不出现**，不做灰态（点不动的入口＝死链）
- **一个都没装 → 底栏整条不出现**（连分隔线一起），见下节
- 右上绿点 = 该厂牌有尚未点掉的 `done` 展示态会话，数据取现成 snapshot，**零新增采集**。每次只收起一条，还有完成项就保留绿点；全部点完后熄灭。运行中、等待批准不点亮该绿点。直接点击会话行也同步更新绿点，新完成事件按现有规则重新出现。执行失败时保留完成项与绿点以便重试。

以上交互语义由用户于 2026-09-12 明确修订，覆盖在线 Figma 中旧的 `running-dot` 命名；当日重新读取 `40:41` 设计原图和上下文，视觉素材、尺寸、位置仍以在线设计为准。

### 本机实测的 bundle id

| App | 路径 | bundleId |
|---|---|---|
| Claude Desktop | /Applications/Claude.app | com.anthropic.claudefordesktop |
| WorkBuddy | /Applications/WorkBuddy.app | com.workbuddy.workbuddy |
| Codex | **ChatGPT.app** | com.openai.codex |

⚠️ Codex 没有独立的 `Codex.app`——`mdfind com.openai.codex` 解析到 `/Applications/ChatGPT.app`，
`lsregister` 里 `codex:` scheme 也确由它注册。检测必须按 **bundleId**，不能按 `/Applications/Codex.app` 路径。

### 一个 App 都没装（C3 有会话 / C4 空态）

**底栏整条不渲染**：没有分隔线、没有图标、也**没有「未检测到 App」占位文案**。
列表区因此多出 62px，正好多显示一行会话。

不显示占位文案的理由：
- 「未检测到支持的 App」对用户是**零行动价值**的一行字——他不会因为看到它就去装
  Claude/Codex，反而占掉一行会话位。
- 与既有取向一致：没装的图标直接不显示而非给灰按钮。零个装只是同一条规则的极端值。

**这不是边缘情况**：纯 CLI 用户就是这一档——本机有 `claude`/`codex` 命令行，
但 `/Applications` 下一个 .app 都没有。插件对他完全可用（会话照常显示、点击照常跳回终端），
只是启动器无从可启。实测本机 `claude` 在 `~/.local/bin`、`codex` 在 `/opt/homebrew/bin`，
与三个 .app 是两回事。

实现判据：`detectedApps.length === 0` → 不渲染整个 footer。
⚠️ 是「检测到的 App 数」，**不是「hooks 有没有接入」**——后者是另一回事，
面板设置视图里已有独立的已接入/未接入展示，别混。

### 底栏度量（2026-09-12 按在线 Figma 40:41 / 40:23 刷新）

- 分隔线 y=358（面板 420 高）→ 底栏带高 **62**（初稿 84，太宽）
- 按钮 40×40，y=366；内层图片裁切框32×32、内缩4。源图片显示125%，偏移-12.5%，不改源图像素；静止时没有灰底承托
- 三按钮 x=86/140/194、间距14、**水平居中**；数量变成2/1仍居中
- 分隔线1px，距按钮顶7px；完成绿点8×8，相对按钮x=32/y=0
- 图标底 y=406，贴面板底 padding 14
- 小标题「打开 App」删掉：占一整行且把视线拉到左边，与居中冲突

## 权限

复用既有 `nodeAccess` 的 `child_process` spawn `open`（README 权限披露第 3 行已声明
"`open -b` 把 Claude App 提到前台"）。**不需要新增 SDK 面，不需要 openExternal。**

## 实现落地（0.11.0）

- `lib/app-launcher.js`：登记表（id/bundleId/name）+ 探测（mdfind 按 bundleId，5min 缓存）
  + `open()`（只认登记表 id，bundleId 绝不来自调用方）+ `pendingDoneFromRows()`
- `tool/index.js`：每轮 tick 推 `agent-status:apps`（已过滤数组），订阅 `agent-status:open-app`
- `panel/panel.html`：底栏渲染 + 空数组整条 hidden
- `lib/badge.js`：`segmentsFor` 空态改返回 `[{tone:'muted',text:''}]`（不再 null）

**图标必须是真实彩色 App 图标**（`assets/app-*.png` 的内联 data URI），
不是会话行那套单色厂牌 SVG —— 后者是「哪个厂牌的会话」，底栏是「打开哪个 App」，
语义与画法都不同。首版用错了素材，尺寸间距全对但长得不是设计稿，见 AGENTS.md 设计红线。

## 待拍板

① 小标题已删（见底栏度量）。代价＝新手不知道会话行可点；若要补，
   建议放图标行右侧一句极短灰字，而不是恢复左上小标题
② ~~图标顺序~~ **已定：固定 claude→codex→workbuddy**（动态排序位置会跳，毁肌肉记忆）
③ ~~Codex 打开 ChatGPT.app~~ **已定：符合预期**（用户 2026-09-12 确认）
