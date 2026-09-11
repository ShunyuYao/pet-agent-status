'use strict';
// WorkBuddy 来源（PROTOCOL.md「WorkBuddy 来源」；实测依据 fixtures/workbuddy-facts.md §3/§5）。
// 映射表逐条 → 断言；用真 node:sqlite 建临时库（不打桩查询层——锁/类型行为要真实）。
//
// 需求条件 → 断言：
//   ① working/planning + updated_at 新鲜 → running（agent/form/source/tty/pid/project 全字段核）
//   ② working 超窗（>180s，App 强杀僵尸行）→ 不新建
//   ③ 心跳节流：20s 内不重写；超 20s 刷 ts 且 since 继承（计时不归零——0.8.3 教训）
//   ④ pending 无 last_activity_at（刚建的空会话）→ 不落盘（0.8.2 闲置误报教训）
//   ⑤ pending 有活动 + 新鲜 → waiting；陈旧且无记录 → 不新建（不报旧闻）
//   ⑥ waiting 心跳挂「App 活着」：serve 心跳文件新鲜才刷；App 死了停跳（老化→error 归采集器）
//   ⑦ 终态（completed/failed/terminated/archived）只更新已存在 poll 记录，绝不新建；写一次就够
//   ⑧ failed → done 且 lastEvent 记真实 status；terminated/archived → ended
//   ⑨ 未知 status 忽略，绝不映射为 done
//   ⑩ hook 系记录绝不被覆盖
//   ⑪ DB 不存在 / 文件损坏（同锁死降级路径）→ 静默无行为，已有状态文件原样保留
//   ⑫ deleted_at 非空排除；非 UUID id 跳过
//   ⑬ title 取 custom_title > title；首写没起名、后续补上
//   ⑭ done→working（追问）复活为 running 且 since 重起（新活跃段）
//   ⑮ 全程只碰临时目录

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createWorkbuddySource, ACTIVE_WINDOW_MS, HEARTBEAT_MS, APP_ALIVE_MS } =
  require(path.join(ROOT, 'lib', 'workbuddy-source.js'));
const stateFiles = require(path.join(ROOT, 'lib', 'state-files.js'));

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
if (!sqlite) {
  console.log('workbuddy-source-test: SKIP（本机 Node 无 node:sqlite）');
  process.exit(0);
}

const U1 = '3dc39631-091f-4b36-9e02-2ccfef2171c2';   // 活体验证实录形态的 UUID
const U2 = '781c829f-4a77-4c2f-b6eb-2a0beaa42519';

let passed = 0;
const tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'pet-agent-status-wb-'));
  tmpDirs.push(d);
  return d;
}
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { console.log('  FAIL', name); throw e; }
}

// 造一个最小 workbuddy home：DB（只含实现 SELECT 的列 + deleted_at）+ 可选 serve 心跳
function makeHome() {
  const home = tmp();
  const db = new sqlite.DatabaseSync(path.join(home, 'workbuddy.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT, custom_title TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    deleted_at INTEGER, last_activity_at INTEGER)`);
  db.close();
  return home;
}
function upsert(home, row) {
  const db = new sqlite.DatabaseSync(path.join(home, 'workbuddy.db'));
  db.prepare(`INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at, deleted_at, last_activity_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd, title=excluded.title, custom_title=excluded.custom_title,
      status=excluded.status, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
      last_activity_at=excluded.last_activity_at`)
    .run(row.id, row.cwd || '/tmp/proj', row.title ?? null, row.custom_title ?? null,
      row.status, row.created_at ?? 0, row.updated_at, row.deleted_at ?? null, row.last_activity_at ?? null);
  db.close();
}
function heartbeat(home, pid, at) {
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid: String(pid), lastHeartbeat: String(at) }));
}
function makeSource(home, dir, clockRef) {
  return createWorkbuddySource({ home, dir, now: () => clockRef.t });
}
function readRec(dir, id) { return stateFiles.readStatus(id, dir); }

// ① working/planning 新鲜 → running，全字段核（含 pid 来自心跳文件）
test('① working 新鲜 → running（全字段）', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, cwd: '/Users/x/proj-a', status: 'working', updated_at: clock.t - 2000 });
  heartbeat(home, 47254, clock.t - 5000);
  const src = makeSource(home, dir, clock);
  const r = src.tick();
  assert.strictEqual(r.written, 1);
  const rec = readRec(dir, U1);
  assert(rec, '记录已落盘');
  assert.strictEqual(rec.agent, 'workbuddy');
  assert.strictEqual(rec.form, 'app');
  assert.strictEqual(rec.source, 'poll');
  assert.strictEqual(rec.state, 'running');
  assert.strictEqual(rec.tty, null);
  assert.strictEqual(rec.pid, 47254);
  assert.strictEqual(rec.project, 'proj-a');
  assert.strictEqual(rec.lastEvent, 'poll:status-working');
  assert.strictEqual(rec.since, clock.t);
});

