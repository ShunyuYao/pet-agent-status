'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createCollector, SNAPSHOT_EVENT, APPS_EVENT } = require('../tool');
const { createCodexIpc, encodeFrame } = require('../lib/codex-ipc');
const { createAppLauncher } = require('../lib/app-launcher');
const sf = require('../lib/state-files');
const { createData, childSource, PARENT, CHILD, GUARDIAN, TURN, NEXT } = require('./fixtures/codex-subagent-data');

async function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-codex-subagent-'));
  const home = path.join(root, 'codex'), dir = path.join(root, 'state'), data = createData(home);
  let at = Date.now(), enabled = true, socket, scheduled, collector, snapshot, apps, badge;
  const bubbles = [];
  const pet = {
    events: { on() {}, emit(name, value) { if (name === SNAPSHOT_EVENT) snapshot = value; if (name === APPS_EVENT) apps = value.apps; } },
    storage: { async get(key) { return key === 'codexIpcEnabled' ? enabled : undefined; } },
    scheduler: { async every(ms, fn) { scheduled = fn; return 'timer'; }, async cancel() {} },
    badge: { async set(value) { badge = value; return true; }, async clear() {} },
    pet: { bubble: text => bubbles.push(text), playAnim() {} }
  };
  const boot = async () => {
    collector = createCollector({ dir, codexHome: home, now: () => at, locale: 'zh-CN',
      settingsFile: path.join(root, 'claude.json'), codexHooksFile: path.join(root, 'hooks.json'),
      threadTitles: { lookup: () => null }, terminalTitles: { lookup: () => null },
      claudeDesktop: { has: () => false, lookupTitle: () => null }, workbuddySource: { tick() {} },
      createAppLauncher: () => createAppLauncher({ probe: id => id === 'com.openai.codex' ? '/fixture/Codex.app' : null, execFile() {} }),
      createCodexIpc: deps => createCodexIpc({ ...deps, connect() { socket = new EventEmitter(); socket.write = () => true; socket.destroy = () => {}; return socket; }, setTimer: () => 1, clearTimer() {} })
    });
    await collector.start(pet);
  };
  const feed = (id, method, params) => socket.emit('data', encodeFrame({ type: 'broadcast', method, params: { conversationId: id, ...params } }));
  await boot();
  return { home, dir, data, bubbles, now: () => at, advance: ms => { at += ms; }, feed,
    follow: id => feed(id, 'thread-stream-following-changed', { following: true }),
    done: id => feed(id, 'thread-read-state-changed', { hasUnreadTurn: true }),
    tick: () => { scheduled(); return snapshot; }, read: id => sf.readStatus(id, dir),
    seed(id, state = 'done', extra = {}) { sf.writeStatus({ agent: 'codex', form: 'app', source: 'ipc', sessionId: id, threadId: id, cwd: '', project: 'Codex App', tty: null, pid: null, state, ts: at, lastEvent: 'ipc:turn-unread', turnId: TURN, ...extra }, dir); },
    output: () => ({ snapshot, apps, badge }),
    restart: async (on = enabled) => { await collector.stop(pet); enabled = on; await boot(); },
    close: async () => { await collector.stop(pet); data.close(); fs.rmSync(root, { recursive: true, force: true }); }
  };
}
(async () => {
  let passed = 0;
  async function test(name, fn) { const r = await rig(); try { await fn(r); passed++; console.log('  ok', name); } finally { await r.close(); } }
  await test('父任务完整链路可达；子 Agent 的所有 IPC/rollout 入口都不落盘、不计数', async r => {
    r.data.thread(PARENT); r.data.thread(CHILD, childSource(), 'subagent');
    for (const id of [PARENT, CHILD]) { r.data.rollout(id, r.now()); r.data.turn(id, 'inProgress', r.now()); r.follow(id); }
    assert.equal(r.tick().rows.find(row => row.sessionId === PARENT)?.state, 'running', 'positive control: parent reaches snapshot');
    r.feed(CHILD, 'thread-queued-followups-changed', { messages: [] });
    r.done(CHILD); r.feed(CHILD, 'thread-read-state-changed', { hasUnreadTurn: false });
    assert.equal(r.read(CHILD), null, 'child must never be written');
    const snap = r.tick(); assert.deepEqual(snap.rows.map(row => row.sessionId), [PARENT]);
    assert.equal(snap.summary.running, 1); assert.equal(snap.summary.done, 0); assert.equal(snap.summary.focus.sessionId, PARENT);
    assert.equal(r.output().apps[0].pendingDone, 0); assert.deepEqual(r.output().badge.segments, [{tone:'primary',text:'1'}]);
    assert.equal(r.bubbles.length, 0);
    r.done(PARENT); assert.equal(r.tick().summary.done, 1);
    assert.equal(r.output().apps[0].pendingDone, 1); assert.equal(r.bubbles.length, 1, 'positive control: parent completion still notifies');
  });
  await test('历史子 Agent 在重启与关闭 IPC 后仍排除，状态文件保持原样', async r => {
    r.data.thread(PARENT); r.data.thread(CHILD, childSource(), 'subagent');
    r.seed(PARENT); r.seed(CHILD); const before = fs.readFileSync(path.join(r.dir, CHILD + '.json'), 'utf8');
    for (const enabled of [true, false, true]) {
      await r.restart(enabled); assert.deepEqual(r.tick().rows.map(row => row.sessionId), [PARENT]);
      assert.equal(r.tick().summary.done, 1); assert.equal(r.output().apps[0].pendingDone, 1);
    }
    assert.equal(fs.readFileSync(path.join(r.dir, CHILD + '.json'), 'utf8'), before);
  });
  await test('旧子 Agent 新回合/following 不能复活；hook 记录不受 App 过滤影响', async r => {
    r.data.thread(CHILD, childSource()); r.seed(CHILD); const before = r.read(CHILD);
    r.advance(5000); r.data.turn(CHILD, 'inProgress', r.now(), NEXT, 2); r.data.rollout(CHILD, r.now()); r.follow(CHILD);
    assert.equal(r.tick().rows.length, 0); assert.deepEqual(r.read(CHILD), before);
    r.seed(CHILD, 'waiting', {source:'hook',form:'cli',tty:'/dev/ttys901',pid:process.pid});
    r.done(CHILD); assert.equal(r.tick().rows[0].state, 'waiting'); assert.equal(r.read(CHILD).source, 'hook');
  });
  await test('只认明确子 Agent 证据：source 各形态、thread_source 与 spawn edge；不猜标题/fork/未知值', async r => {
    const sources = [childSource(), JSON.stringify({subagent:'review'}), JSON.stringify({subagent:'compact'}), JSON.stringify({subagent:{other:'guardian'}})];
    let n = 400;
    for (const source of sources) { const id = `00000000-0000-4000-8000-${String(n++).padStart(12,'0')}`; r.data.thread(id, source, null); r.done(id); assert.equal(r.read(id), null, source); }
    r.data.thread(CHILD, null, 'subagent'); r.done(CHILD); assert.equal(r.read(CHILD), null);
    r.data.thread(GUARDIAN, null, 'guardian_review'); r.done(GUARDIAN); assert.equal(r.read(GUARDIAN), null);
    const edgeId = '00000000-0000-4000-8000-000000000990'; r.data.thread(edgeId, null, null); r.data.edge(edgeId); r.done(edgeId); assert.equal(r.read(edgeId), null);
    for (const source of ['vscode', 'cli', 'exec', 'unknown', '{broken', '{"forked_from_id":"'+PARENT+'"}', '{"subagent":null}']) {
      const id = `00000000-0000-4000-8000-${String(n++).padStart(12,'0')}`; r.data.thread(id, source, null); r.done(id); assert.equal(r.read(id).state, 'done', source);
    }
    r.data.thread(PARENT, 'vscode'); r.data.edge(PARENT, 'bad-parent'); r.done(PARENT); assert.equal(r.read(PARENT).state, 'done');
  });
  await test('元数据晚到后自动排除；确认过的身份在读取失败时保持，未知结果持续重试', async r => {
    r.done(CHILD); assert.equal(r.tick().rows.length, 1, 'missing metadata fails open');
    r.data.thread(CHILD, childSource()); assert.equal(r.tick().rows.length, 0, 'late metadata removes existing row');
    const db = path.join(r.home, 'state_5.sqlite'); fs.renameSync(db, db + '.away');
    const before = r.read(CHILD); r.advance(2000); r.done(CHILD);
    assert.deepEqual(r.read(CHILD), before); assert.equal(r.tick().rows.length, 0, 'cached child does not reappear');
    r.done(PARENT); assert.equal(r.tick().rows.length, 1, 'unclassified parent survives database failure');
    fs.renameSync(db + '.away', db); r.data.thread(PARENT); assert.equal(r.tick().summary.done, 1);
  });
  await test('旧库缺身份列/关系表仍可读取回合与路径；单个身份来源缺失不废掉其他证据', async r => {
    r.data.db.exec('ALTER TABLE threads DROP COLUMN thread_source; DROP TABLE thread_spawn_edges');
    r.data.db.prepare('INSERT INTO threads(id,source) VALUES (?,?)').run(CHILD, childSource());
    r.done(CHILD); assert.equal(r.read(CHILD), null);
    r.data.db.exec('ALTER TABLE threads DROP COLUMN source');
    r.data.db.prepare('INSERT INTO threads(id) VALUES (?)').run(PARENT);
    r.data.rollout(PARENT, r.now()); r.data.turn(PARENT, 'inProgress', r.now()); r.follow(PARENT);
    assert.equal(r.tick().rows.find(row => row.sessionId === PARENT)?.state, 'running');
  });
  console.log(`codex-subagent-test: ${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
