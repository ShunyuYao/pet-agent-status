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

- 未运行 → 拉起；已运行 → 切前台。两者都是 `open -b <bundleId>`（macOS 天然 activate 语义）
- **图标水平居中**（autolayout `primaryAxisAlignItems:'CENTER'`），图标数量变化自动保持居中
- 没装 → **整个图标不出现**，不做灰态（点不动的入口＝死链）
- 右上绿点 = 该 App 有会话在跑，数据取现成 snapshot 的 `agent` 字段，**零新增采集**

### 本机实测的 bundle id

| App | 路径 | bundleId |
|---|---|---|
| Claude Desktop | /Applications/Claude.app | com.anthropic.claudefordesktop |
| WorkBuddy | /Applications/WorkBuddy.app | com.workbuddy.workbuddy |
| Codex | **ChatGPT.app** | com.openai.codex |

⚠️ Codex 没有独立的 `Codex.app`——`mdfind com.openai.codex` 解析到 `/Applications/ChatGPT.app`，
`lsregister` 里 `codex:` scheme 也确由它注册。检测必须按 **bundleId**，不能按 `/Applications/Codex.app` 路径。

### 底栏度量（定稿）

- 分隔线 y=358（面板 420 高）→ 底栏带高 **62**（初稿 84，太宽）
- 图标 34×34、间距 14、**水平居中**
- 图标底 y=406，贴面板底 padding 14
- 小标题「打开 App」删掉：占一整行且把视线拉到左边，与居中冲突

## 权限

复用既有 `nodeAccess` 的 `child_process` spawn `open`（README 权限披露第 3 行已声明
"`open -b` 把 Claude App 提到前台"）。**不需要新增 SDK 面，不需要 openExternal。**

## 待拍板

① 小标题已删（见底栏度量）。代价＝新手不知道会话行可点；若要补，
   建议放图标行右侧一句极短灰字，而不是恢复左上小标题
② 图标顺序固定 vs「有会话的排前面」（动态排序会跳动，倾向固定）
③ Codex 点击打开 ChatGPT.app 是否符合预期；若要的是 Codex CLI，那是终端不是 App，需另定义
