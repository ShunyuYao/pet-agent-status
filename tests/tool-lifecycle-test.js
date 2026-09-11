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
    },
    storage: {
      async get(key) { return state.storage.get(key); },
      async set(key, value) { state.storage.set(key, value); }
    }
  };
  state.storage = new Map(Object.entries(o.storage || {}));
  // 每轮 tick 推的不止快照一条（还有接入态 agent-status:install-state），
  // 所以「这轮推了几次快照」必须按事件名筛，不能数 emitted 的长度。
  state.snapshots = () => state.emitted.filter((e) => e.name === tool.SNAPSHOT_EVENT);
  return { pet, state, liveCount: () => live.size };
}

// 假 IPC 工厂：记录启停，绝不碰真 socket（IPC 默认开，不注入的话
// 采集器会去连真实 ~/.codex/ipc/ipc.sock，退避重连的真 setTimeout 还会吊死测试进程）
function fakeIpcFactory() {
  const f = { instances: [] };
  f.factory = (deps) => {
    const inst = {
      deps, started: 0, stopped: 0, state: 'idle',
      start() { this.started++; this.state = 'ready'; },
      stop() { this.stopped++; this.state = 'idle'; },
      followingIds() { return []; },
      isFollowing() { return false; }
    };
    f.instances.push(inst);
    return inst;
  };
  return f;
}

// 采集器一律注入依赖，绝不落到真实目录/时钟/进程上
function collectorOn(dir, over) {
  return tool.createCollector(Object.assign({
    dir, now: () => T0, isPidAlive: () => true, t,
    createCodexIpc: fakeIpcFactory().factory,
    // 标题解析器必须注入：默认实现会读真实 ~/.codex 线程目录（隔离红线），
    // 且本套件的 App 行用的是实录 conversationId——在维护者机器上真能查到标题
    threadTitles: { lookup: () => null },
    terminalTitles: { lookup: () => null },   // 同理：默认实现 spawn osascript 查真实终端
    rolloutActivity: { activeThreads: () => new Map() }   // 同理：默认实现 stat 真实 ~/.codex/sessions
  }, over));
}

