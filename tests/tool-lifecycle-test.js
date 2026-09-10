'use strict';
// US-003 验收测试：tool 采集器的生命周期（activate/deactivate、scheduler 契约、tick 韧性）。
//
// 全离线：状态文件走 mkdtemp 真实落盘再读，时钟与 pid 探测一律注入，
// pet SDK 用 mock（形状照 sdk-surface.js：pet.scheduler / pet.events / pet.pet）。
// 不起 Electron、不碰真实状态目录。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sf = require(path.join(ROOT, 'lib', 'state-files.js'));
const tool = require(path.join(ROOT, 'tool', 'index.js'));
const { createNodeI18n } = require(path.join(ROOT, 'lib', 'i18n.js'));
const { DONE_ANIM, HOST_ANIM_STATES } = require(path.join(ROOT, 'lib', 'pet-link.js'));
const installer = require(path.join(ROOT, 'lib', 'claude-hooks-installer.js'));

const T0 = 1789000000000;
const t = createNodeI18n('zh-CN').t;

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-tool-'));
  tmpDirs.push(d);
  return d;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n${err && err.stack}`);
  }
}

function rec(over) {
  return Object.assign({
    agent: 'claude-code', sessionId: 's', cwd: '/Users/me/projects/demo',
    tty: '/dev/ttys001', pid: 4242, state: 'running', lastEvent: 'UserPromptSubmit', ts: T0
  }, over);
}

/**
 * mock 宿主 SDK。
 *
 * scheduler.every 刻意做成 **async**（真宿主返回 Promise<taskId>，见 knowledge.md），
 * 且 cancel 只认自己发出去的那个 id —— 采集器若不 await 就把 Promise 当 id 存下，
 * cancel 会拿到个对象，这里当场记成 badCancel。这是宿主已知坑的探针。
 */
function mockPet(opts) {
  const o = opts || {};
  const state = {
    every: [],        // [{ ms, fn, id }]
    cancelled: [],    // 收到的 id
    badCancel: [],    // 不是我发出去的 id（Promise / undefined / 陈旧值）
    emitted: [],      // [{ name, data }]
    handlers: new Map(), // 事件名 → tool 注册的意图回调
    petCalls: []      // [['bubble', text] ...]
  };
  let seq = 0;
  const live = new Set();
  const pet = {
    scheduler: {
      async every(ms, fn) {
        if (o.everyThrows) throw new Error('宿主拒绝注册定时器');
        const id = `task-${++seq}`;
        state.every.push({ ms, fn, id });
        live.add(id);
        return id;
      },
      async cancel(id) {
        if (!live.has(id)) { state.badCancel.push(id); return false; }
        live.delete(id);
        state.cancelled.push(id);
        return true;
      }
    },
    events: {
      emit(name, data) {
        if (o.emitThrows) throw new Error('面板没开着');
        state.emitted.push({ name, data });
      },
      // panel 发来的意图（接入/移除钩子）挂在这里；测试用 state.handlers 从面板侧推
      on(name, fn) { state.handlers.set(name, fn); }
    },
    pet: {
      bubble: (text) => state.petCalls.push(['bubble', text]),
      playAnim: (name) => state.petCalls.push(['playAnim', name])
    }
  };
  // 每轮 tick 推的不止快照一条（还有接入态 agent-status:install-state），
  // 所以「这轮推了几次快照」必须按事件名筛，不能数 emitted 的长度。
  state.snapshots = () => state.emitted.filter((e) => e.name === tool.SNAPSHOT_EVENT);
  return { pet, state, liveCount: () => live.size };
}

// 采集器一律注入依赖，绝不落到真实目录/时钟/进程上
function collectorOn(dir, over) {
  return tool.createCollector(Object.assign({
    dir, now: () => T0, isPidAlive: () => true, t
  }, over));
}

(async function main() {
  // ---- 1. scheduler 契约（criteria §2 第一条 + 宿主已知坑）----

  await test('start 用 await 取 taskId 并存下（不是存 Promise）', async () => {
    const m = mockPet();
    const c = collectorOn(tmp());
    const returned = await c.start(m.pet);
    assert.strictEqual(m.state.every.length, 1, '应注册恰好一个定时任务');
    assert.strictEqual(m.state.every[0].ms, tool.TICK_MS);
    assert.strictEqual(tool.TICK_MS, 2000, 'criteria 指定 2000ms');
    assert.strictEqual(typeof c.taskId, 'string', '存的必须是 id 本身；存 Promise 会让 cancel 恒 miss');
    assert.ok(!(c.taskId instanceof Promise));
    assert.strictEqual(c.taskId, m.state.every[0].id);
    assert.strictEqual(returned, c.taskId);
  });

  await test('stop 用存下的 taskId 取消，宿主确实收到同一个 id', async () => {
    const m = mockPet();
    const c = collectorOn(tmp());
    const id = await c.start(m.pet);
    await c.stop(m.pet);
    assert.deepStrictEqual(m.state.cancelled, [id]);
    assert.deepStrictEqual(m.state.badCancel, [], 'cancel 收到过非法 id = 定时器泄漏');
    assert.strictEqual(m.liveCount(), 0, '宿主侧不该还留着活定时器');
    assert.strictEqual(c.taskId, null);
  });

  await test('重复 start 不重复注册（重复注册 = 泄漏定时器）', async () => {
    const m = mockPet();
    const c = collectorOn(tmp());
    const first = await c.start(m.pet);
    const second = await c.start(m.pet);
    assert.strictEqual(second, first);
    assert.strictEqual(m.state.every.length, 1);
    assert.strictEqual(m.liveCount(), 1);
  });

  await test('start→stop→start 可重新注册（stop 没把状态锁死）', async () => {
    const m = mockPet();
    const c = collectorOn(tmp());
    const a = await c.start(m.pet);
    await c.stop(m.pet);
    const b = await c.start(m.pet);
    assert.notStrictEqual(b, a);
    assert.strictEqual(m.state.every.length, 2);
    assert.deepStrictEqual(m.state.cancelled, [a]);
    assert.strictEqual(m.liveCount(), 1);
  });

  await test('没 start 过就 stop 不抛、也不乱 cancel', async () => {
    const m = mockPet();
    const c = collectorOn(tmp());
    await c.stop(m.pet);
    assert.deepStrictEqual(m.state.cancelled, []);
    assert.deepStrictEqual(m.state.badCancel, []);
  });

  await test('宿主 cancel 抛错时 stop 不抛，且不留假 taskId 挡住下次 start', async () => {
    const m = mockPet();
    const c = collectorOn(tmp());
    await c.start(m.pet);
    m.pet.scheduler.cancel = async () => { throw new Error('宿主已经收走了'); };
    await c.stop(m.pet);
    assert.strictEqual(c.taskId, null);
    m.pet.scheduler.cancel = async () => true;
    await c.start(m.pet);
    assert.strictEqual(m.state.every.length, 2, 'stop 失败后仍应能重新注册');
  });

  // ---- 2. tick：真实链路（落盘文件 → 快照事件 → 宠物联动）----

  await test('start 立刻跑一轮，不让用户等 2 秒', async () => {
    const dir = tmp();
    sf.writeStatus(rec({ sessionId: 'a', state: 'running', ts: T0 }), dir);
    const m = mockPet();
    const c = collectorOn(dir);
    await c.start(m.pet);
    assert.strictEqual(m.state.snapshots().length, 1, 'start 应主动 tick 一次');
    assert.strictEqual(m.state.snapshots()[0].name, tool.SNAPSHOT_EVENT);
    assert.strictEqual(m.state.snapshots()[0].name, 'agent-status:snapshot', '事件名带前缀防撞');
  });

  await test('宿主定时回调触发 tick：快照经 events 推给 panel，行结构齐全', async () => {
    const dir = tmp();
    sf.writeStatus(rec({ sessionId: 'a', cwd: '/Users/me/projects/alpha', ts: T0 }), dir);
    const m = mockPet();
    const c = collectorOn(dir);
    await c.start(m.pet);
    m.state.emitted.length = 0;
    m.state.every[0].fn();   // 宿主到点了这么调
    assert.strictEqual(m.state.snapshots().length, 1);
    const { name, data } = m.state.snapshots()[0];
    assert.strictEqual(name, 'agent-status:snapshot');
    assert.strictEqual(data.rows.length, 1);
    for (const key of ['agent', 'form', 'project', 'state', 'subline', 'timeText', 'sessionId']) {
      assert.ok(key in data.rows[0], `快照行缺字段 ${key}，panel 就得自己算业务字段`);
    }
    assert.strictEqual(data.rows[0].project, 'alpha');
    assert.strictEqual(data.rows[0].state, 'running');
    assert.deepStrictEqual(data.summary, { running: 1, waiting: 0, total: 1, unknown: 0, focus: { sessionId: 'a', state: 'running', project: 'alpha' } });
  });

  await test('全链路：hook 落盘 done → 下一轮 tick 宠物提醒', async () => {
    const dir = tmp();
    sf.writeStatus(rec({ sessionId: 'a', state: 'running', ts: T0 }), dir);
    const m = mockPet();
    let clock = T0;
    const c = collectorOn(dir, { now: () => clock });
    await c.start(m.pet);
    assert.deepStrictEqual(m.state.petCalls, [], 'running 不提醒');
    // hook 写 done，时钟往前 2 秒（一个 tick）
    sf.writeStatus(rec({ sessionId: 'a', state: 'done', lastEvent: 'Stop', ts: T0 + 1000 }), dir);
    clock = T0 + 2000;
    m.state.every[0].fn();
    assert.deepStrictEqual(m.state.petCalls, [
      ['playAnim', DONE_ANIM],
      ['bubble', t('bubble.done', { project: 'demo' })]
    ], '完成提醒是 DESIGN.md 的头号联动，必须在真实 tick 链路上跑通');
    // 光断言「playAnim 被调用了」不够：名字宿主不认的话，这次调用在真机上
    // 会被 renderer 静默丢弃。真实 tick 链路上再核一次参数。
    for (const [m0, arg] of m.state.petCalls.filter((c) => c[0] === 'playAnim')) {
      assert.ok(HOST_ANIM_STATES.includes(arg),
        `${m0}('${arg}') 不是宿主合法动作名，真机上不会播任何动画`);
    }
  });

  await test('同状态连续 tick 不重复提醒（2 秒一次气泡是灾难）', async () => {
    const dir = tmp();
    sf.writeStatus(rec({ sessionId: 'a', state: 'running', ts: T0 }), dir);
    const m = mockPet();
    let clock = T0;
    const c = collectorOn(dir, { now: () => clock });
    await c.start(m.pet);
    sf.writeStatus(rec({ sessionId: 'a', state: 'waiting', lastEvent: 'Notification', ts: T0 + 1000 }), dir);
    clock = T0 + 2000;
    m.state.every[0].fn();
    assert.strictEqual(m.state.petCalls.length, 1);
    for (let i = 2; i <= 20; i++) {
      clock = T0 + i * 2000;
      m.state.every[0].fn();
    }
    assert.strictEqual(m.state.petCalls.length, 1, '状态没变就不该再喊');
  });

  // ---- 3. 韧性：tick 绝不能把宿主定时任务打死 ----

  await test('读目录抛错时 tick 不抛，沿用上一轮快照（面板不闪空）', async () => {
    const dir = tmp();
    sf.writeStatus(rec({ sessionId: 'a', ts: T0 }), dir);
    let boom = false;
    const m = mockPet();
    const c = collectorOn(dir, {
      readSnapshots: (d) => {
        if (boom) throw new Error('磁盘炸了');
        return sf.readSnapshots(d);
      }
    });
    await c.start(m.pet);
    const good = c.lastSnapshot;
    assert.strictEqual(good.rows.length, 1);
    boom = true;
    let out;
    assert.doesNotThrow(() => { out = m.state.every[0].fn(); });
    assert.strictEqual(out.rows.length, 1, '读坏了就沿用上轮，不推空快照把面板刷没');
    assert.strictEqual(c.lastSnapshot, good);
  });

  await test('events.emit 抛错（面板没开）不打死 tick', async () => {
    const dir = tmp();
    sf.writeStatus(rec({ sessionId: 'a', ts: T0 }), dir);
    const m = mockPet({ emitThrows: true });
    const c = collectorOn(dir);
    await c.start(m.pet);
    assert.doesNotThrow(() => m.state.every[0].fn());
  });

  await test('状态目录不存在时 tick 不抛，推空快照', async () => {
    const m = mockPet();
    const c = collectorOn(path.join(tmp(), '根本不存在'));
    await c.start(m.pet);
    assert.deepStrictEqual(m.state.snapshots()[0].data.rows, []);
    assert.strictEqual(m.state.snapshots()[0].data.summary.total, 0);
  });

  await test('损坏文件不打死 tick，归 unknown 行且绝不当 done', async () => {
    const dir = tmp();
    sf.writeStatus(rec({ sessionId: 'a', ts: T0 }), dir);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ 截断的', 'utf8');
    const m = mockPet();
    const c = collectorOn(dir);
    await c.start(m.pet);
    const rows = m.state.snapshots()[0].data.rows;
    const bad = rows.find((r) => r.sessionId === 'broken');
    assert.ok(bad);
    assert.strictEqual(bad.state, 'unknown');
    assert.strictEqual(m.state.snapshots()[0].data.summary.unknown, 1);
    assert.deepStrictEqual(m.state.petCalls, [], 'unknown 绝不触发完成提醒');
  });

  // ---- 4. activate / deactivate（宿主真实入口）----

  await test('activate 注册定时器，deactivate 取消（宿主入口闭环）', async () => {
    const m = mockPet();
    const dir = tmp();
    const prev = process.env.PET_AGENT_STATUS_DIR;
    process.env.PET_AGENT_STATUS_DIR = dir;   // activate 不带参，走默认状态目录
    try {
      await tool.activate(m.pet);
      assert.strictEqual(m.state.every.length, 1);
      assert.strictEqual(m.state.every[0].ms, 2000);
      assert.strictEqual(m.liveCount(), 1);
      await tool.deactivate();   // 宿主多半不再传 pet，用 activate 时存的那个
      assert.strictEqual(m.state.cancelled.length, 1);
      assert.deepStrictEqual(m.state.badCancel, []);
      assert.strictEqual(m.liveCount(), 0, 'deactivate 后不该还留着活定时器');
    } finally {
      if (prev === undefined) delete process.env.PET_AGENT_STATUS_DIR;
      else process.env.PET_AGENT_STATUS_DIR = prev;
    }
  });

  await test('没 activate 就 deactivate 不抛', async () => {
    await tool.deactivate();
  });

  await test('导出面符合宿主插件契约（activate/deactivate 均为函数）', () => {
    assert.strictEqual(typeof tool.activate, 'function');
    assert.strictEqual(typeof tool.deactivate, 'function');
  });

  // ---- 5. 只用披露过的 SDK 面 ----

  // ---- 5.5 panel 的接入意图：tool 侧真接住并真改配置（US-004）----
  //
  // panel 的按钮只发意图。tool 这边没人接的话按钮就是死的（一点反应都没有），
  // 而且是**静默**死 —— 与 US-003 那次「动作名宿主不认」同型。这里从意图入口
  // 真跑到临时 settings.json 落盘。绝不碰真实 ~/.claude。

  function settingsIn(dir, initial) {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(initial || {}, null, 2));
    return file;
  }

  await test('panel 发接入意图 → tool 真写 settings.json 并回推接入态', async () => {
    const dir = tmp();
    const settingsFile = settingsIn(dir, { model: 'opus' });
    const m = mockPet();
    const c = collectorOn(dir, { settingsFile });
    await c.start(m.pet);

    assert.strictEqual(installer.isInstalled({ settingsFile }), false);
    // 首轮 tick 已经推过一次接入态（面板随开随关，每轮都要给）
    const before = m.state.emitted.filter((e) => e.name === tool.INSTALL_STATE_EVENT);
    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0].data.claude, false);

    const handler = m.state.handlers.get(tool.INSTALL_CLAUDE_EVENT);
    assert.ok(handler, 'tool 没订阅接入意图 —— 面板按钮会是死的');
    handler({});

    assert.strictEqual(installer.isInstalled({ settingsFile }), true,
      '收到意图但 settings.json 没被写 —— 意图没人真接');
    const after = m.state.emitted.filter((e) => e.name === tool.INSTALL_STATE_EVENT);
    assert.strictEqual(after[after.length - 1].data.claude, true, '接入后没回推新的接入态');
    // 用户原有配置原样保留（US-002 铁律）
    assert.strictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model, 'opus');
  });

  await test('panel 发移除意图 → tool 真摘除钩子并回推未接入', async () => {
    const dir = tmp();
    const settingsFile = settingsIn(dir, {});
    installer.install({ settingsFile });
    assert.strictEqual(installer.isInstalled({ settingsFile }), true);

    const m = mockPet();
    const c = collectorOn(dir, { settingsFile });
    await c.start(m.pet);
    const handler = m.state.handlers.get(tool.UNINSTALL_CLAUDE_EVENT);
    assert.ok(handler, 'tool 没订阅移除意图');
    handler({});

    assert.strictEqual(installer.isInstalled({ settingsFile }), false);
    const states = m.state.emitted.filter((e) => e.name === tool.INSTALL_STATE_EVENT);
    assert.strictEqual(states[states.length - 1].data.claude, false);
  });

  await test('settings.json 不可写时意图失败也不打死采集器', async () => {
    const dir = tmp();
    const m = mockPet();
    // 把「父目录」造成一个普通文件：mkdirSync 必抛 ENOTDIR，install 失败。
    // （单纯指一个不存在的目录不行 —— writeSettings 会 mkdir -p 出来，install 反而成功。）
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const c = collectorOn(dir, { settingsFile: path.join(blocker, 'settings.json') });
    await c.start(m.pet);
    m.state.handlers.get(tool.INSTALL_CLAUDE_EVENT)({});
    const states = m.state.emitted.filter((e) => e.name === tool.INSTALL_STATE_EVENT);
    assert.strictEqual(states[states.length - 1].data.claude, false);
    // 采集器还活着：定时回调照跑
    m.state.every[0].fn();
    assert.ok(m.state.snapshots().length >= 2, '意图失败后采集器不该停摆');
  });

  await test('采集器只碰 scheduler / events / pet 三个命名空间', async () => {
    const dir = tmp();
    sf.writeStatus(rec({ sessionId: 'a', state: 'running', ts: T0 }), dir);
    const touched = new Set();
    const m = mockPet();
    // 用 Proxy 记录被访问的命名空间：碰到 sdk-surface.js 没给 tool 的面就当场炸
    const spy = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined;
        touched.add(prop);
        return m.pet[prop];
      }
    });
    let clock = T0;
    const c = collectorOn(dir, { now: () => clock });
    await c.start(spy);
    sf.writeStatus(rec({ sessionId: 'a', state: 'done', lastEvent: 'Stop', ts: T0 + 1000 }), dir);
    clock = T0 + 2000;
    m.state.every[0].fn();
    await c.stop(spy);
    const allowed = new Set(['scheduler', 'events', 'pet']);
    for (const ns of touched) {
      assert.ok(allowed.has(ns), `碰了未披露的 SDK 面 pet.${ns}（AGENTS.md 插件形态红线）`);
    }
    assert.deepStrictEqual([...touched].sort(), ['events', 'pet', 'scheduler']);
  });

  // ---- 6. 隔离自证 ----

  await test('测试全程未触碰真实状态目录', () => {
    const real = path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
    assert.strictEqual(fs.existsSync(real), false, `真实状态目录不该存在：${real}`);
  });

  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });

  if (failures.length) {
    console.log(`\ntool-lifecycle-test: ${passed} passed, ${failures.length} FAILED`);
    process.exit(1);
  }
  console.log(`\ntool-lifecycle-test: ${passed} passed`);
})();
