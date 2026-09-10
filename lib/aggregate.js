'use strict';
// 采集器状态机：状态文件快照 → panel 渲染行（PROTOCOL.md「采集器推导态」的唯一实现处）。
//
// 全纯函数：now / isPidAlive 一律由调用方注入，测试不 sleep、不探真实进程。
// 推导态 error/idle/unknown 只活在这里与面板，绝不落盘（协议红线）。

const ERROR_STALE_MS = 60 * 1000;        // running/waiting 超过这么久没心跳才考虑 error
const IDLE_MS = 20 * 60 * 1000;          // 任何状态超过这么久算 idle
const DONE_SHOW_MS = 5 * 60 * 1000;      // done/ended 先绿色驻留这么久再转 idle（对齐设计稿「2 分前=已完成」「18 分前=空闲」）
const DROP_IDLE_MS = 20 * 60 * 1000;     // idle 超过这么久从面板移除

// 副行文案的 locale key（DESIGN.md 状态图例；unknown 与 idle 必须不同词，绝不误报完成）
const SUBLINE_KEY = {
  running: 'state.running',
  waiting: 'state.waiting',
  done: 'state.done',
  ended: 'state.ended',
  error: 'state.error',
  idle: 'state.idle',
  unknown: 'state.unknown'
};

// 会话形态：本轮只有 CLI（Codex App 任务是二期，见 docs/prd.md 非目标）
function formOf(rec) {
  return rec && rec.form === 'app' ? 'app' : 'cli';
}

/**
 * 单条记录 → 展示态。落盘只有 running/waiting/done/ended 四种，其余都在这里推。
 * @param {object} rec 已通过 validateRecord 的记录
 * @param {number} now 注入的当前毫秒
 * @param {(pid:number)=>boolean} isPidAlive 注入的存活探测
 */
function deriveState(rec, now, isPidAlive) {
  const age = now - rec.ts;
  // error 优先于 idle：进程已经不在了，比「久没动静」更有信息量（PROTOCOL.md 推导态第 1 条）
  if ((rec.state === 'running' || rec.state === 'waiting')
      && age > ERROR_STALE_MS
      && rec.pid != null
      && !isPidAlive(rec.pid)) {
    return 'error';
  }
  // done/ended 先以「已完成」绿驻留一段（DESIGN.md 图例：done 是独立展示态，
  // 立刻转灰会让用户以为任务没成功），过了驻留窗才转 idle 灰、随后淡出移除。
  if (rec.state === 'done' || rec.state === 'ended') {
    return age <= DONE_SHOW_MS ? 'done' : 'idle';
  }
  if (age > IDLE_MS) return 'idle';
  return rec.state;
}

// running 行显 mm:ss 计时（DESIGN.md 右列）；其余显相对时间
function formatTime(state, ageMs, t) {
  if (state === 'running' || state === 'waiting') {
    const total = Math.max(0, Math.floor(ageMs / 1000));
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
  const minutes = Math.floor(Math.max(0, ageMs) / 60000);
  return minutes < 1 ? t('time.justNow') : t('time.minutesAgo', { n: minutes });
}

/**
 * 这条记录是从哪一刻开始算 idle 的。
 *
 * 两种入 idle 的路径起点不同，不能都拿 ts 当起点：
 * - done/ended：写入那一刻就完成了，idle 从 `ts` 起算；
 * - running/waiting 熬过 20min：那 20min 里它还在「运行中」显示着，
 *   idle 从 `ts + IDLE_MS` 起算，否则一个刚超时的 running 会被当成
 *   「已经 idle 了 20 分钟」当场移除，用户眼前的行凭空消失。
 */
function idleSince(rec) {
  return (rec.state === 'done' || rec.state === 'ended') ? rec.ts : rec.ts + IDLE_MS;
}

// 排序：waiting 恒置顶（组内 ts 降序），其余 ts 降序（DESIGN.md「排序规则」）
function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const aw = a.state === 'waiting' ? 0 : 1;
    const bw = b.state === 'waiting' ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return b.ts - a.ts;
  });
}

// 取词兜底：没注入 i18n 时返回 key，界面上一眼看出漏词（与 lib/i18n.js 同策略）
function fallbackT(key) { return key; }

// 跳转判定抛错不该打死整轮采集（它要 spawn ps，什么都可能发生）；抛了就当不能跳。
function safeCanJump(fn, tty) {
  try { return fn(tty); } catch (_) { return false; }
}

