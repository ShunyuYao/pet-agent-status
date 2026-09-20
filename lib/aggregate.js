'use strict';
// 状态文件快照 → 面板、计数、徽标共享的投影；同步健康不改变执行事实。
// now / isPidAlive 由调用方注入，离线测试无需等待真实时间。
const ERROR_STALE_MS = 60 * 1000;
const DONE_SHOW_MS = 5 * 60 * 1000;
const STALE_UNKNOWN_MS = 3 * 60 * 1000; // 保留导出名以兼容旧调用方；现在只推导同步暂停。
const DROP_IDLE_MS = 20 * 60 * 1000;   // 加上完成驻留窗共展示 25 分钟。

const SUBLINE_KEY = {
  running: 'state.running',
  waiting: 'state.waiting',
  done: 'state.done',
  ended: 'state.ended',
  error: 'state.error',
  idle: 'state.idle',
  unknown: 'state.unknown',
  'sync-paused': 'state.syncPaused',
  'waiting-input': 'state.waitingInput',
  failed: 'state.failed',
  stopped: 'state.stopped'
};

// 缺省兼容旧 CLI 记录。
function formOf(rec) {
  return rec && rec.form === 'app' ? 'app' : 'cli';
}

/**
 * 单条记录 → 展示态。陈旧只影响同步健康，不推断任务成功或停止。
 * @param {object} rec 已通过 validateRecord 的记录
 * @param {number} now 注入的当前毫秒
 * @param {(pid:number)=>boolean} isPidAlive 注入的存活探测
 */
function deriveState(rec, now, isPidAlive) {
  const active = ['running', 'waiting', 'waiting-input'].includes(rec.state);
  if (active && rec.syncPaused === true) return 'sync-paused';
  if (active && rec.pid != null && now - rec.ts > ERROR_STALE_MS && !isPidAlive(rec.pid)) return 'sync-paused';
  if (active && now - rec.ts > STALE_UNKNOWN_MS) return 'sync-paused';
  if (rec.state === 'ended') return 'stopped';
  return rec.state;
}

// running 行显 mm:ss 计时（DESIGN.md 右列）；其余显相对时间
function formatTime(state, ageMs, t) {
  if (state === 'running' || state === 'waiting' || state === 'waiting-input') {
    const total = Math.max(0, Math.floor(ageMs / 1000));
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
  const minutes = Math.floor(Math.max(0, ageMs) / 60000);
  return minutes < 1 ? t('time.justNow') : t('time.minutesAgo', { n: minutes });
}

// 活跃组：还在进行中的两态（与 state-files 的 ACTIVE_STATES 同义，这里按展示态判）
const LIVE_STATES = new Set(['running', 'waiting', 'waiting-input', 'sync-paused']);

/**
 * 同一个终端窗口只留当前那条会话（2026-09-12 用户实测：一个窗口同时出现
 * 运行中 / 空闲 / 已完成三种状态）。
 *
 * 成因：一个终端窗口先后跑过多个会话（用户退出重开、`claude -c` 续接、
 * 或该窗口里的 agent 起过 `claude -p` 子进程——后者已在 hook 侧拦掉），
 * 每个会话各有 sessionId 各占一行，旧的那些在 done 绿驻留 5 分钟 + idle 20 分钟里
 * 一直挂着，于是同一个窗口同时显示好几种状态。
 *
 * 判据（对齐用户的原则「点得进去才显示」）：旧会话点下去只会跳到同一个终端窗口，
 * 而那里现在跑的是别的会话 —— 点不到它自己，所以不显示。
 *
 * 两条边界：
 *  ① 只对 **tty 非空** 的行生效。tty 为 null 的 App 任务（Codex App / Claude App）
 *     不属于任何终端窗口，可以同时有多条，绝不能互相顶掉。
 *  ② **现役会话一律保留**：同一 tty 上若有多条 running/waiting（分屏残留、异常未收尾），
 *     全部留着——顶掉一个正在等你批准的会话是丢信息，比多显示一行糟得多。
 */
function supersedeSameTerminal(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.tty) continue;
    if (!groups.has(r.tty)) groups.set(r.tty, []);
    groups.get(r.tty).push(r);
  }
  const dropped = new Set();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const live = list.filter((r) => LIVE_STATES.has(r.state));
    // 有现役会话：现役的全留，其余（已结束的）全丢——窗口已被现役会话占着
    // 没有现役会话：只留最新那条，别让同一个窗口堆出一串「已完成」
    const keep = live.length > 0
      ? new Set(live)
      : new Set([list.reduce((a, b) => (b.ts > a.ts ? b : a))]);
    for (const r of list) if (!keep.has(r)) dropped.add(r);
  }
  return dropped.size === 0 ? rows : rows.filter((r) => !dropped.has(r));
}

