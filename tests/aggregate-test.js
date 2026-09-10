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
const { createPetLink, THROTTLE_MS, DONE_ANIM, HOST_ANIM_STATES } =
  require(path.join(ROOT, 'lib', 'pet-link.js'));
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

// 隔离自证的判据是「本轮没有新增/改动这些真实路径」，不是「它们不存在」——
// 插件被真实使用后状态目录与备份文件必然存在（2026-09-10 在用户机器上误报过，
// 4 个套件同时变红，而实现完全正常）。快照在首个 test 前拍，收尾比对。
function guardSnapshot(paths) {
  return paths.map((p) => {
    if (!fs.existsSync(p)) return `${p}@absent`;
    let st;
    try { st = fs.statSync(p); } catch (_) { return `${p}@gone`; }
    if (st.isDirectory()) {
      const names = fs.readdirSync(p).sort().map((n) => {
        let m = 0;
        try { m = fs.statSync(path.join(p, n)).mtimeMs; } catch (_) { /* 竞态 */ }
        return `${n}:${m}`;
      });
      return `${p}@dir[${names.join(',')}]`;
    }
    return `${p}@file:${st.mtimeMs}`;
  });
}
const GUARD_PATHS = [
  path.join(os.homedir(), '.local', 'state', 'pet-agent-status'),
  path.join(os.homedir(), '.claude', 'settings.json.bak-pet-agent-status'),
  path.join(os.homedir(), '.codex', 'hooks.json.bak-pet-agent-status')
];
const GUARD_BEFORE = guardSnapshot(GUARD_PATHS);

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

test('done / ended 前 5 分钟显示为 done（绿驻留），过窗转 idle', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'a', state: 'done', lastEvent: 'Stop', ts: T0 - 1000 }),
    rec({ sessionId: 'b', state: 'ended', lastEvent: 'SessionEnd', ts: T0 - 1000 }),
    rec({ sessionId: 'c', state: 'done', lastEvent: 'Stop', ts: T0 - 6 * MIN }),
    rec({ sessionId: 'edge', state: 'done', lastEvent: 'Stop', ts: T0 - 5 * MIN })
  ]);
  const states = {};
  for (const r of run(snap).rows) states[r.sessionId] = r.state;
  // 驻留窗边界（恰好 5 分钟）仍算 done，过一毫秒才转 idle
  assert.deepStrictEqual(states, { a: 'done', b: 'done', c: 'idle', edge: 'done' });
});

test('running 超 20min 变 idle', () => {
  const dir = tmp();
  const snap = seed(dir, [rec({ sessionId: 'a', ts: T0 - 21 * MIN })]);
  assert.strictEqual(run(snap).rows[0].state, 'idle');
});

test('idle 超 20min 不进输出行（面板移除）', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'fresh', state: 'done', lastEvent: 'Stop', ts: T0 - 6 * MIN }),
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
    rec({ sessionId: 'e', state: 'running', pid: 999999, ts: T0 - 2 * MIN }),
    rec({ sessionId: 'd', state: 'done', lastEvent: 'Stop', ts: T0 - 3 * MIN })
  ]);
  // error 只因 pid 探测为假而来：同一份输入换成「pid 存活」就该是 running
  const dead = run(snap, { isPidAlive: (pid) => pid !== 999999 });
  assert.deepStrictEqual(byId(dead.rows), ['w-old', 'r-new', 'e', 'd']);
  assert.deepStrictEqual(dead.rows.map((r) => r.state), ['waiting', 'running', 'error', 'done']);
  const allAlive = run(snap, { isPidAlive: () => true });
  assert.strictEqual(allAlive.rows.find((r) => r.sessionId === 'e').state, 'running',
    'error 必须来自 pid 探测，不是别的原因');
});

// 上一条里 e 排在 d 前面**只因为 e 的 ts 更新**，不是「error 比 idle 优先」。
// DESIGN.md 排序规则只有两档（waiting 置顶 / 其余 ts 降序），没有按状态排的第三档；
// 把两者 ts 对调，顺序就该跟着翻过来——否则说明实现偷偷加了状态优先级。
test('非 waiting 行只按 ts 降序，与状态无关（error 不因是 error 而置前）', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'e', state: 'running', pid: 999999, ts: T0 - 9 * MIN }),
    rec({ sessionId: 'd', state: 'done', lastEvent: 'Stop', ts: T0 - 1 * MIN })
  ]);
  const { rows } = run(snap, { isPidAlive: (pid) => pid !== 999999 });
  assert.deepStrictEqual(byId(rows), ['d', 'e'], 'ts 更新的 done 应排在更旧的 error 之前');
  assert.deepStrictEqual(rows.map((r) => r.state), ['done', 'error']);
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
  assert.deepStrictEqual(summary, { running: 2, waiting: 1, total: 3, unknown: 0, focus: { sessionId: 'w1', state: 'waiting', project: 'demo' } });
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
// 造行时 raw 跟着 state 走，与 aggregate 真实产出同形：
// done/ended 的展示态是 idle，联动看的是 raw。用裸 state 造行会走进兼容回落分支，
// 等于在测一个 aggregate 根本不产出的形态（US-001「夹具形态必须真实」的教训）。
const DISPLAY = { done: 'done', ended: 'done' };  // 5 分钟驻留窗内的展示态
const row = (over) => {
  const o = Object.assign({ sessionId: 's', project: 'alpha', state: 'running' }, over);
  if (o.raw == null) o.raw = o.state;
  o.state = DISPLAY[o.state] || o.state;
  return o;
};

