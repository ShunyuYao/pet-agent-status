'use strict';
// WorkBuddy 来源（PROTOCOL.md「WorkBuddy 来源」的唯一实现处）。
//
// 单一信号：只读轮询 ~/.workbuddy/workbuddy.db 的 sessions.status（活体验证见
// fixtures/workbuddy-facts.md §5：pending→planning→working→completed 实时写库）。
// 不逆向 IPC、不拼多信号——这是三家里唯一官方状态就躺在磁盘上的。
//
// 从 Codex App 三轮修复带过来的教训，全部落成硬判据：
//   ① 不报旧闻：终态（completed/failed/terminated…）只更新已存在的 poll 记录，绝不新建；
//     新建 running/waiting 要求 updated_at 新鲜（启动时扫到的历史会话一行都不写）。
//   ② 心跳节流 + since 继承：活跃行 ≥20s 刷 ts 防 3min stale 兜底；since 由 writeStatus 统一继承。
//   ③ waiting 语义分流：pending + last_activity_at 为空 = 刚建的空会话，不落盘
//     （报 waiting 就是 0.8.2 修掉的那类闲置误报）。
//   ④ 全失败静默降级：DB 不存在/锁死（App 启停窗口期实录会锁数秒）/node:sqlite 缺失，
//     一律跳过本轮沿用现状，绝不打死采集器、绝不据此判「WorkBuddy 不可用」。

const fs = require('fs');
const os = require('os');
const path = require('path');
const stateFiles = require(path.join(__dirname, 'state-files.js'));
const { isValidThreadId } = require(path.join(__dirname, 'codex-deeplink.js'));

// node:sqlite 是 Node 22.13+ 内建；宿主老到没有就整体停用（静默，同降级纪律）。
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

// 运行态新鲜窗：运行期实测 updated_at 1–5s 一写，180s = 36 倍余量。
// 超窗的 working = App 被强杀留下的僵尸行，不写、也停掉心跳让它自然老化。
const ACTIVE_WINDOW_MS = 180 * 1000;
// 心跳节流：同 codex-app-ingest（2s 一轮全量重写是磁盘骚扰，但要防 3min stale 兜底）。
const HEARTBEAT_MS = 20 * 1000;
// serve 心跳文件（~/.workbuddy/sessions/<pid>.json 的 lastHeartbeat）多久算「App 活着」。
const APP_ALIVE_MS = 120 * 1000;
// 每轮最多看最近多少条会话。WorkBuddy 是单人桌面 app，同时活跃的会话个位数。
const QUERY_LIMIT = 20;

// DB status（LOWER 后）→ 协议 state。表冻结在 PROTOCOL.md，改先改协议。
// updateOnly = 只更新已存在的 poll 记录（不报旧闻）。
const STATUS_MAP = {
  working: { state: 'running' },
  planning: { state: 'running' },
  completed: { state: 'done', updateOnly: true },
  failed: { state: 'done', updateOnly: true },
  error: { state: 'done', updateOnly: true },
  terminated: { state: 'ended', updateOnly: true },
  archived: { state: 'ended', updateOnly: true }
  // pending 单独处理（要看 last_activity_at）；未知 status 忽略，绝不映射为 done
};

function defaultHome() {
  return process.env.PET_AS_WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
}

/**
 * @param {object} [deps] { home, dir, now, writeStatus, readStatus, sqliteMod }
 *   全可注入；测试给临时 home，绝不碰真实 ~/.workbuddy。
 */
