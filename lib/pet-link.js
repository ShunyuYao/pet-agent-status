'use strict';
// 状态迁移 → 宠物联动（DESIGN.md「宠物联动」节）。
//
// 只在**状态迁移**时提醒，不是每次 tick 都喊：采集器 2s 一轮，
// 按当前状态发就会变成每 2 秒一次气泡。
// 节流：同 (sessionId, state) 5 分钟内最多一次。
// now 注入，测试不 sleep。

const THROTTLE_MS = 5 * 60 * 1000;

// 后台提醒只显示气泡；不掌握宿主贴边/睡眠/拖拽状态，不主动切换动画。
// 气泡是否伴随说话动作由宿主按当前姿态决定。
function createPetLink() {
  const lastState = new Map();   // sessionId → 上一轮的展示态
  const lastNotify = new Map();  // `${sessionId}\u0000${state}` → 上次提醒时刻

  function restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [key, at] of Object.entries(saved).slice(-2000)) if (Number.isFinite(at)) lastNotify.set(key, at);
  }
  function exportState() { return Object.fromEntries(lastNotify); }

  function throttled(sessionId, state, now) {
    const key = `${sessionId}\u0000${state}`;
    const prev = lastNotify.get(key);
    if (prev != null && (state === 'done' || now - prev < THROTTLE_MS)) return true;
    lastNotify.set(key, now);
    return false;
  }

  /**
   * 吃一轮快照行，按迁移触发联动。
   * @param {object[]} rows aggregate 的 rows
   * @param {object} pet 宿主 SDK（可注入 mock；只用 pet.bubble）
   * @param {{now:number, t:Function}} ctx
   * @returns {object[]} 本轮真实触发的联动（供测试与诊断，不含被节流的）
   */
  function onSnapshot(rows, pet, ctx) {
    const now = Number.isFinite(ctx && ctx.now) ? ctx.now : Date.now();
    const t = (ctx && typeof ctx.t === 'function') ? ctx.t : (k) => k;
    const list = Array.isArray(rows) ? rows : [];
    const fired = [];
    const seen = new Set();

    // 第一遍只收集「本轮真的要提醒的迁移」，第二遍合并发声——
    // 多会话并发迁移时不轮流打扰（Codex Pets「聚焦一个」语义的 CLI 版）：
    // 气泡最多一条，主角是注意力优先级最高的那条（waiting > done，同级取靠前）。
    const pending = [];
    for (const row of list) {
      seen.add(row.sessionId + ':' + (row.turnId || row.runId || 'legacy'));
      // 看 raw（落盘态）而不是 state（展示态）：done/ended 的展示态窗口过后被推成 idle，
      // 只看 state 的话「差事办完啦」可能等不到 done，是死代码。
      const cur = row.sync === 'paused' ? 'sync-paused' : rawOf(row);
      const identity = row.sessionId + ':' + (row.turnId || row.runId || 'legacy');
      const prev = lastState.get(identity);
      lastState.set(identity, cur);
      if (prev === cur) continue;                             // 没迁移，不提醒
      if (row.read === true || !['done','waiting','waiting-input'].includes(cur)) continue;
      // 首次见到就已是 done 的会话不提醒：那是插件启动前就结束的历史会话，
      // 现在喊「差事办完啦」是在报旧闻。waiting 首见要喊 —— 用户此刻真的被挡着。
      if (prev === undefined && cur === 'done') continue;
      if (throttled(identity, cur, now)) continue;
      pending.push({ row, cur });
    }

    if (pending.length) {
      // rows 已按 waiting 置顶 + ts 降序排好，pending 顺序即注意力顺序；
      // 主角取 waiting 优先（没有 waiting 就是最新的 done）。
      const primary = pending.find((p) => p.cur === 'waiting' || p.cur === 'waiting-input') || pending[0];
      const doneCount = pending.filter((p) => p.cur === 'done').length;
      let text;
      if (pending.length === 1) {
        text = t(primary.cur === 'done' ? 'bubble.done' : primary.cur === 'waiting-input' ? 'bubble.waitingInput' : 'bubble.waiting', { project: primary.row.project });
      } else if (primary.cur === 'waiting' || primary.cur === 'waiting-input') {
        // 有人等批准时它永远是主角，其余动静并进尾巴
        text = t(primary.cur === 'waiting-input' ? 'bubble.mixedInput' : 'bubble.mixed', { project: primary.row.project, rest: pending.length - 1 });
      } else {
        text = t('bubble.multiDone', { n: doneCount });
      }
      call(pet, 'bubble', text);
      fired.push({ sessionId: primary.row.sessionId, kind: 'bubble', state: primary.cur, text, merged: pending.length > 1 });
    }

    // 会话行消失（idle 淡出/文件删除）后忘掉它，下次重现按首见处理，
    // 也顺手防 Map 无限长
    for (const id of [...lastState.keys()]) if (!seen.has(id)) lastState.delete(id);
    for (const key of [...lastNotify.keys()]) {
      if (now - lastNotify.get(key) >= 30 * 86400000) lastNotify.delete(key);
    }
    return fired;
  }

  return { onSnapshot, restore, exportState, THROTTLE_MS };
}

// 联动一律按落盘态判定。老快照（或测试）没带 raw 时回落到 state，
// 缺字段不至于让整条链路哑掉。
function rawOf(row) {
  return (row && row.raw != null) ? row.raw : (row && row.state);
}

// 宠物联动失败绝不能打死采集器（下一轮还得跑）。
// 方法在 `sdk.pet.*` 下（sdk-surface.js 的 ns='pet'），不是 sdk 顶层。
function call(sdk, method, arg) {
  try {
    const ns = sdk && sdk.pet;
    if (ns && typeof ns[method] === 'function') ns[method](arg);
  } catch (_) { /* 宿主拒绝/动画忙，面板照常更新 */ }
}

module.exports = { THROTTLE_MS, createPetLink };
