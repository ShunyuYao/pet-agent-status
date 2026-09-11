# UI 设计规格（权威：Figma 文件 `UJimpWGl2hGkrbzxIVCAK5`）

对照图（同稿导出）：`docs/design/panel-sessions.png`（会话列表）、`docs/design/panel-empty.png`
（空态）、`docs/design/legend-notes.png`（状态图例与标注）。实现与本文件冲突时以本文件+对照图为准。

## 设计 token（对齐宿主设计规范）

| token | 值 | 用途 |
|---|---|---|
| Ink | `#2A2E39` | 面板底色、深气泡 |
| Primary 蓝 | `#3D7EFF` | running 状态点/汇总胶囊 |
| 浅蓝副行 | `#8FB5FF` | running 副行文字 |
| Warning 橙 | `#F2994A` | waiting 状态点/描边/副行 |
| Success 绿 | `#27AE60` | done 状态点/副行 |
| Danger 红 | `#EB5757` | error 状态点/副行 |
| Gray | `#9AA0AC` | idle/unknown、辅助文字、时间 |
| 行底 | `#FFFFFF` 6% 不透明度 | 会话行背景（waiting 行：橙 13% + 1.5px 橙描边） |
| Claude 徽标底 | `#D97757` | 陶土橙 |
| Codex 徽标底 | `#0D0D0D` + 白 18% 描边 | 近黑 |

字体：中文 Noto Sans SC（思源黑体），数字/时间 Inter。字号：面板标题 16、项目名 13、
副行 11、时间 11、底部提示 10.5。

## 面板 · 会话列表（`panel-sessions.png`）

- 320 宽、Ink 底、圆角 20、内边距 14、行距 8；`resizable:false` 下高度由 manifest 定 420。
- 头部：标题「Agent 会话」+ 汇总胶囊 + 右侧 ✕（关面板）。汇总胶囊（2026-09-11 改版：白 8% 底、
  胶囊圆角）最多同屏 **两个状态段**，按 waiting > running > done 优先级取前两个非零状态，
  每段 = 状态色圆点 + `N 等待批准`/`N 运行中`/`N 已完成`（文字与点同色：橙/蓝/绿）——
  与宠物脚下折叠徽标（宿主限死 2 段）同一条取舍规则，两处内容一致。全零隐藏。
- 会话行（圆角 12，左起）：
  1. **agent 徽标 26×26 圆角 8**：厂牌看主图标（Claude=陶土底白色官方星标 SVG；Codex=黑底白色
     OpenAI 官方结标 SVG；WorkBuddy=绿底猫脸产品图，栅格 PNG 内联 data URI——无官方单色
     SVG，硬描反而失真。均打包本地资源，不引用远程）；**右下角 13×13 形态角标**：
     `>_`（CLI 终端会话）/ 窗口形（App 任务：Codex App 与 WorkBuddy）。
  2. 中列：会话标题（白 13；US-9：Codex 线程 AI 标题 > 终端标签标题（Claude Code 的
     AI 标题只在终端里，见 fixtures/terminal-titles-facts.md）> 首条 prompt 首行 >
     项目目录名兜底，有标题时目录名转 tooltip）+ 状态副行（11，颜色随状态：running 浅蓝/waiting 橙/done 绿/error 红/idle 灰）。
  3. 右列：状态点 8px + 相对时间（运行中显 `mm:ss` 计时，完成显 `N 分前`）。
- **聚焦会话标记**（2026-09-10 增补，对齐 Codex Pets「following」）：快照 `summary.focus` 指向注意力
  优先级最高的一行（waiting > running > error > done，同级取最新；每行带布尔 `focused`），该行左缘
  3px 白色 45% 细条（可与 waiting 橙描边叠加）；宠物本体联动同批合并时以它为主角，二期折叠徽标
  与 US-8 的 App following 都消费这个字段。
- **排序规则**：waiting 恒排最前（多条 waiting 按 ts 降序），其余按 ts 降序；idle 超 20 分钟移除。
- 底部提示（灰 10.5）：「点击会话跳回终端 · 完成时宠物会提醒你」。
- 点击行 = 跳回终端（US-005）；跳转失败在该行下方显示行内错误条（Danger 红文字），不弹窗不静默。

