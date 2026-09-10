'use strict';
// 采集器状态机：状态文件快照 → panel 渲染行（PROTOCOL.md「采集器推导态」的唯一实现处）。
//
// 全纯函数：now / isPidAlive 一律由调用方注入，测试不 sleep、不探真实进程。
// 推导态 error/idle/unknown 只活在这里与面板，绝不落盘（协议红线）。

const ERROR_STALE_MS = 60 * 1000;        // running/waiting 超过这么久没心跳才考虑 error
const IDLE_MS = 20 * 60 * 1000;          // 任何状态超过这么久算 idle
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
  if (rec.state === 'done' || rec.state === 'ended') return 'idle';
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

/**
 * 快照 → { rows, summary }。
 * @param {{records:object[], unknown?:object[]}} snapshot lib/state-files.js#readSnapshots 的返回值
 * @param {{now:number, isPidAlive:Function, t?:Function}} opts
 */
function aggregate(snapshot, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const isPidAlive = typeof o.isPidAlive === 'function' ? o.isPidAlive : () => true;
  const t = typeof o.t === 'function' ? o.t : fallbackT;

  const records = (snapshot && Array.isArray(snapshot.records)) ? snapshot.records : [];
  const badFiles = (snapshot && Array.isArray(snapshot.unknown)) ? snapshot.unknown : [];

  const rows = [];
  for (const rec of records) {
    const state = deriveState(rec, now, isPidAlive);
    if (state === 'idle' && now - idleSince(rec) > DROP_IDLE_MS) continue;
    rows.push(makeRow(rec, state, now, t));
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
      subline: t(SUBLINE_KEY.unknown),
      timeText: '',
      ts: 0,
      tty: null,
      pid: null,
      cwd: '',
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
  deriveState, formatTime, sortRows, aggregate
};
