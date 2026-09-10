'use strict';
// US-003 验收测试：aggregate 推导态 / 排序 / 行结构 + 宠物联动节流。
// 全离线：状态文件用 mkdtemp 真实落盘再读（不直调内部函数自证），时间与 pid 探测一律注入。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sf = require(path.join(ROOT, 'lib', 'state-files.js'));
const agg = require(path.join(ROOT, 'lib', 'aggregate.js'));
const { createPetLink, THROTTLE_MS } = require(path.join(ROOT, 'lib', 'pet-link.js'));
const { createNodeI18n } = require(path.join(ROOT, 'lib', 'i18n.js'));

const T0 = 1789000000000;   // 固定基准，测试绝不用真实时钟
const MIN = 60 * 1000;

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-agg-'));
  tmpDirs.push(d);
  return d;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const t = createNodeI18n('zh-CN').t;

// 真实通道：经 writeStatus 落盘再 readSnapshots 读回，喂给 aggregate
function seed(dir, recs) {
  for (const r of recs) sf.writeStatus(r, dir);
  return sf.readSnapshots(dir);
}
function rec(over) {
  return Object.assign({
    agent: 'claude-code', sessionId: 's', cwd: '/Users/me/projects/demo',
    tty: '/dev/ttys001', pid: 4242, state: 'running', lastEvent: 'UserPromptSubmit', ts: T0
  }, over);
}
function run(snapshot, over) {
  return agg.aggregate(snapshot, Object.assign({ now: T0, isPidAlive: () => true, t }, over));
}
const byId = (rows) => rows.map((r) => r.sessionId);

// ---- 1. error 推导：三个条件缺一不可 ----

test('error 推导：running + 超 60s + pid 不存活', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', state: 'running', pid: 999999, ts: T0 - 90 * 1000 })]);
  const { rows } = run(snap, { isPidAlive: () => false });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].state, 'error');
  assert.strictEqual(rows[0].subline, t('state.error'));
});

test('error 推导：waiting 也适用', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', state: 'waiting', ts: T0 - 90 * 1000 })]);
  assert.strictEqual(run(snap, { isPidAlive: () => false }).rows[0].state, 'error');
});

test('pid 存活时不判 error（哪怕已超 60s）', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', ts: T0 - 90 * 1000 })]);
  assert.strictEqual(run(snap, { isPidAlive: () => true }).rows[0].state, 'running');
});

test('未超 60s 不判 error（进程不存活也不判）', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', ts: T0 - 30 * 1000 })]);
  assert.strictEqual(run(snap, { isPidAlive: () => false }).rows[0].state, 'running');
});

test('pid 为 null 时不判 error（探测不了就不猜）', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', pid: null, ts: T0 - 90 * 1000 })]);
  const { rows } = run(snap, { isPidAlive: () => { throw new Error('pid 为 null 时不该探测'); } });
  assert.strictEqual(rows[0].state, 'running');
});

test('60s 边界：正好 60s 不判 error，60s+1ms 才判', () => {
  const dir = tmp();
  const at = seed(dir, [rec({ sessionId: 'a', ts: T0 - 60 * 1000 })]);
  assert.strictEqual(run(at, { isPidAlive: () => false }).rows[0].state, 'running');
  const dir2 = tmp();
  const over = seed(dir2, [rec({ sessionId: 'a', ts: T0 - 60 * 1000 - 1 })]);
  assert.strictEqual(run(over, { isPidAlive: () => false }).rows[0].state, 'error');
});

// ---- 2. idle 推导与 20min 移除 ----

test('done / ended 一律显示为 idle', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'a', state: 'done', lastEvent: 'Stop', ts: T0 - 1000 }),
    rec({ sessionId: 'b', state: 'ended', lastEvent: 'SessionEnd', ts: T0 - 1000 })
  ]);
  const states = {};
  for (const r of run(snap).rows) states[r.sessionId] = r.state;
  assert.deepStrictEqual(states, { a: 'idle', b: 'idle' });
});

test('running 超 20min 变 idle', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', ts: T0 - 21 * MIN })]);
  assert.strictEqual(run(snap).rows[0].state, 'idle');
});

test('idle 超 20min 不进输出行（面板移除）', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'fresh', state: 'done', lastEvent: 'Stop', ts: T0 - 5 * MIN }),
    rec({ sessionId: 'stale', state: 'done', lastEvent: 'Stop', ts: T0 - 25 * MIN })
  ]);
  assert.deepStrictEqual(byId(run(snap).rows), ['fresh']);
});

