'use strict';
// 采集器状态机：状态文件快照 → panel 渲染行（PROTOCOL.md「采集器推导态」的唯一实现处）。
//
// 全纯函数：now / isPidAlive 一律由调用方注入，测试不 sleep、不探真实进程。
// 推导态 error/idle/unknown 只活在这里与面板，绝不落盘（协议红线）。

const ERROR_STALE_MS = 60 * 1000;        // running/waiting 超过这么久没心跳才考虑 error
const IDLE_MS = 20 * 60 * 1000;          // 任何状态超过这么久算 idle
const DONE_SHOW_MS = 5 * 60 * 1000;      // done/ended 先绿色驻留这么久再转 idle（对齐设计稿「2 分前=已完成」「18 分前=空闲」）
// running/waiting 超过这么久没有任何新事件，即便进程还活着也不再宣称「正在跑/在等你」。
//
// ⚠️ 2026-09-11 真机缺陷：agent 被 Esc 打断、或权限请求被批准后继续跑，**都不会发终止事件**
// （Stop 只在正常结束时发）。状态于是永远停在最后一次 hook —— 用户看到「Running」但那个窗口
// 早已空闲、看到「等待批准」但三小时前就批过了（实测线上两条 waiting 停留了 11800 秒）。
// 原 error 推导要求「进程已死」，而这里进程活得好好的，正落在判定盲区里。
// 这类情况**不能当 done**（没有任何证据说明它成功了），也不该继续显示 running —— 归入 unknown：
// 「状态未知」是诚实的，「正在跑」是撒谎。协议红线「绝不误报完成」的同一条精神，反向应用。
const STALE_UNKNOWN_MS = 3 * 60 * 1000;
const DROP_IDLE_MS = 20 * 60 * 1000;     // idle 超过这么久从面板移除

// 副行文案的 locale key（DESIGN.md 状态图例；unknown 与 idle 必须不同词，绝不误报完成）
const SUBLINE_KEY = {
  running: 'state.running',
  waiting: 'state.waiting',
  done: 'state.done',
  ended: 'state.ended',
  error: 'state.error',
  idle: 'state.idle',
  unknown: 'state.unknown',
  // 「久无心跳」与「文件读不出」都归 unknown 展示态，但对用户是两回事，文案必须分开：
  // 前者绝大多数是「批准后跑完了，只是 agent 不再发事件」——该给行动指引（点进去看看）；
  // 后者是真的读不出来，给指引也没用。共用一句「状态未知」等于把两种处境混为一谈。
  stale: 'state.stale'
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
  // 进程还在但久无心跳：打断/批准后无终止事件的那类（见 STALE_UNKNOWN_MS 注释）。
  // error 分支在上面已先行处理「进程已死」，走到这里的都是活着的。
  if ((rec.state === 'running' || rec.state === 'waiting') && age > STALE_UNKNOWN_MS) return 'unknown';
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
function safeNavigable(fn, row) {
  try { return fn(row); } catch (_) { return false; }
}

// 点击后可以「看过就收起」的状态：都是**已经没有后续**的态。
// running/waiting 刻意不在其中——它们还在进行中，点击只是跳转，收起会让用户失去正在跑的视野。
// error（可能已中断：进程已死）2026-09-11 应用户要求加入——进程都不在了，留着只能当讣告。
const DISMISSIBLE = new Set(['done', 'idle', 'unknown', 'error']);

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
  return Number.isFinite(at) && rec.ts <= at;
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
  for (const rec of records) {
    const state = deriveState(rec, now, isPidAlive);
    if (state === 'idle' && now - idleSince(rec) > DROP_IDLE_MS) continue;
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
      // done 是展示态（绿驻留窗内），过了 DONE_SHOW_MS 转 idle 后不再计入——
      // 汇总胶囊与徽标据此显示「刚办完几件」，和列表行的绿色驻留同一时间窗
      done: sorted.filter((r) => r.state === 'done').length,
      total: sorted.length,
      unknown: sorted.filter((r) => r.state === 'unknown').length,
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
const FOCUS_PRIORITY = { waiting: 0, running: 1, error: 2, done: 3, idle: 4, unknown: 5 };
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

// unknown 有两个来源，副行文案要分开（见 SUBLINE_KEY.stale 注释）：
// 落盘态是 running/waiting 却被推成 unknown 的 = 久无心跳（stale）；其余 = 真读不出来。
function sublineKeyFor(rec, state) {
  if (state !== 'unknown') return state;
  return (rec.state === 'running' || rec.state === 'waiting') ? 'stale' : 'unknown';
}

// 计时/相对时间的起点（见 makeRow 内 timeText 注释）
function timeOrigin(rec, state) {
  const active = state === 'running' || state === 'waiting';
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
    // 落盘的原始状态。panel 只看 state（展示态），联动看 raw ——
    // done/ended 的展示态是 idle（灰、随后淡出），但「刚办完」是个**迁移**，
    // 宠物要在这一刻喊。只留 state 的话 done 永远被 idle 盖住，
    // DESIGN.md 的完成提醒就成了永不触发的死代码。
    raw: rec.state,
    subline: t(SUBLINE_KEY[sublineKeyFor(rec, state)] || SUBLINE_KEY.unknown),
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

// 坏文件没有可信的 sessionId（正文都解析不出来），只能拿文件名当标识
function sessionIdOfFile(file) {
  const name = String(file == null ? '' : file);
  const base = name.slice(name.lastIndexOf('/') + 1);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

module.exports = {
  ERROR_STALE_MS, STALE_UNKNOWN_MS, IDLE_MS, DROP_IDLE_MS, SUBLINE_KEY, DISMISSIBLE, isDismissed,
  deriveState, idleSince, formatTime, sortRows, aggregate
};