// 排序：waiting 恒置顶（组内 ts 降序），其余 ts 降序（DESIGN.md「排序规则」）
function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const aw = ['waiting','waiting-input'].includes(a.state) ? 0 : 1;
    const bw = ['waiting','waiting-input'].includes(b.state) ? 0 : 1;
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
function safeNavigable(fn, row) {
  try { return fn(row); } catch (_) { return false; }
}

// 点击后可以「看过就收起」的状态：都是**已经没有后续**的态。
// running/waiting 刻意不在其中——它们还在进行中，点击只是跳转，收起会让用户失去正在跑的视野。
// error（可能已中断：进程已死）2026-09-11 应用户要求加入——进程都不在了，留着只能当讣告。
const DISMISSIBLE = new Set(['done', 'idle', 'unknown', 'error', 'failed', 'stopped', 'sync-paused']);

/**
 * 这条会话是否已被用户点掉（且此后没有新动静）。
 *
 * 判据是**时间戳比较**而不是布尔标记：用户点掉后若该会话又有了新事件（比如在那个终端里
 * 继续发消息），rec.ts 会更新并超过 dismissedAt，行就自动复现 —— 这是「已读」而不是「删除」。
 * 布尔标记做不到这点：那样会话复活后仍被永久藏着，用户以为插件坏了。
 */
