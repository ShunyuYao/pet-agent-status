# 终端标签标题实测事实（US-9 增强：Claude Code 的 AI 标题在终端里）

> 2026-09-11 本机实测（iTerm2 + Terminal.app 各若干真实 Claude Code / Codex 会话）。
> 结论：Claude Code 会把 **AI 生成的会话标题**经终端转义序列（OSC 标题）推给终端，
> 磁盘上没有（见 codex-ipc-facts.md §9 的 Claude 侧结论），但终端进程里有，
> 且两家终端的 AppleScript 接口都能**按 tty** 查回来——与状态文件的 `tty` 字段正好对上。

## 1. iTerm2（实录）

```applescript
tell application "iTerm2"
  repeat with w in windows / tabs of w / sessions of t
    (tty of s) & " | " & (name of s)
```

实录输出（节选，格式 = `tty | name`）：

```
/dev/ttys017 | ◑ Desktop pet 插件调研与评估 (claude)
/dev/ttys023 | ✳ Agent session插件能力 (claude)
/dev/ttys022 | 桌宠测试版 (codex)
```

- **形态**：`[状态符号 ]<标题>[ (claude)|(codex)]`。状态符号随会话忙闲变化
  （实录见 ✳ ◐ ◑，是 Claude Code 自己的 spinner，不属于标题本体），后缀是厂牌括号。
- Codex CLI 会话的终端标题只是目录名（Codex 不推 AI 标题进终端）——Codex 的
  AI 标题走线程目录（codex-ipc-facts.md §9），终端标题只配当兜底。

## 2. Terminal.app（实录）

```applescript
tell application "Terminal"
  repeat with w in windows / tabs of w
    (tty of t) & " | " & (custom title of t)
```

实录输出（节选）：

```
/dev/ttys002 | ✳ Desktop pet meetings notes
/dev/ttys001 | ✳ 假期请假和缺勤记录
```

- 有状态符号前缀、**无**厂牌后缀。`custom title of tab` 即所见标题。

## 3. 守卫与坑（实录）

- **`tell application "X"` 会把没在跑的 X 拉起来**——查询前必须先判 `is running`。
- `application id "<不存在的 bundle id>" is running` 会**直接抛错**（-1728），
  不是返回 false —— 每家终端的查询块必须各自 `try ... on error` 包裹，
  一家没装/报错不影响另一家。
- `is running` 属性检查本身不会启动目标 App。
- osascript 需要宿主的自动化（Automation）授权——与既有跳转功能（terminal-jump）
  同一份授权，不新增权限面。

## 4. 实现边界（lib/terminal-titles.js）

- 一次 osascript 调度把两家终端全部 `tty | title` 拉回来建 Map，TTL 缓存
  （每 tick 查 Map，不每 tick spawn）。
- 清洗：去掉开头状态符号（非字母数字的 1–2 个码点 + 空格）与结尾 ` (claude)`/` (codex)`
  厂牌后缀；清洗后为空 → 视为没有标题（不造假名）。
- 展示优先级（tool 侧注入，aggregate 零厂牌特判不变）：
  Codex 线程目录 AI 标题 > 终端标签标题 > 落盘 title（首条 prompt 首行）> project。
- 失败路径（osascript 缺失/超时/未授权/两家都没跑）一律静默返回空 Map，TTL 后重试。
