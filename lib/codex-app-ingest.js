'use strict';
// Codex App 任务摄入：IPC 回调 → 状态文件（PROTOCOL.md「Codex App 来源」的唯一实现处）。
//
// 映射依据是 fixtures/codex-ipc-facts.md §8 的实录，映射表冻结在 PROTOCOL.md：
//   rollout 活动（facts §10.2：运行期间线程 rollout 文件持续追加）→ running。
//     这是 running 的主信号——queued-followups 广播实测普通提交不发（§10.1 反证），
//     onActivity 保留只作补充（真发了仍是活动证据）。误报仍由采集器 stale 兜底
//   read-state hasUnreadTurn:true（仅回合结束时刻发，时序实验 §8.3）→ done
//   read-state hasUnreadTurn:false（用户在 App 读过了）→ ended，且**只更新不新建**——
//     对没见过的会话新建一条 ended 是在报旧闻
//
// 两条保护，都是「摄入不许压过更富的数据源」：
//   ① conversationId 必须是 UUID 形态（同 codex-deeplink 的白名单精神，脏 id 不落盘）
//   ② 同 sessionId 已有 hook 系记录（source 非 'ipc'/'reconcile'，CLI hooks 写的、含 tty）
//      时跳过不覆盖；'ipc' 与 'reconcile' 同属 App 摄入系，互相可写——IPC 的 done/ended
//      必须能覆盖 rollout 写的 running

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

  // 摄入是否可写这条会话：不存在可写；摄入系（ipc/reconcile）可写；hook 的不碰
  function writable(conversationId) {
    let existing = null;
    try { existing = read(conversationId, dir); } catch (_) { existing = null; }
    const ok = existing == null || existing.source === 'ipc' || existing.source === 'reconcile';
    return { existing, ok };
  }

  function put(conversationId, state, lastEvent, source) {
    // 落盘失败（磁盘/权限）不抛：摄入是增强通道，绝不打死 IPC 适配器
    try {
      return write({
        agent: 'codex', form: 'app',
        sessionId: conversationId, threadId: conversationId,
        cwd: '', project: APP_PROJECT,
        tty: null, pid: null,
        state, lastEvent, source: source || 'ipc', ts: now()
      }, dir);
    } catch (_) { return null; }
  }

  // 心跳节流：running 记录已经够新就不重写（2s 一轮的采集全量重写纯属磁盘骚扰；
  // 但要足够频繁地刷 ts，别让长任务掉进采集器 3min stale→unknown 兜底）
  const HEARTBEAT_MS = 20 * 1000;

  /**
   * rollout 活动（PROTOCOL.md「rollout 活动信号」）→ running（source:'reconcile'）。
   * 归属判据（App 还是无 hooks 的 CLI）由调用方给：canClaim(conversationId) —— 唯一
   * 判据实现在 tool 侧（已有摄入系记录 or App following），本模块不自己猜。
   */
  function onRolloutActivity(conversationId, canClaim) {
    if (!isValidThreadId(conversationId)) return null;
    const { existing, ok } = writable(conversationId);
    if (!ok) return null;   // hook 系在管（CLI 会话），rollout 活动不作数
    const claimed = existing != null || (typeof canClaim === 'function' && !!canClaim(conversationId));
    if (!claimed) return null;   // 分不清 App/CLI 的活动不落盘（绝不误标厂牌形态）
    // 已是新鲜 running 就不重写（节流）；非 running（含刚被误翻的 ended）立刻写
    if (existing && existing.state === 'running' && now() - existing.ts < HEARTBEAT_MS) return null;
    return put(conversationId, 'running', 'reconcile:rollout-activity', 'reconcile');
  }

  /** 提交/队列变化：该会话有新活动 → running */
  function onActivity(conversationId) {
    if (!isValidThreadId(conversationId)) return null;
    if (!writable(conversationId).ok) return null;
    return put(conversationId, 'running', 'ipc:queued-followups-changed');
  }

  /**
   * 回合结束（未读）→ done；已读 → ended（只更新已存在的摄入系记录）。
   * isActive：注入的「该线程 rollout 是否活动中」判定——实测（facts §10.1）提交时刻
   * App 会发一条 hasUnreadTurn:false（用户正看着线程），不豁免会把刚开跑的任务翻成 ended。
   */
  function onReadState(conversationId, hasUnreadTurn, isActive) {
    if (!isValidThreadId(conversationId)) return null;
    const { existing, ok } = writable(conversationId);
    if (!ok) return null;
    if (hasUnreadTurn === true) return put(conversationId, 'done', 'ipc:turn-unread');
    if (hasUnreadTurn === false && existing != null) {
      if (typeof isActive === 'function' && isActive(conversationId)) return null;   // 正在跑，「已读」不算结束
      return put(conversationId, 'ended', 'ipc:turn-read');
    }
    return null;
  }

  return { onActivity, onReadState, onRolloutActivity, APP_PROJECT };
}

module.exports = { createCodexAppIngest, APP_PROJECT };