function createWorkbuddySource(deps) {
  const d = deps || {};
  const home = d.home || defaultHome();
  const dir = d.dir;   // undefined → state-files 默认目录
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const write = typeof d.writeStatus === 'function' ? d.writeStatus : stateFiles.writeStatus;
  const read = typeof d.readStatus === 'function' ? d.readStatus : stateFiles.readStatus;
  const sq = d.sqliteMod !== undefined ? d.sqliteMod : sqlite;
  const dbPath = path.join(home, 'workbuddy.db');

  // serve 进程 pid：~/.workbuddy/sessions/ 下 lastHeartbeat 最新鲜的心跳文件。
  // 拿到的 pid 写进记录 → 采集器既有「pid 死亡→error」推导免费生效。
  // 任何一步失败都只是 pid=null（可选增益，不值得为它抛错）。
  function appPid(at) {
    let best = null;
    let names;
    try { names = fs.readdirSync(path.join(home, 'sessions')); } catch (_) { return null; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(home, 'sessions', name), 'utf8'));
        const hb = Number(j && j.lastHeartbeat);
        const pid = Number(j && j.pid);
        if (!Number.isFinite(hb) || !Number.isFinite(pid)) continue;
        if (at - hb > APP_ALIVE_MS) continue;
        if (best == null || hb > best.hb) best = { hb, pid };
      } catch (_) { /* 单个心跳文件坏了不影响其余 */ }
    }
    return best ? best.pid : null;
  }

  // 读 DB。返回 null = 本轮读不到（锁/缺文件/驱动缺失），调用方沿用现状不写不删。
  function queryRows() {
    if (!sq || typeof sq.DatabaseSync !== 'function') return null;
    let stat;
    try { stat = fs.statSync(dbPath); } catch (_) { return null; }   // 没装 WorkBuddy
    if (!stat.isFile()) return null;
    let db = null;
    try {
      db = new sq.DatabaseSync(dbPath, { readOnly: true });
      // 只 SELECT 白名单列；schema 变了（列没了）这里抛 → 静默降级，内部存储无稳定性承诺
      return db.prepare(
        'SELECT id, cwd, title, custom_title, status, updated_at, last_activity_at '
        + 'FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?'
      ).all(QUERY_LIMIT);
    } catch (_) {
      return null;   // 锁死（App 启停窗口期实录数秒）/ schema 漂移，都按「本轮没读到」
    } finally {
      try { if (db) db.close(); } catch (_) { /* 关不上也不能打死采集轮 */ }
    }
  }

  /** 一轮摄入。返回 {seen, written} 供测试断言；任何失败都静默。 */
  function tick() {
    const at = now();
    const rows = queryRows();
    if (!Array.isArray(rows)) return { seen: 0, written: 0 };
    const pid = appPid(at);
    let written = 0;
    for (const row of rows) {
      const id = row && String(row.id || '');
      if (!isValidThreadId(id)) continue;   // 跳转要拼 URL，脏 id 不落盘（白名单精神）
      const status = String(row.status || '').toLowerCase();
      const updatedAt = Number(row.updated_at);
      const fresh = Number.isFinite(updatedAt) && at - updatedAt <= ACTIVE_WINDOW_MS;

      let mapped = STATUS_MAP[status] || null;
      if (status === 'pending') {
        // awaiting_input（有过活动）→ waiting；刚建的空会话（无活动）不落盘
        if (row.last_activity_at == null) continue;
        mapped = { state: 'waiting' };
      }
      if (!mapped) continue;   // 未知 status 不猜，绝不映射为 done

      // 可写性：只碰 poll 系记录。hook/ipc/reconcile 的一律不覆盖。
      let existing = null;
      try { existing = read(id, dir); } catch (_) { existing = null; }
      if (existing && existing.source !== 'poll') continue;

      if (mapped.state === 'running' || mapped.state === 'waiting') {
        if (existing == null) {
          if (!fresh) continue;   // 不报旧闻：历史会话不新建活跃行
        } else {
          // 心跳门槛：running 还要求 DB 仍新鲜（僵尸 working 停跳自然老化）；
          // waiting 的 updated_at 天然停走（等的就是用户），改用 App 活着判——
          // App 死了停跳，ts 变陈旧 + pid 死 → 采集器自己推导 error。
          const alive = mapped.state === 'running' ? fresh : pid != null;
          if (!alive) continue;
          if (existing.state === mapped.state && at - existing.ts < HEARTBEAT_MS) continue;
        }
      } else {
        if (mapped.updateOnly && existing == null) continue;   // 不报旧闻：终态只更新
        if (existing && existing.state === mapped.state) continue;   // 终态写一次就够
      }

      try {
        write({
          agent: 'workbuddy', form: 'app', source: 'poll',
          sessionId: id,
          cwd: typeof row.cwd === 'string' ? row.cwd : '',
          project: typeof row.cwd === 'string' && row.cwd !== '' ? path.basename(row.cwd) : 'WorkBuddy',
          tty: null, pid,
          state: mapped.state,
          lastEvent: status === 'pending' ? 'poll:awaiting-input' : `poll:status-${status}`,
          ts: at,
          // AI 起的短名（custom_title 用户改名优先）；正文红线不涉及——这不是 prompt
          title: (typeof row.custom_title === 'string' && row.custom_title.trim() !== '')
            ? row.custom_title
            : (typeof row.title === 'string' ? row.title : null)
        }, dir);
        written++;
      } catch (_) { /* 单条写失败不影响其余 */ }
    }
    return { seen: rows.length, written };
  }

  return { tick, ACTIVE_WINDOW_MS, HEARTBEAT_MS, APP_ALIVE_MS };
}

module.exports = { createWorkbuddySource, ACTIVE_WINDOW_MS, HEARTBEAT_MS, APP_ALIVE_MS };
