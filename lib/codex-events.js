'use strict';
// PROTOCOL.md「Codex CLI 事件映射」表的唯一实现处。
//
// 每一行都来自 fixtures/codex-hooks-facts.md（监工在 codex-cli 0.153.4 本机实测），
// **不是照 Claude Code 抄的**——两边事件名恰好大面积重合，但等待态的事件名不同：
// Claude Code 是 `Notification`，Codex 是 `PermissionRequest`。把 Notification 也
// 收进来看着"更宽容"，实则是凭记忆给 Codex 编了个它不会发的事件名，正是 criteria §6
// 明令 FAIL 的那种照猫画虎。表里只放 facts 文件写下的事件。

const EVENT_STATE = {
  SessionStart: 'running',      // 实录
  UserPromptSubmit: 'running',  // 实录
  PreToolUse: 'running',        // 二进制确认
  PostToolUse: 'running',       // 二进制确认
  PermissionRequest: 'waiting', // 二进制确认；Codex 的权限等待事件
  Stop: 'done',                 // 实录
  SessionEnd: 'ended'           // 实录
};

// 安装器写进 hooks.json 的 key 集合。
const HOOKED_EVENTS = Object.keys(EVENT_STATE);

// 未知事件返回 null → hook 静默忽略退出 0。facts 里「二进制确认存在但语义待实录」的
// 那几个（PreCompact / PostCompact / SubagentStart / SubagentStop / Interrupt）走这条路：
// 宁可不显示，也不猜一个状态。Interrupt 尤其危险——猜成 done 就是误报「差事办完啦」。
function stateForEvent(eventName) {
  return Object.prototype.hasOwnProperty.call(EVENT_STATE, eventName) ? EVENT_STATE[eventName] : null;
}

// Codex 的 session_id 实测就是线程号（UUID v7），可拼 `codex://threads/<id>` 深链接。
// 但 threadId 在协议里是选填的，只有确实长成 UUID 才写——形态对不上就不写，
// 不造一个下游拼出来是死链的假值（PROTOCOL.md 字段表标注 threadId 为 UUID）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function threadIdOf(sessionId) {
  return typeof sessionId === 'string' && UUID_RE.test(sessionId) ? sessionId : null;
}

module.exports = { EVENT_STATE, HOOKED_EVENTS, stateForEvent, threadIdOf, UUID_RE };