(async function main() {
  // ---- 1. scheduler 契约（criteria §2 第一条 + 宿主已知坑）----
// 隔离自证：测试**自己的数据**不得出现在真实路径里。
//
// ⚠️ 判据不能是「真实目录一个字节都没变」（2026-09-11 实测教训）：维护者自己也在用这个插件，
// 开发机上真实 agent 会话会持续写状态目录，mtime 快照必然变化 —— 那个守卫在开发机上随机变红，
// 且红了也说明不了问题。真正要防的是**测试数据泄漏进真实目录**，所以改为按测试专属前缀检查。
// 所有测试造的 sessionId 一律带 TEST_ID_PREFIX，泄漏时一抓一个准。
const TEST_ID_PREFIX = 'pet-as-test-';
function realStateDir() {
  return path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
}
function leakedTestFiles() {
  const dir = realStateDir();
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter((n) => n.includes(TEST_ID_PREFIX));
}
function leakedBackups() {
  return [
    path.join(os.homedir(), '.claude', 'settings.json.bak-pet-agent-status-TEST'),
    path.join(os.homedir(), '.codex', 'hooks.json.bak-pet-agent-status-TEST'),
  ].filter((p) => fs.existsSync(p));
}


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
    assert.deepStrictEqual(data.summary, { running: 1, waiting: 0, done: 0, total: 1, unknown: 0, focus: { sessionId: 'a', state: 'running', project: 'alpha' } });
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
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.PET_AGENT_STATUS_DIR = dir;   // activate 不带参，走默认状态目录
    // IPC 默认开：activate 无依赖注入，把 socket 路径也指进临时目录（不存在 → 只是连不上，
    // 绝不触真实 ~/.codex；deactivate 会停掉适配器清干净重连定时器）
    process.env.CODEX_HOME = dir;
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
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
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
    // badge 自 0.3.0 起使用（宿主 0.19.0 的 pet.badge.*，experimental 档）。
    // 这份白名单是 AGENTS.md 插件形态红线的守卫：新增 SDK 面必须**同时**更新它与 README
    // 的能力披露，不许靠放宽断言蒙混——它刚刚真的拦下了一次未登记的新面。
    // storage 自 0.5.0 起使用（codexIpcEnabled 开关的唯一真相源；0.4.x 的 settings 面已弃用——
    // manifest 设置项只有宿主设置页能写、panel 写不了，两处开关必漂）。
    const allowed = new Set(['scheduler', 'events', 'pet', 'badge', 'storage']);
    for (const ns of touched) {
      assert.ok(allowed.has(ns), `碰了未披露的 SDK 面 pet.${ns}（AGENTS.md 插件形态红线）`);
    }
    // 宿主不支持 badge 时（mock 没造 badge）不会被 touched 记到，故只断言下界
    for (const must of ['events', 'pet', 'scheduler']) {
      assert.ok(touched.has(must), `采集器应当使用 pet.${must}`);
    }
  });

  // ---- 5.6 Codex App IPC 增强：默认开 + 设置切换（US-8 设置面板）----

  await test('IPC 默认开：storage 没存过值时 start 即连（假工厂）', async () => {
    const f = fakeIpcFactory();
    const m = mockPet();   // storage 为空 = 用户从没动过开关
    const c = collectorOn(tmp(), { createCodexIpc: f.factory });
    await c.start(m.pet);
    assert.strictEqual(f.instances.length, 1, '默认应创建 IPC 适配器');
    assert.strictEqual(f.instances[0].started, 1);
    assert.strictEqual(c.ipcEnabled, true);
    // 设置态事件也要推（panel 的设置视图靠它翻面）
    const st = m.state.emitted.filter((e) => e.name === tool.SETTINGS_STATE_EVENT);
    assert.ok(st.length >= 1, '没推 settings-state，设置视图永远空白');
    assert.strictEqual(st[st.length - 1].data.codexIpcEnabled, true);
    await c.stop(m.pet);
    assert.strictEqual(f.instances[0].stopped, 1, 'stop 后 IPC 该断开');
  });

  await test('storage 存过 false → 不连；panel 发开启意图 → 真连 + 落 storage + 回推', async () => {
    const f = fakeIpcFactory();
    const m = mockPet({ storage: { [tool.IPC_ENABLED_KEY]: false } });
    const c = collectorOn(tmp(), { createCodexIpc: f.factory });
    await c.start(m.pet);
    assert.strictEqual(f.instances.length, 0, '显式关着就不该连');
    assert.strictEqual(c.ipcEnabled, false);
    // panel 设置视图拨开开关（真实用户动作等价物 = set-setting 意图事件）
    const handler = m.state.handlers.get(tool.SET_SETTING_EVENT);
    assert.ok(handler, 'tool 没订阅 set-setting —— 设置开关是死的');
    handler({ key: tool.IPC_ENABLED_KEY, value: true });
    await new Promise((r) => setImmediate(r));   // handleSetSetting 是 async
    assert.strictEqual(f.instances.length, 1, '开启意图没让 IPC 连上');
    assert.strictEqual(m.state.storage.get(tool.IPC_ENABLED_KEY), true, '开关值没落 storage');
    const st = m.state.emitted.filter((e) => e.name === tool.SETTINGS_STATE_EVENT);
    assert.strictEqual(st[st.length - 1].data.codexIpcEnabled, true);
    // 再关回去
    handler({ key: tool.IPC_ENABLED_KEY, value: false });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(f.instances[0].stopped, 1, '关闭意图没断开 IPC');
    assert.strictEqual(m.state.storage.get(tool.IPC_ENABLED_KEY), false);
    await c.stop(m.pet);
  });

  await test('IPC 摄入回调接到状态目录：activity 帧等价调用 → 下一轮 tick 出 App 行', async () => {
    const dir = tmp();
    const f = fakeIpcFactory();
    const m = mockPet();
    const c = collectorOn(dir, { createCodexIpc: f.factory });
    await c.start(m.pet);
    const cid = '01a08a1d-4f63-7e30-af03-48ae77b414b5';
    // 适配器解出 activity 后就调这个回调（帧→回调链路由 codex-ipc-test/ingest-test 各自守）
    f.instances[0].deps.onActivity(cid);
    m.state.emitted.length = 0;
    m.state.every[0].fn();
    const rows = m.state.snapshots()[0].data.rows;
    const app = rows.find((r) => r.sessionId === cid);
    assert.ok(app, 'App 任务没进快照');
    assert.strictEqual(app.form, 'app');
    assert.strictEqual(app.state, 'running');
    await c.stop(m.pet);
  });

  // ---- 5.7 rollout 活动接线（2026-09-11 修「运行中看不到 App 任务」，facts §10）----
  // 走真实 stat 链路：临时 codexHome 里造 rollout 文件（用户在 App 提交任务后系统的
  // 真实产物等价物）→ tick → 快照出 running 行；再验「提交时刻已读帧」的豁免接线。
  await test('rollout 文件新鲜 → tick 出 running App 行；已读帧在活动中不翻 ended', async () => {
    const dir = tmp();
    const home = tmp();
    const cid = '01a090b0-117a-77b1-9e02-2ccfef2171c2';
    let clock = T0;
    // 造 rollout 文件（今天的日期目录按注入时钟算）
    const dday = new Date(T0);
    const dayDir = path.join(home, 'sessions', String(dday.getFullYear()),
      String(dday.getMonth() + 1).padStart(2, '0'), String(dday.getDate()).padStart(2, '0'));
    fs.mkdirSync(dayDir, { recursive: true });
    const rollout = path.join(dayDir, `rollout-2026-09-11T21-37-33-${cid}.jsonl`);
    fs.writeFileSync(rollout, '');
    fs.utimesSync(rollout, (T0 - 3000) / 1000, (T0 - 3000) / 1000);
    // 上一回合留下的摄入系记录（实测线上形态：ended / ipc:turn-read）= 归属证据
    sf.writeStatus({ agent: 'codex', form: 'app', sessionId: cid, threadId: cid, cwd: '',
      project: 'Codex App', tty: null, pid: null, state: 'ended', lastEvent: 'ipc:turn-read',
      source: 'ipc', ts: T0 - 60000 }, dir);
    const f = fakeIpcFactory();
    const { createRolloutActivity } = require(path.join(ROOT, 'lib', 'codex-rollout-activity.js'));
    const m = mockPet();
    const c = collectorOn(dir, {
      now: () => clock, createCodexIpc: f.factory,
      rolloutActivity: createRolloutActivity({ codexHome: home, now: () => clock })
    });
    await c.start(m.pet);
    const rows = m.state.snapshots().pop().data.rows;
    const app = rows.find((r) => r.sessionId === cid);
    assert.ok(app, 'rollout 活动没让 App 行出现');
    assert.strictEqual(app.state, 'running', '运行中必须显示 running（本缺陷的核心断言）');
    assert.strictEqual(app.form, 'app');
    // 提交时刻 App 发已读帧（facts §10.1 实录）：活动中不许翻 ended
    f.instances[0].deps.onReadState(cid, false);
    assert.strictEqual(sf.readStatus(cid, dir).state, 'running', '已读帧把开跑的任务翻成 ended 了');
    // 活动停止（时钟越过 30s 窗）后 tick 一轮清活动集，已读帧才照常收尾
    clock = T0 + 60000;
    c.tick(m.pet);
    f.instances[0].deps.onReadState(cid, false);
    assert.strictEqual(sf.readStatus(cid, dir).state, 'ended', '活动停了，已读该照常转 ended');
    await c.stop(m.pet);
  });

  await test('US-9 标题接线与优先级：codex 线程库 > 终端标签 > 落盘兜底', async () => {
    const dir = tmp();
    const m = mockPet();
    const asked = [];
    const TID = '01a08a1d-4f63-7e30-af03-48ae77b414b5';
    const c = collectorOn(dir, {
      threadTitles: { lookup: (id) => { asked.push(id); return id === TID ? '查找 Codex 宠物多会话管理' : null; } },
      // 终端标签标题（facts：iTerm/Terminal 按 tty 查回），三行 tty 各有归属
      terminalTitles: { lookup: (tty) => ({ '/dev/ttys017': '终端里的 AI 标题', '/dev/ttys022': '终端兜底名' }[tty] || null) }
    });
    // codex 行：线程库命中 → 终端标签（ttys022 也有）必须让位
    sf.writeStatus(rec({ sessionId: TID, agent: 'codex', threadId: TID, tty: '/dev/ttys022', title: '兜底名', ts: T0 }), dir);
    // claude 行：磁盘上没有 AI 标题，终端标签就是用户看到的那个名字，压过落盘首条 prompt
    sf.writeStatus(rec({ sessionId: 'cc', agent: 'claude-code', tty: '/dev/ttys017', title: '首条 prompt 名', ts: T0 }), dir);
    // claude 行无 tty：只能用落盘兜底
    sf.writeStatus(rec({ sessionId: 'cc2', agent: 'claude-code', tty: null, title: '无终端兜底', ts: T0 }), dir);
    await c.start(m.pet);
    const rows = m.state.snapshots()[0].data.rows;
    const by = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
    assert.strictEqual(by[TID].title, '查找 Codex 宠物多会话管理', '线程库标题必须压过终端标签');
    assert.strictEqual(by.cc.title, '终端里的 AI 标题', 'claude 行应显示终端标签标题');
    assert.strictEqual(by.cc2.title, '无终端兜底', '无 tty 行回落落盘标题');
    assert.ok(!asked.some((id) => id == null), '无 threadId 的行不该问线程库解析器');
    await c.stop(m.pet);
  });

  // ---- 6. 隔离自证 ----

  await test('测试全程未触碰真实状态目录', () => {
    const real = path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
  assert.deepStrictEqual(leakedTestFiles(), [], '测试数据泄漏进了真实状态目录');
  assert.deepStrictEqual(leakedBackups(), [], '测试在真实配置旁留下了备份文件');
  });

  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });

  if (failures.length) {
    console.log(`\ntool-lifecycle-test: ${passed} passed, ${failures.length} FAILED`);
    process.exit(1);
  }
  console.log(`\ntool-lifecycle-test: ${passed} passed`);

  // ---- 点完就收起（dismiss）的 tool 层闭环（2026-09-11 用户需求）----
  // aggregate 单测只证明「给了 dismissedAt 就会过滤」；这里证明**点击真的会去记那一笔**，
  // 且记完立刻反映到推给面板的下一份快照里（少了这段，两边各自绿、功能仍是断的）。
  await test('跳转成功后，已结束的行从下一份快照里消失', async () => {
    const dir = tmp();
    const T = Date.now();
    sf.writeStatus(rec({ sessionId: 'jd', state: 'done', lastEvent: 'Stop', ts: T - 5000, tty: '/dev/ttys9' }), dir);
    const m = mockPet();
    const c = collectorOn(dir, {
      now: () => T,
      jumpRunner: () => ({ ok: true }),
      // 让终端归属判得出来，否则 runJump 返回 unavailable，压根走不到成功分支
      psTree: () => [{ pid: 1, ppid: 0, comm: '/A/iTerm.app/Contents/MacOS/iTerm2', tty: 'ttys9' }],
    });
    c.tick(m.pet);
    const before = m.state.snapshots().pop().data.rows;
    assert.strictEqual(before.length, 1, '前置：应有一条 done 行');

    const res = c.handleJump(m.pet, { sessionId: 'jd' });
    assert.strictEqual(res.ok, true, `跳转应成功，实际 ${JSON.stringify(res)}`);
    const after = m.state.snapshots().pop().data.rows;
    assert.strictEqual(after.length, 0, '点完后该行应从快照里消失');
  });

  await test('跳转失败时不收起（没跳成功就藏起来，用户会找不到会话）', async () => {
    const dir = tmp();
    const T = Date.now();
    sf.writeStatus(rec({ sessionId: 'jf', state: 'done', lastEvent: 'Stop', ts: T - 5000, tty: '/dev/ttys9' }), dir);
    const m = mockPet();
    const c = collectorOn(dir, {
      now: () => T,
      jumpRunner: () => ({ ok: false, reason: 'osascript boom' }),
      psTree: () => [{ pid: 1, ppid: 0, comm: '/A/iTerm.app/Contents/MacOS/iTerm2', tty: 'ttys9' }],
    });
    c.tick(m.pet);
    c.handleJump(m.pet, { sessionId: 'jf' });
    const after = m.state.snapshots().pop().data.rows;
    assert.strictEqual(after.length, 1, '跳转失败必须留着这一行');
    assert.ok(after[0].jumpError, '并且要显示行内错误');
  });

  // ---- 「可能已中断」点一下让它消失（2026-09-11 用户需求二）----
  // error 行常见形态是终端窗口也早关了：跳转判定 unavailable。「跳转失败不收起」原则
  // 保护的是「用户还找得到的会话」；unavailable 意味着压根没有可去之处，点击的目的
  // 就是清掉这行——此时收起，且不留一条挂在已消失行下的错误条。
  await test('可能已中断 + 找不到终端：点击即收起、不留错误条', async () => {
    const dir = tmp();
    const T = Date.now();
    // running 落盘 + 90s 无心跳 + 进程已死 → error；psTree 里没有这个 tty → unavailable
    sf.writeStatus(rec({ sessionId: 'ed', state: 'running', ts: T - 90 * 1000, tty: '/dev/ttys9' }), dir);
    const m = mockPet();
    const c = collectorOn(dir, { now: () => T, isPidAlive: () => false, psTree: () => [] });
    c.tick(m.pet);
    const before = m.state.snapshots().pop().data.rows;
    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0].state, 'error', '前置：应是 error 态');

    const res = c.handleJump(m.pet, { sessionId: 'ed' });
    assert.strictEqual(res.ok, false, '跳转本身仍如实报告失败');
    const after = m.state.snapshots().pop().data.rows;
    assert.strictEqual(after.length, 0, 'error + unavailable 点击后应收起');
  });

  await test('可能已中断但终端还在：跳转成功照样收起（error 已属可收起态）', async () => {
    const dir = tmp();
    const T = Date.now();
    sf.writeStatus(rec({ sessionId: 'ej', state: 'running', ts: T - 90 * 1000, tty: '/dev/ttys9' }), dir);
    const m = mockPet();
    const c = collectorOn(dir, {
      now: () => T, isPidAlive: () => false,
      jumpRunner: () => ({ ok: true }),
      psTree: () => [{ pid: 1, ppid: 0, comm: '/A/iTerm.app/Contents/MacOS/iTerm2', tty: 'ttys9' }],
    });
    c.tick(m.pet);
    assert.strictEqual(m.state.snapshots().pop().data.rows[0].state, 'error');
    const res = c.handleJump(m.pet, { sessionId: 'ej' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(m.state.snapshots().pop().data.rows.length, 0, '跳转成功后收起');
  });

  await test('运行中 + 找不到终端：不收起（unavailable 收起只对可收起态生效）', async () => {
    const dir = tmp();
    const T = Date.now();
    sf.writeStatus(rec({ sessionId: 'ru', state: 'running', ts: T - 5000, tty: '/dev/ttys9' }), dir);
    const m = mockPet();
    const c = collectorOn(dir, { now: () => T, psTree: () => [] });
    c.tick(m.pet);
    c.handleJump(m.pet, { sessionId: 'ru' });
    const after = m.state.snapshots().pop().data.rows;
    assert.strictEqual(after.length, 1, 'running 行无论跳转结果如何都不许收起');
  });
})();
