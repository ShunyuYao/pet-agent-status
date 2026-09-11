'use strict';
// Codex App 任务摄入：IPC 回调 → 状态文件（PROTOCOL.md「Codex App 来源」的唯一实现处）。
//
// 映射依据是 fixtures/codex-ipc-facts.md §8 的实录，映射表冻结在 PROTOCOL.md：
//   activity（queued-followups 变化，提交任务时刻发）→ running（启发式，误报由
//     采集器 3min 无新事件转 unknown 兜底）
//   read-state hasUnreadTurn:true（仅回合结束时刻发，时序实验 §8.3）→ done
//   read-state hasUnreadTurn:false（用户在 App 读过了）→ ended，且**只更新不新建**——
//     对没见过的会话新建一条 ended 是在报旧闻
//
// 两条保护，都是「摄入不许压过更富的数据源」：
//   ① conversationId 必须是 UUID 形态（同 codex-deeplink 的白名单精神，脏 id 不落盘）
//   ② 同 sessionId 已有 source 非 'ipc' 的记录（CLI hooks 写的，含 tty）时跳过不覆盖

const path = require('path');
const stateFiles = require(path.join(__dirname, 'state-files.js'));
const { isValidThreadId } = require(path.join(__dirname, 'codex-deeplink.js'));

// App 任务的展示名：IPC 广播不带工作目录，用品牌名兜底（品牌名不进词表不翻译）。
// 绝不从 ide-context 之类发给别的 client 的消息里凑——无会话级关联，凑出来就是张冠李戴。
const APP_PROJECT = 'Codex App';

/**
 * @param {object} [deps] { dir, now, writeStatus, readStatus } 全可注入，测试不碰真实目录
 */
function createCodexAppIngest(deps) {
  const d = deps || {};
  const dir = d.dir;   // undefined → state-files 走默认目录（同采集器）
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const write = typeof d.writeStatus === 'function' ? d.writeStatus : stateFiles.writeStatus;
  const read = typeof d.readStatus === 'function' ? d.readStatus : stateFiles.readStatus;

  // 摄入是否可写这条会话：不存在可写；存在但也是 ipc 来源可写；hook/reconcile 的不碰
  function writable(conversationId) {
    let existing = null;
    try { existing = read(conversationId, dir); } catch (_) { existing = null; }
    return { existing, ok: existing == null || existing.source === 'ipc' };
  }

  function put(conversationId, state, lastEvent) {
    // 落盘失败（磁盘/权限）不抛：摄入是增强通道，绝不打死 IPC 适配器
    try {
      return write({
        agent: 'codex', form: 'app',
        sessionId: conversationId, threadId: conversationId,
        cwd: '', project: APP_PROJECT,
        tty: null, pid: null,
        state, lastEvent, source: 'ipc', ts: now()
      }, dir);
    } catch (_) { return null; }
  }

  /** 提交/队列变化：该会话有新活动 → running */
  function onActivity(conversationId) {
    if (!isValidThreadId(conversationId)) return null;
    if (!writable(conversationId).ok) return null;
    return put(conversationId, 'running', 'ipc:queued-followups-changed');
  }

  /** 回合结束（未读）→ done；已读 → ended（只更新已存在的 ipc 记录） */
  function onReadState(conversationId, hasUnreadTurn) {
    if (!isValidThreadId(conversationId)) return null;
    const { existing, ok } = writable(conversationId);
    if (!ok) return null;
    if (hasUnreadTurn === true) return put(conversationId, 'done', 'ipc:turn-unread');
    if (hasUnreadTurn === false && existing != null) return put(conversationId, 'ended', 'ipc:turn-read');
    return null;
  }

  return { onActivity, onReadState, APP_PROJECT };
}

module.exports = { createCodexAppIngest, APP_PROJECT };