function isDismissed(rec, state, dismissedAt) {
  if (!dismissedAt || !DISMISSIBLE.has(state)) return false;
  const at = dismissedAt[rec.sessionId];
  if (Number.isFinite(at)) return rec.ts <= at;
  if (!at || !Number.isFinite(at.at)) return false;
  const identity = rec.runId || rec.turnId;
  return identity && at.runId ? identity === at.runId && (state !== 'sync-paused' || rec.ts <= at.ts) : rec.ts <= at.at;
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
  const canJumpWithoutTty = typeof o.canJumpWithoutTty === 'function' ? o.canJumpWithoutTty : () => false;
  // 标题解析（US-9）：注入的「这条记录有没有更好的会话名」判定（如 Codex 线程目录里
  // AI 生成的标题，唯一实现在 lib/codex-thread-titles.js，由 tool 注入——零厂牌特判）。
  // 优先级：注入解析 > 落盘 title（hook 首条 prompt 兜底）> 无（panel 回落 project）。
  const titleFor = typeof o.titleFor === 'function' ? o.titleFor : () => null;
  const jumpErrors = (o.jumpErrors && typeof o.jumpErrors === 'object') ? o.jumpErrors : null;
  // sessionId → 用户点掉它的时刻（毫秒）。之后该会话再有新事件（ts 变新）就自动复现。
  const dismissedAt = (o.dismissedAt && typeof o.dismissedAt === 'object') ? o.dismissedAt : null;

  const records = (snapshot && Array.isArray(snapshot.records)) ? snapshot.records : [];
  const badFiles = (snapshot && Array.isArray(snapshot.unknown)) ? snapshot.unknown : [];

  const rows = [];
  // 因「一个落点都没有」而被隐藏的条数。如实报给面板显示，不让会话凭空消失。
  let hiddenNoTarget = 0;
  for (const rec of records) {
    const state = deriveState(rec, now, isPidAlive);
    if (state === 'idle') continue;
    if (['done','failed','stopped'].includes(state) && now - rec.ts >= DONE_SHOW_MS + DROP_IDLE_MS) continue;
    if (isDismissed(rec, state, dismissedAt)) continue;   // 用户点过且此后无新动静 → 收起
    const row = makeRow(rec, state, now, t);
    // 解析器抛错不打死聚合（它要读外部存储）；抛了就用落盘兜底
    let resolved = null;
    try { resolved = titleFor(rec); } catch (_) { resolved = null; }
    if (typeof resolved === 'string' && resolved !== '') row.title = resolved;
    // 跳转入口标志：有 tty 走注入的终端归属判定；没 tty 走注入的无终端导航判定
    // （App 任务深链接，唯一实现在 lib/codex-deeplink.js#pickNavigator，由 tool 注入——
    // 本模块保持零厂牌特判，完全由行数据与注入判定驱动）。
    // 两样都推不出 → false，panel 不渲染可点态（无假入口）。
    row.canJump = rec.tty != null
      ? !!safeCanJump(canJump, rec.tty)
      : !!safeNavigable(canJumpWithoutTty, row);
    // 可收起标志：panel 不 require 本模块，可点态只能靠快照行携带（同 canJump 精神）。
    // error 行常连终端归属都判不出（canJump=false），没有这个标志它就永远点不动。
    row.canDismiss = DISMISSIBLE.has(state);
    // 按落点过滤（2026-09-12 用户拍板）：一条都点不到的后台会话不进面板。
    // 判据是「无 tty 且无 App 落点」——**不是** canJump=false：后者还包含
    // 「有 tty 但认不出是哪个终端 App」那一档（冷门终端、ps 抖动），
    // 那种情况会话真实存在于某个终端里，按 canJump 过滤会误藏。
    if (rec.tty == null && !row.canJump) { hiddenNoTarget++; continue; }
    if (jumpErrors && typeof jumpErrors[rec.sessionId] === 'string') {
      row.jumpError = jumpErrors[rec.sessionId];
    }
    rows.push(row);
  }

  // 同窗顶替放在排序与汇总之前：被顶掉的行不该计进 summary
  // （徽标/胶囊/宠物提醒同源，否则会为一条不显示的行喊「刚办完」）
  const sorted = sortRows(supersedeSameTerminal(rows));
  // isFollowing：注入的「App 是否正在跟随这行」判定（US-8 IPC 增强）。缺省恒 false。
  const isFollowing = typeof o.isFollowing === 'function' ? o.isFollowing : () => false;
  const focus = pickFocus(sorted, isFollowing);
  // focused 是布尔且每行都有（行结构同构，codex/claude 零特判贯通不被破坏）
  for (const r of sorted) r.focused = (r === focus);
  return {
    rows: sorted,
    summary: {
      running: sorted.filter((r) => r.state === 'running').length,
      waiting: sorted.filter((r) => r.state === 'waiting').length,
      // 完成事实保留；只有近期未读完成计入提醒数量。
      done: sorted.filter((r) => r.state === 'done' && !r.read && now - r.ts <= DONE_SHOW_MS).length,
      total: sorted.length,
      unknown: 0,
      syncPaused: sorted.filter(r => r.state === 'sync-paused').length,
      waitingInput: sorted.filter(r => r.state === 'waiting-input').length,
      diagnostics: badFiles.length,
      // 点不进去而被隐藏的后台会话条数（Ralph 循环、launchd 起的监控这类）。
      // 面板据此在底部如实说明，避免「我的会话去哪了」。
      hiddenNoTarget,
      // 聚焦会话 = 本体/徽标该关注的那一个（对齐 Codex Pets 的 following 语义，
      // CLI 无 following 信号，按注意力优先级推导；US-8 IPC 接入后 App 的真实
      // following 会话在同级里优先）。列表监听全部，本体聚焦一个。
      focus: focus ? { sessionId: focus.sessionId, state: focus.state, project: focus.project } : null
    }
  };
}

