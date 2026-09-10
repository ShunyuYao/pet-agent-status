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
- 头部：标题「Agent 会话」+ 汇总胶囊（蓝点 + `N 运行中`，蓝 18% 底、胶囊圆角）+ 右侧 ✕（关面板）。
- 会话行（圆角 12，左起）：
  1. **agent 徽标 26×26 圆角 8**：厂牌看主图标（Claude=陶土底白色官方星标 SVG；Codex=黑底白色
     OpenAI 官方结标 SVG，打包本地 SVG 资源，不引用远程）；**右下角 13×13 形态角标**：
     `>_`（CLI 终端会话）/ 窗口形（Codex App 任务，二期）。
  2. 中列：项目名（白 13）+ 状态副行（11，颜色随状态：running 浅蓝/waiting 橙/done 绿/error 红/idle 灰）。
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
