# 「等待你批准」误报的实录根因（2026-09-11）

用户现象：compact 刚结束的会话被面板标成「等待你批准」（截图里同屏 3 条 waiting，
其中一条正是用户当时正在操作的会话）。

## 取证方法

Claude Code 的会话 transcript（`~/.claude/projects/<项目>/<sessionId>.jsonl`）把
hook 触发记成 `attachment`：

```json
{"attachment":{"type":"hook_success","hookName":"SessionStart:compact",
  "hookEvent":"SessionStart","command":"...","exitCode":0}, "type":"attachment", ...}
```

⚠️ **这份记录并不完整，差点让我误判**：实录里本插件的 hook **一次都没出现**，
只有 `cc-status` 那条。一度据此推出「compact 没触发本插件 hook」的结论——是错的。
真相：transcript 只记录**有 stdout 的 hook**（`cc-status` 打印 "Session status updated."，
本插件按「绝不打扰会话」铁律静默无输出）。

验伪方法（已实测）：连续两次读本会话自己的状态文件，`ts` 在 7s 内前进了 7246ms，
证明本插件 hook 每个事件都在跑。**用 transcript 统计「某 hook 有没有跑」是不可靠的，
要用状态文件的 `ts` 是否前进来判定。**

## 实录结果

截图里三条 waiting 会话，Notification 触发次数统计（按 transcript，仅供参考方向）
均为 0，但如上所述该统计不可靠。真正的决定性证据是**时间间隔**：

| sessionId | 倒数第二个事件 | 状态文件 `Notification` 时刻 | 间隔 |
|---|---|---|---|
| `803bf299` | `SessionStart:compact` @21:40:47 | 21:41:47 | **整 60s** |

60s 是闲置提醒（idle_prompt）的计时器。该会话在这段时间里没有任何权限请求——
它只是 compact 结束后闲着没人理。

## 根因：`Notification` 被无条件映射为 `waiting`

`Notification` 是 Claude Code 的**通用通知事件**，不等于「在等你批准」。
官方文档（code.claude.com/docs/en/hooks）列出的 matcher 至少包含：

- `permission_prompt` —— 权限请求等待约 6s 后发，**真的在等批准**
- `idle_prompt` —— 会话闲置约 60s 发，语义是「等你说话」，**不是等批准**
- 另有 `auth_success` 等

旧实现 `Notification: 'waiting'` 把所有类别都写成 waiting，于是闲置提醒
也让面板显示「等待你批准」。

**官方未公布逐字 message 字符串**（文档只说「包含一个人类可读的 message」），
所以判别必须以结构化的 matcher 为主判据，message 文本只作兜底。

## 修法

`stateForEvent(eventName, event)` 接收完整事件对象：

1. 先认结构化字段 `matcher` / `notification_type` / `type`；
2. 缺席才退回 `message` 正则兜底；
3. **两者都没有 → 按 waiting**（保守方向）。

### 方向性为什么必须保守

漏报 waiting 的代价是用户错过一个真正在等他批准的会话——那正是本插件存在的理由；
误报只是多看一眼。所以只在**确认是闲置类**时才降级为 running，绝不做反向猜测
（「看着不像权限请求就当闲置」是错的方向）。

### 为什么闲置提醒映射 `running` 而不是 `done`

会话没有完成，只是在等用户说话。映射 done 会让面板显示绿色「已完成」，
撞上协议红线「绝不误报完成」。

## 附带确认：陈旧 waiting 的清除

真实批准之后 Claude Code **不发任何「已批准」事件**（直接继续 PreToolUse），
状态文件会停在 waiting 直到下一个事件覆盖。`SessionStart{source:"compact"}`
本就在映射表里（→running），实测确实能把陈旧 waiting 清回 running（已补回归测试）。
另有 `aggregate.js` 的 `STALE_UNKNOWN_MS`（3min）兜底，本轮不改其语义。

## Codex 侧不受影响

Codex 有独立的 `PermissionRequest` 事件，语义单一，不存在通用 Notification 的歧义。
