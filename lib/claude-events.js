'use strict';
// PROTOCOL.md「事件 → state 映射（hook 侧）」表的唯一实现处。
// 执行事实与发现事件分开；同步健康由采集器处理。

const EVENT_STATE = {
  SessionStart: 'idle',
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  PostToolUse: 'running',
  Notification: 'waiting',
  Stop: 'done',
  SessionEnd: 'stopped'
};

// 本插件需要挂钩的事件名（安装器写进 settings.json 的 key 集合）
const HOOKED_EVENTS = Object.keys(EVENT_STATE);

// Notification 是通用通知。类型字段优先，只认已知权限请求/闲置语义。
// 陌生类型、陌生文案不当成批准请求；不把闲置提醒用于刷新运行心跳。
const IDLE_NOTIFICATION_TYPES = ['idle_prompt'];
// 闲置提醒的文本特征（官方未公布逐字字符串，故只作为 matcher 缺席时的兜底）。
// 只匹配「等待输入」这一类措辞；权限类文案含 "permission"，绝不会命中这里。
const IDLE_MESSAGE_RE = /waiting for your input|waiting for input|idle/i;

// 这条 Notification 是不是「闲置提醒」（而非权限请求）。
function isIdleNotification(event) {
  if (!event || typeof event !== 'object') return false;
  // 1) 结构化字段优先。不同版本可能叫 matcher / notification_type，都认。
  const type = event.matcher || event.notification_type || event.type;
  if (typeof type === 'string' && type !== '') {
    return IDLE_NOTIFICATION_TYPES.indexOf(type) !== -1;
  }
  // 2) 没有结构化字段时才看文本。
  if (typeof event.message === 'string' && event.message !== '') {
    return IDLE_MESSAGE_RE.test(event.message);
  }
  // 两者都没有，不能证明闲置或批准请求。
  return false;
}

/**
 * 事件 → 落盘 state。
 *
 * @param {string} eventName  hook_event_name
 * @param {object} [event]    完整事件对象；Notification 需要它来判别两类语义。
 *                            缺少语义的 Notification 不写记录。
 * 未知事件返回 null → hook 静默忽略退出 0（Claude Code 以后加新事件也不会炸）
 */
function stateForEvent(eventName, event) {
  if (!Object.prototype.hasOwnProperty.call(EVENT_STATE, eventName)) return null;
  if (eventName === 'Notification') {
    if (isIdleNotification(event)) return 'idle';
    const kind = event && (event.matcher || event.notification_type || event.type);
    if (kind) return kind === 'permission_prompt' ? 'waiting' : null;
    return /needs your permission|permission to use/i.test(event?.message || '') ? 'waiting' : null;
  }
  return EVENT_STATE[eventName];
}

module.exports = { EVENT_STATE, HOOKED_EVENTS, stateForEvent, isIdleNotification };