test('① planning → running', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'planning', updated_at: clock.t - 1000 });
  makeSource(home, dir, clock).tick();
  assert.strictEqual(readRec(dir, U1).state, 'running');
  assert.strictEqual(readRec(dir, U1).lastEvent, 'poll:status-planning');
});

// ② 僵尸 working（超窗）不新建
test('② working 超 180s 窗 → 不新建（App 强杀僵尸行）', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - ACTIVE_WINDOW_MS - 1000 });
  const r = makeSource(home, dir, clock).tick();
  assert.strictEqual(r.written, 0);
  assert.strictEqual(readRec(dir, U1), null);
});

// ③ 心跳节流 + since 继承
test('③ 20s 内不重写；超 20s 刷 ts 且 since 不归零', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });
  const src = makeSource(home, dir, clock);
  src.tick();
  const first = readRec(dir, U1);
  clock.t += 5000;   // 5s：节流内
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });
  assert.strictEqual(src.tick().written, 0, '节流内不重写');
  clock.t += HEARTBEAT_MS;   // 再过 20s
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });
  assert.strictEqual(src.tick().written, 1, '超节流刷心跳');
  const rec = readRec(dir, U1);
  assert.strictEqual(rec.ts, clock.t, 'ts 已刷新（防 3min stale 兜底）');
  assert.strictEqual(rec.since, first.since, 'since 继承——计时不归零');
});

// ④ 空会话不落盘
test('④ pending 无 last_activity_at → 不落盘（闲置误报教训）', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'pending', updated_at: clock.t - 1000, last_activity_at: null });
  assert.strictEqual(makeSource(home, dir, clock).tick().written, 0);
  assert.strictEqual(readRec(dir, U1), null);
});

// ⑤ awaiting_input → waiting；陈旧不新建
test('⑤ pending 有活动新鲜 → waiting；陈旧无记录 → 不报旧闻', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'pending', updated_at: clock.t - 2000, last_activity_at: clock.t - 3000 });
  upsert(home, { id: U2, status: 'pending', updated_at: clock.t - ACTIVE_WINDOW_MS - 1000, last_activity_at: clock.t - ACTIVE_WINDOW_MS - 2000 });
  makeSource(home, dir, clock).tick();
  const rec = readRec(dir, U1);
  assert.strictEqual(rec.state, 'waiting');
  assert.strictEqual(rec.lastEvent, 'poll:awaiting-input');
  assert.strictEqual(readRec(dir, U2), null, '陈旧 pending 不新建');
});

// ⑥ waiting 心跳挂 App 存活
test('⑥ waiting 心跳：App 活着才刷、App 死了停跳', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'pending', updated_at: clock.t - 2000, last_activity_at: clock.t - 3000 });
  heartbeat(home, 47254, clock.t);
  const src = makeSource(home, dir, clock);
  src.tick();
  // waiting 的 updated_at 天然停走（等的就是用户）——只刷心跳文件，DB 不动
  clock.t += HEARTBEAT_MS + 1000;
  heartbeat(home, 47254, clock.t - 1000);
  assert.strictEqual(src.tick().written, 1, 'App 活着：超节流继续刷');
  const alive = readRec(dir, U1);
  assert.strictEqual(alive.ts, clock.t);
  clock.t += HEARTBEAT_MS + 1000;
  heartbeat(home, 47254, clock.t - APP_ALIVE_MS - 1000);   // 心跳文件过期 = App 死了
  assert.strictEqual(src.tick().written, 0, 'App 死了：停跳，行自然老化交给采集器 error 推导');
  assert.strictEqual(readRec(dir, U1).ts, alive.ts);
});

// ⑦⑧ 终态
test('⑦ 启动扫到历史 completed → 不新建（不报旧闻）', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'completed', updated_at: clock.t - 3000 });
  assert.strictEqual(makeSource(home, dir, clock).tick().written, 0);
  assert.strictEqual(readRec(dir, U1), null);
});

test('⑦ 见过 running 后 completed → done；只写一次', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });
  const src = makeSource(home, dir, clock);
  src.tick();
  clock.t += 7000;
  upsert(home, { id: U1, status: 'completed', updated_at: clock.t - 500 });
  assert.strictEqual(src.tick().written, 1);
  const rec = readRec(dir, U1);
  assert.strictEqual(rec.state, 'done');
  assert.strictEqual(rec.lastEvent, 'poll:status-completed');
  clock.t += 5000;
  assert.strictEqual(src.tick().written, 0, '终态写一次就够，不许每轮重写');
});