test('error 优先于 idle：超 20min 且 pid 死了仍报 error 不移除', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', state: 'running', ts: T0 - 25 * MIN })]);
  const { rows } = run(snap, { isPidAlive: () => false });
  assert.strictEqual(rows.length, 1, 'error 行不该被 idle 移除规则吃掉');
  assert.strictEqual(rows[0].state, 'error');
});

// ---- 3. unknown：绝不映射成 done ----

test('损坏文件归 unknown 行，绝不当 done/idle', () => {
  const dir = tmp();
  seed(dir, [rec({ sessionId: 'good', state: 'running' })]);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ 截断的', 'utf8');
  const { rows, summary } = run(sf.readSnapshots(dir));
  const bad = rows.find((r) => r.sessionId === 'broken');
  assert.ok(bad, 'unknown 文件也要有一行，否则用户看不出有会话读不了');
  assert.strictEqual(bad.state, 'unknown');
  assert.strictEqual(bad.subline, t('state.unknown'));
  assert.notStrictEqual(bad.subline, t('state.done'));
  assert.notStrictEqual(bad.subline, t('state.idle'), 'unknown 文案必须与 idle 区分');
  assert.strictEqual(summary.unknown, 1);
});

test('schema 高于当前版本归 unknown（不当 done）', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'future.json'), JSON.stringify({
    schema: 99, agent: 'claude-code', sessionId: 'future', cwd: '/x', project: 'x',
    tty: null, pid: null, state: 'done', lastEvent: 'Stop', ts: T0
  }), 'utf8');
  const { rows } = run(sf.readSnapshots(dir));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].state, 'unknown');
  assert.strictEqual(rows[0].reason, 'schema-too-new');
});

// ---- 4. 排序：waiting 恒置顶 ----

test('waiting 全部置顶，组内 ts 降序；其余 ts 降序（乱序输入）', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'run-old', state: 'running', ts: T0 - 10 * MIN }),
    rec({ sessionId: 'wait-old', state: 'waiting', lastEvent: 'Notification', ts: T0 - 8 * MIN }),
    rec({ sessionId: 'run-new', state: 'running', ts: T0 - 1 * MIN }),
    rec({ sessionId: 'wait-new', state: 'waiting', lastEvent: 'Notification', ts: T0 - 2 * MIN })
  ]);
  assert.deepStrictEqual(byId(run(snap).rows), ['wait-new', 'wait-old', 'run-new', 'run-old']);
});

test('criteria §3 场景：[waiting 置顶, running, done(idle), error]', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'r-new', state: 'running', ts: T0 - 5 * 1000 }),
    rec({ sessionId: 'w-old', state: 'waiting', lastEvent: 'Notification', ts: T0 - 10 * MIN }),
    rec({ sessionId: 'd', state: 'done', lastEvent: 'Stop', ts: T0 - 2 * MIN }),
    rec({ sessionId: 'e', state: 'running', pid: 999999, ts: T0 - 3 * MIN })
  ]);
  // error 只因 pid 探测为假而来：同一份输入换成「pid 存活」就该是 running
  const dead = run(snap, { isPidAlive: (pid) => pid !== 999999 });
  assert.deepStrictEqual(byId(dead.rows), ['w-old', 'r-new', 'e', 'd']);
  assert.deepStrictEqual(dead.rows.map((r) => r.state), ['waiting', 'running', 'error', 'idle']);
  const allAlive = run(snap, { isPidAlive: () => true });
  assert.strictEqual(allAlive.rows.find((r) => r.sessionId === 'e').state, 'running',
    'error 必须来自 pid 探测，不是别的原因');
});

// ---- 5. 行结构：panel 不再算业务字段 ----

test('行结构含 panel 渲染所需全部字段', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', cwd: '/Users/me/projects/alpha', ts: T0 - 65 * 1000 })]);
  const row = run(snap).rows[0];
  for (const key of ['agent', 'form', 'project', 'state', 'subline', 'timeText', 'sessionId']) {
    assert.ok(key in row, `缺字段 ${key}`);
  }
  assert.strictEqual(row.agent, 'claude-code');
  assert.strictEqual(row.form, 'cli');
  assert.strictEqual(row.project, 'alpha');
  assert.strictEqual(row.subline, t('state.running'));
  assert.strictEqual(row.tty, '/dev/ttys001', 'US-005 跳转要用 tty');
});