test('running / idle 状态本身不提醒（只有 done、waiting 两种迁移才喊）', () => {
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
    ['playAnim', DONE_ANIM],
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

test('节流按会话隔离，但同批多 done 合并成一条（不轮流打扰）', () => {
  const link = createPetLink();
  const m = mockPet();
  link.onSnapshot([row({ sessionId: 'a', state: 'running' }), row({ sessionId: 'b', state: 'running' })], m, { now: T0, t });
  link.onSnapshot([
    row({ sessionId: 'a', state: 'done', project: 'alpha' }),
    row({ sessionId: 'b', state: 'done', project: 'beta' })
  ], m, { now: T0 + 2000, t });
  const bubbles = m.calls.filter((c) => c[0] === 'bubble').map((c) => c[1]);
  assert.deepStrictEqual(bubbles, [t('bubble.multiDone', { n: 2 })], '两个 done 同批只出一条合并气泡');
  // 节流仍按会话隔离：稍后第三个会话 done 照样能提醒（没被合并波及）
  link.onSnapshot([row({ sessionId: 'c', state: 'running', project: 'gamma' })], m, { now: T0 + 3000, t });
  link.onSnapshot([row({ sessionId: 'c', state: 'done', project: 'gamma' })], m, { now: T0 + 4000, t });
  const later = m.calls.filter((c) => c[0] === 'bubble').map((c) => c[1]);
  assert.strictEqual(later[later.length - 1], t('bubble.done', { project: 'gamma' }));
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

// 全链路：hook 落盘 → readSnapshots → aggregate → petLink。
// 这条是「完成提醒」唯一的真实触发路径，DESIGN.md 的头号联动就靠它。
test('全链路：done 落盘后宠物真的提醒（展示态是 idle 也照喊）', () => {
  const dir = tmp();
  const link = createPetLink();
  const m = mockPet();
  // 先 running 一轮
  seed(dir, [rec({ sessionId: 'a', state: 'running', ts: T0 })]);
  let out = run(sf.readSnapshots(dir), { now: T0 });
  link.onSnapshot(out.rows, m, { now: T0, t });
  assert.deepStrictEqual(m.calls, [], 'running 不提醒');
  // hook 写入 done：展示态被推成 idle（灰、随后淡出），但联动必须按落盘态触发
  sf.writeStatus(rec({ sessionId: 'a', state: 'done', lastEvent: 'Stop', ts: T0 + 1000 }), dir);
  out = run(sf.readSnapshots(dir), { now: T0 + 2000 });
  assert.strictEqual(out.rows[0].state, 'done', '展示态：done 驻留窗内显示为 done');
  assert.strictEqual(out.rows[0].raw, 'done', '落盘态原样带出，供联动判定迁移');
  link.onSnapshot(out.rows, m, { now: T0 + 2000, t });
  assert.deepStrictEqual(m.calls, [
    ['playAnim', DONE_ANIM],
    ['bubble', t('bubble.done', { project: 'demo' })]
  ], '差事办完必须喊——只看展示态的话 done 永远被 idle 盖住，这个提醒就成了死代码');
});

// ---- 6.1 动作名必须是宿主认得的（否则 playAnim 静默丢弃 = 另一种死代码）----
//
// 上面那两条 deepStrictEqual 用的是 DONE_ANIM 常量，改名不会让它们转红 ——
// 它们锁的是「调了几次、什么顺序」，锁不住「名字宿主认不认」。
// 真正载重的是下面这条白名单断言：宿主消费端 renderer.js 写的是
// `else if (ANIM[s] || STATE_FALLBACK[s]) setState(s);`，两个集合都不命中就
// 什么都不做（无告警、无回落），所以名字写错 = DESIGN.md 的头号联动在生产里空转。
test('DONE_ANIM 必须是宿主合法动作名（写错则 playAnim 被宿主静默丢弃）', () => {
  assert.ok(HOST_ANIM_STATES.includes(DONE_ANIM),
    `DONE_ANIM='${DONE_ANIM}' 不在宿主 ANIM/STATE_FALLBACK 全集里，` +
    `宿主 renderer 会静默丢弃这次 playAnim，动画在真机上根本不播。` +
    `合法全集：${HOST_ANIM_STATES.join('/')}`);
});

test('实际发给 pet.playAnim 的参数落在宿主合法动作名集合内（拦截参数而非调用次数）', () => {
  const link = createPetLink();
  const m = mockPet();
  link.onSnapshot([row({ state: 'running' })], m, { now: T0, t });
  link.onSnapshot([row({ state: 'done' })], m, { now: T0 + 2000, t });
  const anims = m.calls.filter((c) => c[0] === 'playAnim').map((c) => c[1]);
  assert.ok(anims.length > 0, '这条用例要真的观察到 playAnim 参数，否则是空断言');
  for (const name of anims) {
    assert.ok(HOST_ANIM_STATES.includes(name), `playAnim('${name}') 宿主不认识`);
  }
});

// 'unread' 除了语义最贴，还额外在 STATE_FALLBACK 里 —— 角色包缺「未读信息」素材时
// 宿主能回落 idle。这只是本次选型的加分项，**不是宿主的硬要求**：
// 只要名字在 ANIM 里（如 greet），`ANIM[s]` 为真，宿主照样 setState 播放。
// 所以这条只做记录性断言，不把「必须有 fallback」升成验收门槛 ——
// 真正的红线判据是上面那条「必须在 HOST_ANIM_STATES 内」。
test('DONE_ANIM 选型备注：unread 额外享有 STATE_FALLBACK 替身（缺素材可回落 idle）', () => {
  const HOST_STATE_FALLBACK_KEYS = ['wake', 'think', 'send', 'drag', 'unread',
    'edgehide', 'dropempty', 'dropfull'];
  // 换成 greet 等只在 ANIM 里的名字仍然合法（宿主会播），只是缺素材时没有替身。
  if (!HOST_STATE_FALLBACK_KEYS.includes(DONE_ANIM)) {
    assert.ok(HOST_ANIM_STATES.includes(DONE_ANIM),
      `DONE_ANIM='${DONE_ANIM}' 既不在 STATE_FALLBACK 也不在 ANIM，宿主会静默丢弃`);
  }
  assert.ok(HOST_ANIM_STATES.includes(DONE_ANIM));
});

test('全链路：waiting 落盘后只 bubble 不 playAnim', () => {
  const dir = tmp();
  const link = createPetLink();
  const m = mockPet();
  seed(dir, [rec({ sessionId: 'a', state: 'running', ts: T0 })]);
  link.onSnapshot(run(sf.readSnapshots(dir), { now: T0 }).rows, m, { now: T0, t });
  sf.writeStatus(rec({ sessionId: 'a', state: 'waiting', lastEvent: 'Notification', ts: T0 + 1000 }), dir);
  const out = run(sf.readSnapshots(dir), { now: T0 + 2000 });
  assert.strictEqual(out.rows[0].state, 'waiting');
  link.onSnapshot(out.rows, m, { now: T0 + 2000, t });
  assert.deepStrictEqual(m.calls, [['bubble', t('bubble.waiting', { project: 'demo' })]]);
});

test('ended（用户退出会话）不喊「差事办完啦」——那是关窗不是干完活', () => {
  const dir = tmp();
  const link = createPetLink();
  const m = mockPet();
  seed(dir, [rec({ sessionId: 'a', state: 'running', ts: T0 })]);
  link.onSnapshot(run(sf.readSnapshots(dir), { now: T0 }).rows, m, { now: T0, t });
  sf.writeStatus(rec({ sessionId: 'a', state: 'ended', lastEvent: 'SessionEnd', ts: T0 + 1000 }), dir);
  const out = run(sf.readSnapshots(dir), { now: T0 + 2000 });
  assert.strictEqual(out.rows[0].raw, 'ended');
  link.onSnapshot(out.rows, m, { now: T0 + 2000, t });
  assert.deepStrictEqual(m.calls, []);
});

test('unknown 行不触发任何联动（读不出来的会话绝不报完成）', () => {
  const dir = tmp();
  const link = createPetLink();
  const m = mockPet();
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ 截断的', 'utf8');
  const out = run(sf.readSnapshots(dir));
  assert.strictEqual(out.rows[0].state, 'unknown');
  assert.strictEqual(out.rows[0].raw, 'unknown');
  link.onSnapshot(out.rows, m, { now: T0, t });
  assert.deepStrictEqual(m.calls, []);
});

// ---- 7. 隔离自证 ----

test('测试全程未触碰真实状态目录', () => {
  const real = path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
  assert.deepStrictEqual(guardSnapshot(GUARD_PATHS), GUARD_BEFORE, '真实路径本轮被动过');
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed`);

// ---- 6. 聚焦会话（对齐 Codex Pets following 语义的 CLI 版）----

test('focus 选择：waiting > running > error > done，同级取最新；每行都带布尔 focused', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'r-new', state: 'running', ts: T0 - 1000 }),
    rec({ sessionId: 'w-old', state: 'waiting', lastEvent: 'Notification', ts: T0 - 10 * MIN }),
    rec({ sessionId: 'w-new', state: 'waiting', lastEvent: 'Notification', ts: T0 - 9 * MIN }),
    rec({ sessionId: 'd', state: 'done', lastEvent: 'Stop', ts: T0 - 1000 })
  ]);
  const { rows, summary } = run(snap);
  assert.deepStrictEqual(summary.focus, { sessionId: 'w-new', state: 'waiting', project: 'demo' });
  for (const r of rows) assert.strictEqual(typeof r.focused, 'boolean', '每行都要有布尔 focused');
  assert.deepStrictEqual(rows.filter((r) => r.focused).map((r) => r.sessionId), ['w-new']);
});

test('focus 无 waiting 时落到最新 running；全 idle 时也有 focus（不为 null 除非零行）', () => {
  const dir = tmp();
  const snap = seed(dir, [
    rec({ sessionId: 'r-old', state: 'running', ts: T0 - 5 * MIN }),
    rec({ sessionId: 'r-new', state: 'running', ts: T0 - 1000 })
  ]);
  assert.strictEqual(run(snap).summary.focus.sessionId, 'r-new');
  assert.strictEqual(run(sf.readSnapshots(tmp())).summary.focus, null, '零行时 focus 为 null');
});

// ---- 7. 联动同批合并（多会话并发不轮流打扰）----

test('两个 done 同批：playAnim 一次 + 一条合并气泡', () => {
  const m = mockPet();
  const link = createPetLink();
  link.onSnapshot([row({ sessionId: 'a', state: DISPLAY.done, raw: 'done', project: 'pa' }),
                   row({ sessionId: 'b', state: DISPLAY.done, raw: 'done', project: 'pb' })].map((r, i) => ({ ...r, ts: T0 - i })),
                  m, { now: T0, t });
  // 首见 done 不提醒——先建立基线
  assert.deepStrictEqual(m.calls, []);
  const m2 = mockPet();
  const link2 = createPetLink();
  link2.onSnapshot([row({ sessionId: 'a', state: 'running', raw: 'running', project: 'pa' }),
                    row({ sessionId: 'b', state: 'running', raw: 'running', project: 'pb' })], m2, { now: T0, t });
  const fired = link2.onSnapshot(
    [row({ sessionId: 'a', state: DISPLAY.done, raw: 'done', project: 'pa' }),
     row({ sessionId: 'b', state: DISPLAY.done, raw: 'done', project: 'pb' })], m2, { now: T0 + 1000, t });
  assert.strictEqual(m2.calls.filter((c) => c[0] === 'playAnim').length, 1, '动画只播一次');
  assert.strictEqual(m2.calls.filter((c) => c[0] === 'bubble').length, 1, '气泡只一条');
  assert.ok(m2.calls.find((c) => c[0] === 'bubble')[1].includes('2'), '合并文案带数量');
  assert.strictEqual(fired.find((f) => f.kind === 'bubble').merged, true);
});

test('waiting + done 同批：waiting 是主角，mixed 文案，动画仍播（有 done）', () => {
  const m = mockPet();
  const link = createPetLink();
  link.onSnapshot([row({ sessionId: 'w', state: 'running', raw: 'running', project: 'pw' }),
                   row({ sessionId: 'd', state: 'running', raw: 'running', project: 'pd' })], m, { now: T0, t });
  m.calls.length = 0;
  link.onSnapshot([row({ sessionId: 'w', state: 'waiting', raw: 'waiting', project: 'pw' }),
                   row({ sessionId: 'd', state: DISPLAY.done, raw: 'done', project: 'pd' })], m, { now: T0 + 1000, t });
  const bubbles = m.calls.filter((c) => c[0] === 'bubble');
  assert.strictEqual(bubbles.length, 1);
  assert.ok(bubbles[0][1].includes('pw'), 'waiting 的项目名是主角');
  assert.strictEqual(m.calls.filter((c) => c[0] === 'playAnim').length, 1, '批里有 done，动画照播');
});