test('⑧ failed → done 记真实 status；terminated → ended', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });
  upsert(home, { id: U2, status: 'working', updated_at: clock.t - 1000 });
  const src = makeSource(home, dir, clock);
  src.tick();
  clock.t += 5000;
  upsert(home, { id: U1, status: 'failed', updated_at: clock.t - 500 });
  upsert(home, { id: U2, status: 'Terminated', updated_at: clock.t - 500 });   // 落库大小写混用（facts §3.2）
  src.tick();
  assert.strictEqual(readRec(dir, U1).state, 'done');
  assert.strictEqual(readRec(dir, U1).lastEvent, 'poll:status-failed');
  assert.strictEqual(readRec(dir, U2).state, 'ended');
});

// ⑨ 未知 status
test('⑨ 未知 status 忽略，绝不映射为 done', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });
  const src = makeSource(home, dir, clock);
  src.tick();
  clock.t += 5000;
  upsert(home, { id: U1, status: 'mystery-state', updated_at: clock.t - 500 });
  assert.strictEqual(src.tick().written, 0);
  assert.strictEqual(readRec(dir, U1).state, 'running', '未知态维持原记录不动');
});

// ⑩ hook 记录不可覆盖
test('⑩ 同 id 已有 hook 系记录 → 绝不覆盖', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  stateFiles.writeStatus({
    agent: 'claude-code', sessionId: U1, cwd: '/x', project: 'x', tty: '/dev/ttys001',
    pid: 1, state: 'running', lastEvent: 'UserPromptSubmit', source: 'hook', ts: clock.t - 1000
  }, dir);
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });
  assert.strictEqual(makeSource(home, dir, clock).tick().written, 0);
  assert.strictEqual(readRec(dir, U1).agent, 'claude-code', 'hook 记录原样');
});

// ⑪ 降级
test('⑪ DB 不存在（没装 WorkBuddy）→ 静默无行为', () => {
  const home = tmp(); const dir = tmp();
  const clock = { t: 1789142000000 };
  const r = makeSource(home, dir, clock).tick();
  assert.deepStrictEqual(r, { seen: 0, written: 0 });
});

test('⑪ DB 损坏/锁死降级路径 → 静默跳过，已有状态原样', () => {
  const home = tmp(); const dir = tmp();
  const clock = { t: 1789142000000 };
  fs.writeFileSync(path.join(home, 'workbuddy.db'), 'not a sqlite file');
  stateFiles.writeStatus({
    agent: 'workbuddy', form: 'app', sessionId: U1, cwd: '', project: 'WorkBuddy', tty: null,
    pid: null, state: 'running', lastEvent: 'poll:status-working', source: 'poll', ts: clock.t - 1000
  }, dir);
  const r = makeSource(home, dir, clock).tick();
  assert.deepStrictEqual(r, { seen: 0, written: 0 });
  assert.strictEqual(readRec(dir, U1).state, 'running', '读不到 DB 沿用现状，绝不清行');
});

// ⑫ 过滤
test('⑫ deleted_at 非空排除；非 UUID id 跳过', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000, deleted_at: clock.t - 500 });
  upsert(home, { id: 'not-a-uuid', status: 'working', updated_at: clock.t - 1000 });
  assert.strictEqual(makeSource(home, dir, clock).tick().written, 0);
  assert.strictEqual(readRec(dir, U1), null);
});

// ⑬ 标题
test('⑬ custom_title > title；首写无名后续补上', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });   // AI 还没起名
  const src = makeSource(home, dir, clock);
  src.tick();
  assert.strictEqual(readRec(dir, U1).title, undefined, '没起名不造空标题');
  clock.t += HEARTBEAT_MS + 1000;
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000, title: '床位分配方案', custom_title: null });
  src.tick();
  assert.strictEqual(readRec(dir, U1).title, '床位分配方案', '起名后自然补上');
  const home2 = makeHome(); const dir2 = tmp();
  upsert(home2, { id: U2, status: 'working', updated_at: clock.t - 1000, title: 'AI名', custom_title: '用户改的名' });
  makeSource(home2, dir2, clock).tick();
  assert.strictEqual(readRec(dir2, U2).title, '用户改的名', 'custom_title 优先');
});

// ⑭ 追问复活
test('⑭ done 后追问回 working → running 复活且 since 重起', () => {
  const home = makeHome(); const dir = tmp();
  const clock = { t: 1789142000000 };
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 1000 });
  const src = makeSource(home, dir, clock);
  src.tick();
  const firstSince = readRec(dir, U1).since;
  clock.t += 5000;
  upsert(home, { id: U1, status: 'completed', updated_at: clock.t - 500 });
  src.tick();
  clock.t += 60000;
  upsert(home, { id: U1, status: 'working', updated_at: clock.t - 500 });
  assert.strictEqual(src.tick().written, 1, '终态→活跃立即写，不受节流挡');
  const rec = readRec(dir, U1);
  assert.strictEqual(rec.state, 'running');
  assert(rec.since > firstSince, '新活跃段 since 重起（不是继承旧段）');
});

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
console.log(`\nworkbuddy-source-test: ${passed} 通过 / 0 失败`);
