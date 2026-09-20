'use strict';
// App 摄入只保存任务/回合元数据。结束由同轮终态核验；未读通知仅改变 read。
// rollout 活动只证明正在产生输出；无输出且无运行时通道时停止刷新，不猜成功。

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

  const threadFor = typeof d.threadFor === 'function' ? d.threadFor : () => null;
  function latestThread(id) { try { return threadFor(id); } catch (_) { return null; } }
  const isTerminalTurn = turn => turn && ['completed', 'failed', 'interrupted'].includes(turn.status);

  // 摄入是否可写这条会话：不存在可写；摄入系（ipc/reconcile）可写；hook 的不碰
  function writable(conversationId) {
    let existing = null;
    try { existing = read(conversationId, dir); } catch (_) { existing = null; }
    const ok = existing == null || existing.source === 'ipc' || existing.source === 'reconcile';
    return { existing, ok };
  }

  function put(conversationId, state, lastEvent, source, turnId) {
    // 落盘失败（磁盘/权限）不抛：摄入是增强通道，绝不打死 IPC 适配器
    try {
      return write({
        agent: 'codex', form: 'app',
        sessionId: conversationId, threadId: conversationId,
        cwd: '', project: APP_PROJECT,
        tty: null, pid: null,
        state, lastEvent, source: source || 'ipc', ts: now(), turnId
      }, dir);
    } catch (_) { return null; }
  }

  // 心跳节流：running 记录已经够新就不重写（2s 一轮的采集全量重写纯属磁盘骚扰；
  // 但要足够频繁地刷 ts，别让长任务掉进采集器 3min 同步暂停 兜底）
  const HEARTBEAT_MS = 20 * 1000;

  /**
   * rollout 活动（PROTOCOL.md「rollout 活动信号」）→ running（source:'reconcile'）。
   * 归属判据（App 还是无 hooks 的 CLI）由调用方给：canClaim(conversationId) —— 唯一
   * 判据实现在 tool 侧（已有摄入系记录 or App following），本模块不自己猜。
   */
  function onRolloutActivity(conversationId, canClaim, thread = latestThread(conversationId)) {
    if (!isValidThreadId(conversationId)) return null;
    if (thread?.isSubagent === true) return null;
    const turn = thread?.turn;
    const { existing, ok } = writable(conversationId);
    if (!ok) return null;   // hook 系在管（CLI 会话），rollout 活动不作数
    const claimed = existing != null || (typeof canClaim === 'function' && !!canClaim(conversationId));
    if (!claimed) return null;   // 分不清 App/CLI 的活动不落盘（绝不误标厂牌形态）
    // A final flush belongs to the completed turn. Only a different, verified running
    // turn can cross the persisted barrier. Missing metadata must not guess a restart.
    if (turn && turn.status !== 'inProgress') return null;
    if (existing && (['done', 'ended', 'failed', 'stopped'].includes(existing.state))) {
      if (!turn || turn.status !== 'inProgress') return null;
      if (existing.turnId ? existing.turnId === turn.id : !(turn.startedAt > existing.ts)) return null;
    }
    // 心跳只延续运行态；新回合必须立刻落盘，以保存正确的回合编号。
    if (existing && existing.state === 'running' && (!turn || existing.turnId === turn.id) && now() - existing.ts < HEARTBEAT_MS) return null;
    return put(conversationId, 'running', 'reconcile:rollout-activity', 'reconcile', turn && turn.id);
  }

  // An unscoped notification requests reconciliation; it never invents a turn.
  function onActivity(conversationId) {
    const thread = latestThread(conversationId);
    if (thread?.turn?.status !== 'inProgress') return null;
    return onRolloutActivity(conversationId, () => true, thread);
  }

  function reconcileTurn(conversationId, thread = latestThread(conversationId)) {
    if (!isValidThreadId(conversationId) || thread?.isSubagent === true) return null;
    const { existing, ok } = writable(conversationId);
    const turn = thread?.turn;
    if (!ok || !existing || !isTerminalTurn(turn)) return null;
    if (!['running', 'waiting', 'waiting-input'].includes(existing.state)) return null;
    if (existing.turnId ? existing.turnId !== turn.id
      : !(Number.isFinite(turn.startedAt) && Number.isFinite(turn.completedAt)
        && turn.startedAt <= (existing.since || existing.ts) && turn.completedAt >= existing.ts)) return null;
    const state = { completed: 'done', failed: 'failed', interrupted: 'stopped' }[turn.status];
    try { return write({ ...existing, state, lastEvent: 'reconcile:turn-' + turn.status,
      source: 'reconcile', turnId: turn.id, read: false,
      ts: Math.max(existing.ts, Math.min(now(), Number.isFinite(turn.completedAt) ? turn.completedAt : now())) }, dir); } catch (_) { return null; }
  }

  function onReadState(conversationId, hasUnreadTurn) {
    if (!isValidThreadId(conversationId)) return null;
    const thread = latestThread(conversationId);
    reconcileTurn(conversationId, thread);
    const { existing, ok } = writable(conversationId);
    if (!ok || !existing || thread?.isSubagent === true || !isTerminalTurn(thread?.turn)) return null;
    if (existing.turnId !== thread.turn.id || !['done', 'failed', 'stopped', 'ended'].includes(existing.state)) return null;
    // Keep event time, execution identity and outcome unchanged when marking read.
    if (hasUnreadTurn !== false) return null;
    const readValue = true;
    if (existing.read === readValue) return null;
    try { return write({ ...existing, read: readValue }, dir); } catch (_) { return null; }
  }

  return { onActivity, onReadState, onRolloutActivity, reconcileTurn, APP_PROJECT };
}

module.exports = { createCodexAppIngest, APP_PROJECT };