// 注意力优先级：等你批准 > 正在跑 > 出错了 > 刚办完 > 闲置/未知；
// 同级先看 App following（用户正盯着的会话，US-8 IPC 实录信号），再取最新。
// following 只在同级里加权，绝不越级——盯着一个 running 也压不过别处的 waiting。
const FOCUS_PRIORITY = { waiting: 0, 'waiting-input': 0, running: 1, failed: 2, error: 2, done: 3, stopped: 4, idle: 5, unknown: 6, 'sync-paused': 6 };
function pickFocus(rows, isFollowing) {
  const following = typeof isFollowing === 'function' ? isFollowing : () => false;
  let best = null;
  let bestF = false;
  for (const r of rows) {
    const p = FOCUS_PRIORITY[r.state];
    if (p == null) continue;
    let f = false;
    try { f = !!following(r); } catch (_) { f = false; }   // 判定抛错不打死聚合
    const pb = best ? FOCUS_PRIORITY[best.state] : Infinity;
    if (!best || p < pb
        || (p === pb && f && !bestF)
        || (p === pb && f === bestF && r.ts > best.ts)) { best = r; bestF = f; }
  }
  return best;
}

// 计时/相对时间的起点（见 makeRow 内 timeText 注释）
function timeOrigin(rec, state) {
  const active = state === 'running' || state === 'waiting' || state === 'waiting-input';
  return (active && Number.isFinite(rec.since)) ? rec.since : rec.ts;
}

// 行结构：panel 直接渲染，不再算业务字段（criteria §2 最后一条）
function makeRow(rec, state, now, t) {
  const row = {
    sessionId: rec.sessionId,
    agent: rec.agent,
    form: formOf(rec),
    project: rec.project,
    state,
    read: rec.read === true,
    pendingDone: state === 'done' && rec.read !== true && now - rec.ts <= DONE_SHOW_MS,
    runId: rec.runId || rec.turnId || String(rec.since || rec.ts),
    turnId: rec.turnId,
    sync: state === 'sync-paused' ? 'paused' : 'ok',
    // 保留执行事实，sync 单独说明当前可信度。
    raw: rec.state,
    subline: state === 'sync-paused' ? t('state.syncPaused', { state: t(SUBLINE_KEY[rec.state] || 'state.running') }) : t(SUBLINE_KEY[state] || SUBLINE_KEY.unknown),
    // mm:ss 计时的起点是活跃段起点 since，不是最后心跳 ts——ts 每个 hook 事件都会刷
    // （每次工具调用都算），拿它计时会不断归零（2026-09-11 用户实测缺陷）。
    // 只有活跃展示态用 since；done/idle/error/unknown 的「N 分钟前」仍指最后动静（ts）。
    // 旧文件没有 since（协议缺省回退 ts），行为与从前相同。
    timeText: formatTime(state, now - timeOrigin(rec, state), t),
    ts: rec.ts,
    tty: rec.tty == null ? null : rec.tty,
    pid: rec.pid == null ? null : rec.pid,
    cwd: rec.cwd
  };
  if (rec.threadId != null) row.threadId = rec.threadId;
  // 落盘的兜底标题（hook 首条 prompt 首行）；调用方若有更好的解析结果会覆盖本字段
  if (typeof rec.title === 'string' && rec.title !== '') row.title = rec.title;
  return row;
}

module.exports = {
  ERROR_STALE_MS, STALE_UNKNOWN_MS, DROP_IDLE_MS, SUBLINE_KEY, DISMISSIBLE, isDismissed,
  deriveState, formatTime, sortRows, aggregate
};