## 面板 · 空态（`panel-empty.png`）

头部同上；居中：灰圆图标（`>_`）→「还没有正在进行的会话」（白 14）→ 两行灰说明 →
主按钮「一键接入 Claude Code 钩子」（Primary 蓝底白字 12.5、圆角 10）→
次按钮/灰字「一键接入 Codex CLI 钩子」（US-006 落地前显示「即将支持」灰字，禁止假入口）。
已接入但无活跃会话时，主按钮区显示「已接入 ✓」态与「移除钩子」次入口。

## 面板 · 设置视图（2026-09-11 增补，无独立 Figma 稿——复用既有 token，不发明新样式）

- 入口：头部 ✕ 左侧加 ⚙ 齿轮钮（灰、hover 白，`-webkit-app-region:no-drag`）。点击在
  「列表/空态」与「设置」两个视图间切换；设置视图打开时隐藏列表、空态与底部提示，头部不变。
- 设置视图为分组列表（组间距 8，组 = 圆角 12、行底 `rgba(255,255,255,.06)`、内边距 10，
  与会话行同底同圆角）：
  1. **Codex App 实时增强**：标题（白 13）+ 说明（灰 11，多行）+ 右侧开关（checkbox 样式化：
     胶囊 34×20，开 = Primary 蓝、关 = 灰 25%）。**默认开**。下方状态副行（11）：
     已连接=Success 绿 / 连接中·未连接=灰 / 已停用（协议故障自动退回钩子）=Warning 橙。
  2. **Claude Code 钩子**：标题 + 接入状态副行（已接入 ✓ 绿 / 未接入 灰）+ 行内按钮
     （未接入 → Primary「一键接入」；已接入 → 灰字下划线「移除钩子」，同空态语义）。
  3. **Codex CLI 钩子**：同上，另在已接入时显示 Trust 提示（Warning 橙 10.5，同空态）。
  4. **关于这个插件**（2026-09-11 增补）：标题（白 13）+ Star 号召文案（灰 11，多行）+
     地址行：仓库地址（等宽 10.5 灰，`word-break:break-all`）与右侧「复制地址」钮
     （描边 `rgba(255,255,255,.18)`、hover 转 Primary；点击后 2s 内翻成「已复制 ✓」并转 Success 绿）。
- **「关于」区刻意不做成超链接**：宿主 SDK 没有任何 openExternal/shell 外开通道，插件面板窗
  也没装 `setWindowOpenHandler` —— `<a href>` 点了什么都不会发生。做成链接却打不开是**假入口**，
  比一个诚实的「复制地址」按钮更糟。`tests/panel-dom-test.js` 有一条断言钉死它不得出现在
  `href/src` 等加载属性里。
- **⚙ 是本插件设置的唯一入口**：宿主插件设置页的「设置」按钮只对内建插件白名单出现
  （`PluginDetailPage.tsx` 的 `hasPluginDetail`），第三方插件拿不到，所以 ⚙ 必须带
  `title`/`aria-label`，不能只是个光秃秃的字符。
- 开关与按钮只发意图事件，真改配置在 tool 侧（panel 无 fs，同空态接入按钮红线）。
- 文案全部走词表（`settings.*` 键），双语齐备。

## 宠物联动（不在 panel 内，经 pet.* SDK）

- done → `pet.playAnim`（收到消息动画）+ `pet.bubble('✅ <project> 的差事办完啦～')`。
- waiting → `pet.bubble('✋ <project> 在等你批准')`（橙语气，文案走 locale）。
- 节流：同会话同状态 5 分钟内最多提醒一次；勿扰/宿主动画冲突时降级为仅面板更新（US-003）。
- **同批合并（不轮流打扰）**：一轮 tick 内多个迁移只播一次动画、一条气泡——有 waiting 时它是主角
  （`bubble.mixed`：「✋ {project} 在等你批准 · 另有 {rest} 件新动静」），否则合并为
  `bubble.multiDone`（「✅ {n} 个差事都办完啦～」）；单迁移行为不变。

## 状态图例

running=Primary 蓝；waiting=Warning 橙（行高亮+置顶）；done=Success 绿；error=Danger 红
（推导态）；idle/unknown=Gray（unknown 文案与 idle 区分，绝不误报完成）。