test('running 行时间显 mm:ss，完成行显相对时间', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'r', state: 'running', ts: T0 - (3 * 60 + 7) * 1000 }),
    rec({ sessionId: 'd', state: 'done', lastEvent: 'Stop', ts: T0 - 4 * MIN })
  ]);
  const rows = run(snap).rows;
  const r = rows.find((x) => x.sessionId === 'r');
  const d = rows.find((x) => x.sessionId === 'd');
  assert.strictEqual(r.timeText, '03:07');
  assert.strictEqual(d.timeText, t('time.minutesAgo', { n: 4 }));
});

test('不足 1 分钟的完成行显「刚刚」', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'd', state: 'done', lastEvent: 'Stop', ts: T0 - 20 * 1000 })]);
  assert.strictEqual(run(snap).rows[0].timeText, t('time.justNow'));
});

test('summary 计数与行一致', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'r1', state: 'running', ts: T0 }),
    rec({ sessionId: 'r2', state: 'running', ts: T0 }),
    rec({ sessionId: 'w1', state: 'waiting', lastEvent: 'Notification', ts: T0 })
  ]);
  const { summary } = run(snap);
  assert.deepStrictEqual(summary, { running: 2, waiting: 1, total: 3, unknown: 0 });
});

test('空目录 → 空行与零计数（面板据此进空态）', () => {
  const { rows, summary } = run(sf.readSnapshots(tmp()));
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(summary.total, 0);
});

// ---- 6. 宠物联动与节流 ----

function mockPet() {
  const calls = [];
  return {
    calls,
    pet: {
      bubble: (text) => calls.push(['bubble', text]),
      playAnim: (name) => calls.push(['playAnim', name])
    }
  };
}
const row = (over) => Object.assign({ sessionId: 's', project: 'alpha', state: 'running' }, over);

test('done 迁移 → playAnim + bubble 各一次', () => {
  const link = createPetLink();
  const m = mockPet();
  link.onSnapshot([row({ state: 'running' })], m, { now: T0, t });
  assert.deepStrictEqual(m.calls, [], 'running 不提醒');
  link.onSnapshot([row({ state: 'idle' })], m, { now: T0 + 1000, t });
  assert.deepStrictEqual(m.calls, [], 'idle 不提醒');
});

test('running → done 触发 playAnim + bubble（顺序与文案）', () => {
  const link = createPetLink();
  const m = mockPet();
  link.onSnapshot([row({ state: 'running' })], m, { now: T0, t });
  link.onSnapshot([row({ state: 'done' })], m, { now: T0 + 2000, t });
  assert.deepStrictEqual(m.calls, [
    ['playAnim', 'receive-message'],
    ['bubble', t('bubble.done', { project: 'alpha' })]
  ]);
});

test('running → waiting 只 bubble，不 playAnim', () => {
  const link = createPetLink();
  const m = mockPet();
  link.onSnapshot([row({ state: 'running' })], m, { now: T0, t });
  link.onSnapshot([row({ state: 'waiting' })], m, { now: T0 + 2000, t });
  assert.deepStrictEqual(m.calls, [['bubble', t('bubble.waiting', { project: 'alpha' })]]);
});

test('同状态连续 tick 不重复提醒（迁移驱动，不是状态驱动）', () => {
  const link = createPetLink();
  const m = mockPet();
  link.onSnapshot([row({ state: 'running' })], m, { now: T0, t });
  link.onSnapshot([row({ state: 'waiting' })], m, { now: T0 + 2000, t });
  const after = m.calls.length;
  for (let i = 1; i <= 10; i++) link.onSnapshot([row({ state: 'waiting' })], m, { now: T0 + 2000 + i * 2000, t });
  assert.strictEqual(m.calls.length, after, '每 2 秒一次气泡是灾难');
});

