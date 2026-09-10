'use strict';
// PROTOCOL.md「事件 → state 映射（hook 侧）」表的唯一实现处。
// hook 侧只写 running/waiting/done/ended 四种；推导态 error/idle/unknown 归采集器（US-003）。

const EVENT_STATE = {
  SessionStart: 'running',
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  PostToolUse: 'running',
  Notification: 'waiting',
  Stop: 'done',
  SessionEnd: 'ended'
};

// 本插件需要挂钩的事件名（安装器写进 settings.json 的 key 集合）
const HOOKED_EVENTS = Object.keys(EVENT_STATE);

// 未知事件返回 null → hook 静默忽略退出 0（Claude Code 以后加新事件也不会炸）
function stateForEvent(eventName) {
  return Object.prototype.hasOwnProperty.call(EVENT_STATE, eventName) ? EVENT_STATE[eventName] : null;
}

module.exports = { EVENT_STATE, HOOKED_EVENTS, stateForEvent };