/**
 * 快照 → { rows, summary }。
 * @param {{records:object[], unknown?:object[]}} snapshot lib/state-files.js#readSnapshots 的返回值
 * @param {{now:number, isPidAlive:Function, t?:Function, canJump?:Function, jumpErrors?:object}} opts
 *   canJump：注入的「这个 tty 能不能跳」判定。**aggregate 自己绝不判终端归属** ——
 *   判定唯一实现在 lib/terminal-jump.js#detectTerminal（criteria §2「只此一处」）。
 *   缺省恒 false：拿不到判定就不给入口，好过给一个点了没反应的假入口。
 *   jumpErrors：sessionId → 错误文案，上一次跳转失败经快照回推（DESIGN.md 行内错误条）。
 */
function aggregate(snapshot, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const isPidAlive = typeof o.isPidAlive === 'function' ? o.isPidAlive : () => true;
  const t = typeof o.t === 'function' ? o.t : fallbackT;
  const canJump = typeof o.canJump === 'function' ? o.canJump : () => false;
  const jumpErrors = (o.jumpErrors && typeof o.jumpErrors === 'object') ? o.jumpErrors : null;

  const records = (snapshot && Array.isArray(snapshot.records)) ? snapshot.records : [];
  const badFiles = (snapshot && Array.isArray(snapshot.unknown)) ? snapshot.unknown : [];

  const rows = [];
  for (const rec of records) {
    const state = deriveState(rec, now, isPidAlive);
    if (state === 'idle' && now - idleSince(rec) > DROP_IDLE_MS) continue;
    const row = makeRow(rec, state, now, t);
    // 跳转入口标志：tty 拿不到、或推断不出终端归属 → false，panel 不渲染可点态。
    row.canJump = rec.tty != null && !!safeCanJump(canJump, rec.tty);
    if (jumpErrors && typeof jumpErrors[rec.sessionId] === 'string') {
      row.jumpError = jumpErrors[rec.sessionId];
    }
    rows.push(row);
  }

  // 损坏/schema 过高的文件也要有一行，否则用户看不出「有个会话读不了」——
  // 但状态是 unknown，绝不当 done（PROTOCOL.md 硬要求）。
  for (const bad of badFiles) {
    rows.push({
      sessionId: sessionIdOfFile(bad.file),
      agent: 'claude-code',
      form: 'cli',
      project: sessionIdOfFile(bad.file),
      state: 'unknown',
      raw: 'unknown',   // 读都读不出来，没有可信的落盘状态；绝不留空让联动误判
      subline: t(SUBLINE_KEY.unknown),
      timeText: '',
      ts: 0,
      tty: null,
      pid: null,
      cwd: '',
      canJump: false,   // 文件都读不出来，哪来的 tty
      reason: bad.reason || 'unknown'
    });
  }

  const sorted = sortRows(rows);
  return {
    rows: sorted,
    summary: {
      running: sorted.filter((r) => r.state === 'running').length,
      waiting: sorted.filter((r) => r.state === 'waiting').length,
      total: sorted.length,
      unknown: sorted.filter((r) => r.state === 'unknown').length
    }
  };
}

// 行结构：panel 直接渲染，不再算业务字段（criteria §2 最后一条）
function makeRow(rec, state, now, t) {
  const row = {
    sessionId: rec.sessionId,
    agent: rec.agent,
    form: formOf(rec),
    project: rec.project,
    state,
    // 落盘的原始状态。panel 只看 state（展示态），联动看 raw ——
    // done/ended 的展示态是 idle（灰、随后淡出），但「刚办完」是个**迁移**，
    // 宠物要在这一刻喊。只留 state 的话 done 永远被 idle 盖住，
    // DESIGN.md 的完成提醒就成了永不触发的死代码。
    raw: rec.state,
    subline: t(SUBLINE_KEY[state] || SUBLINE_KEY.unknown),
    timeText: formatTime(state, now - rec.ts, t),
    ts: rec.ts,
    tty: rec.tty == null ? null : rec.tty,
    pid: rec.pid == null ? null : rec.pid,
    cwd: rec.cwd
  };
  if (rec.threadId != null) row.threadId = rec.threadId;
  return row;
}

// 坏文件没有可信的 sessionId（正文都解析不出来），只能拿文件名当标识
function sessionIdOfFile(file) {
  const name = String(file == null ? '' : file);
  const base = name.slice(name.lastIndexOf('/') + 1);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

module.exports = {
  ERROR_STALE_MS, IDLE_MS, DROP_IDLE_MS, SUBLINE_KEY,
  deriveState, idleSince, formatTime, sortRows, aggregate
};