test('同 (sessionId,state) 5 分钟内最多一次；过窗后可再提醒', () => {
  const link = createPetLink();
  const m = mockPet();
  // waiting → running → waiting 在 5 分钟内来回：第二次 waiting 被节流吃掉
  link.onSnapshot([row({ state: 'waiting' })], m, { now: T0, t });
  assert.strictEqual(m.calls.length, 1);
  link.onSnapshot([row({ state: 'running' })], m, { now: T0 + 60 * 1000, t });
  link.onSnapshot([row({ state: 'waiting' })], m, { now: T0 + 2 * MIN, t });
  assert.strictEqual(m.calls.length, 1, '5 分钟窗口内同状态不重复');
  // 过窗后再迁移到 waiting，允许再喊一次
  link.onSnapshot([row({ state: 'running' })], m, { now: T0 + 5 * MIN + 1000, t });
  link.onSnapshot([row({ state: 'waiting' })], m, { now: T0 + 6 * MIN, t });
  assert.strictEqual(m.calls.length, 2);
  assert.strictEqual(THROTTLE_MS, 5 * MIN);
});

test('节流按会话隔离：另一个会话同时 done 照样提醒', () => {
  const link = createPetLink();
  const m = mockPet();
  link.onSnapshot([row({ sessionId: 'a', state: 'running' }), row({ sessionId: 'b', state: 'running' })], m, { now: T0, t });
  link.onSnapshot([
    row({ sessionId: 'a', state: 'done', project: 'alpha' }),
    row({ sessionId: 'b', state: 'done', project: 'beta' })
  ], m, { now: T0 + 2000, t });
  const bubbles = m.calls.filter((c) => c[0] === 'bubble').map((c) => c[1]);
  assert.deepStrictEqual(bubbles, [
    t('bubble.done', { project: 'alpha' }),
    t('bubble.done', { project: 'beta' })
  ]);
});

test('首见即 done 的历史会话不提醒（不报旧闻），首见 waiting 要提醒', () => {
  const linkA = createPetLink();
  const mA = mockPet();
  linkA.onSnapshot([row({ state: 'done' })], mA, { now: T0, t });
  assert.deepStrictEqual(mA.calls, [], '插件启动前就结束的会话不该喊「办完啦」');

  const linkB = createPetLink();
  const mB = mockPet();
  linkB.onSnapshot([row({ state: 'waiting' })], mB, { now: T0, t });
  assert.strictEqual(mB.calls.length, 1, 'waiting 首见要喊——用户此刻真被挡着');
});

test('playAnimGuard 返回 false 时降级为仅 bubble（宿主动画冲突）', () => {
  const link = createPetLink({ playAnimGuard: () => false });
  const m = mockPet();
  link.onSnapshot([row({ state: 'running' })], m, { now: T0, t });
  link.onSnapshot([row({ state: 'done' })], m, { now: T0 + 2000, t });
  assert.deepStrictEqual(m.calls, [['bubble', t('bubble.done', { project: 'alpha' })]],
    'bubble 永发、playAnim 受守卫（notes 定的策略）');
});

test('pet.bubble 抛错不打死采集器（下一轮还得跑）', () => {
  const link = createPetLink();
  const boom = { pet: { bubble: () => { throw new Error('宿主拒绝'); }, playAnim: () => {} } };
  link.onSnapshot([row({ state: 'running' })], boom, { now: T0, t });
  assert.doesNotThrow(() => link.onSnapshot([row({ state: 'done' })], boom, { now: T0 + 2000, t }));
});

test('联动吃的是 aggregate 的输出（真实链路：done 落盘 → idle 行不触发 done 提醒）', () => {
  const dir = tmp();
  const link = createPetLink();
  const m = mockPet();
  // 先 running 一轮
  seed(dir, [rec({ sessionId: 'a', state: 'running', ts: T0 })]);
  let out = run(sf.readSnapshots(dir), { now: T0 });
  link.onSnapshot(out.rows, m, { now: T0, t });
  // hook 写入 done → aggregate 推成 idle
  sf.writeStatus(rec({ sessionId: 'a', state: 'done', lastEvent: 'Stop', ts: T0 + 1000 }), dir);
  out = run(sf.readSnapshots(dir), { now: T0 + 2000 });
  assert.strictEqual(out.rows[0].state, 'idle');
  link.onSnapshot(out.rows, m, { now: T0 + 2000, t });
  assert.deepStrictEqual(m.calls, [],
    'done 经 aggregate 变 idle，联动看的行状态里没有 done —— 这条锁死「完成提醒」的实际触发源');
});

// ---- 7. 隔离自证 ----

test('测试全程未触碰真实状态目录', () => {
  const real = path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
  assert.strictEqual(fs.existsSync(real), false, `真实状态目录不该存在：${real}`);
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed`);
