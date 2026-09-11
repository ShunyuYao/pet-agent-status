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

// ── Notification 的两类语义（2026-09-11 实录根因，见 fixtures/waiting-accuracy-facts.md）──
//
// `Notification` 是**通用通知事件**，不等于「在等你批准」。官方文档列出的 matcher 至少有
// `permission_prompt`（权限请求等待约 6s 后发）与 `idle_prompt`（会话闲置约 60s 发，
// 语义是「等你说话」而非「等你批准」）两类。
//
// 旧实现把 Notification 一律映射为 waiting，于是**闲置提醒也被显示成「等待你批准」**。
// 用户实测现象：compact 结束后会话闲着没动，60s 后面板把它标成等待批准。
// 实录佐证（803bf299）：`SessionStart:compact` @21:40:47 → `Notification` @21:41:47，
// 整整间隔 60s，正是 idle_prompt 的计时器，而该会话全程没有任何权限请求。
//
// 判别优先级：先认结构化的 matcher/类型字段（官方语义，最可靠），
// 拿不到再退回 message 文本启发式。
//
// ⚠️ 方向性保守：**拿不准一律按 waiting**（旧行为）。
// 漏报 waiting 的代价是用户错过一个真正在等他批准的会话——那正是本插件存在的理由；
// 误报 waiting 只是多看一眼。所以只在**确认是闲置类**时才降级，绝不做反向猜测。
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
  // 3) 两者都没有：保守按权限请求处理（见上「方向性保守」）。
  return false;
}

/**
 * 事件 → 落盘 state。
 *
 * @param {string} eventName  hook_event_name
 * @param {object} [event]    完整事件对象；Notification 需要它来判别两类语义。
 *                            不传时退回旧行为（Notification → waiting），保持向后兼容。
 * 未知事件返回 null → hook 静默忽略退出 0（Claude Code 以后加新事件也不会炸）
 */
function stateForEvent(eventName, event) {
  if (!Object.prototype.hasOwnProperty.call(EVENT_STATE, eventName)) return null;
  // 闲置提醒：会话还活着、只是在等用户说话，语义等同「跑着但没在等批准」。
  // 写 running 而不是 done —— done 会让面板显示绿色「已完成」，而它并没有完成。
  if (eventName === 'Notification' && isIdleNotification(event)) return 'running';
  return EVENT_STATE[eventName];
}

// ── 空会话：结束时什么都别留（2026-09-12 实录，fixtures/claude-desktop-facts.md §6）──
//
// Claude Desktop App 每开一个会话窗口都会甩出一个**不到 1 秒的空会话**：
// 只有 SessionStart→SessionEnd，没有提问、没有工具调用（实测 poll 抓到整条序列）。
// 照常落 ended 的话，面板显示绿色「已完成」、计进汇总胶囊与徽标，宠物还为它喊一声——
// 那是**误报完成**（PROTOCOL.md 红线）。与 Codex App「已读帧把刚开跑的任务翻成 ended」
// 同一类缺陷：任何状态都要有证据支撑，没干活就不该有「办完了」。
//
// **方向性保守**（同上面 Notification 那条）：只在能证明「它什么都没干」时才清除——
// 已有记录、且 lastEvent 仍停在 SessionStart（一步都没往前走）。
// 拿不到前一条记录（hook 中途才装、状态目录被清过、非 hook 系记录）时不做推断，
// 照旧写 ended：漏清一条空行只是噪音，错清一条真会话是丢失用户要看的东西。
function isEmptySessionEnd(eventName, existing) {
  return eventName === 'SessionEnd'
    && !!existing
    && existing.source === 'hook'
    && existing.lastEvent === 'SessionStart';
}

module.exports = { EVENT_STATE, HOOKED_EVENTS, stateForEvent, isIdleNotification, isEmptySessionEnd };
