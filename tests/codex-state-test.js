'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createCollector, SNAPSHOT_EVENT } = require('../tool');
const { createCodexIpc, encodeFrame } = require('../lib/codex-ipc');
const sf = require('../lib/state-files');
const { createData, CID, TURN1, TURN2 } = require('./fixtures/codex-state-data');
const T0 = new Date(2026, 8, 12, 12).getTime();
async function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-codex-state-'));
  const home = path.join(root, 'codex'), dir = path.join(root, 'state');
  const data = createData(home); let at = T0, scheduled, socket, collector;
  const snapshots = [], bubbles = [];
  const pet = {
    events: { on() {}, emit(name, value) { if (name === SNAPSHOT_EVENT) snapshots.push(value); } },
    storage: { async get() { return true; } },
    scheduler: { async every(ms, fn) { scheduled = fn; return 'timer'; }, async cancel() {} },
    pet: { bubble: text => bubbles.push(text), playAnim() {} }
  };
  const boot = async () => {
    collector = createCollector({
      dir, codexHome: home, now: () => at,
      settingsFile: path.join(root, 'claude.json'), codexHooksFile: path.join(root, 'hooks.json'),
      threadTitles: { lookup: () => null }, terminalTitles: { lookup: () => null },
      claudeDesktop: { has: () => false, lookupTitle: () => null }, workbuddySource: { tick() {} },
      createAppLauncher: () => ({ detect: () => [], open() {} }),
      createCodexIpc: deps => createCodexIpc({ ...deps, connect() { socket = new EventEmitter(); socket.write = () => true; socket.destroy = () => {}; return socket; }, setTimer: () => 1, clearTimer() {} })
    });
    await collector.start(pet);
    socket.emit('data', encodeFrame({ type: 'response', method: 'initialize' }));
    feed('thread-stream-following-changed', { following: true });
  };
  const feed = (method, params) => socket.emit('data', encodeFrame({ type: 'broadcast', method, params: { conversationId: CID, ...params } }));
  const tick = () => { scheduled(); return snapshots.at(-1).rows.find(r => r.sessionId === CID); };
  await boot();
  return { root, home, dir, data, feed, tick, bubbles, read: () => sf.readStatus(CID, dir), setTime: t => { at = t; },
    restart: async () => { await collector.stop(pet); await boot(); },
    close: async () => { await collector.stop(pet); data.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
(async () => {
  let passed = 0;
  async function test(name, fn) { const r = await rig(); try { await fn(r); passed++; console.log('  ok', name); } finally { await r.close(); } }
  await test('完成事件后旧活动不得覆盖 done，重启和收尾追加也不得复活', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0);
    assert.equal(r.tick().state, 'running', 'positive control: real file reaches snapshot');
    r.setTime(T0 + 2000); r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    assert.equal(r.read().state, 'done', 'positive control: IPC reaches state file');
    assert.equal(r.tick().state, 'done', 'completion must survive next scheduled poll');
    assert.equal(r.bubbles.length, 1, 'completion reaches pet notification');
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 2000);
    r.setTime(T0 + 4000); r.data.append(T0 + 4000);
    assert.equal(r.tick().state, 'done', 'final log flush is same completed turn');
    await r.restart(); assert.equal(r.tick().state, 'done', 'restart retains completion barrier');
    r.feed('thread-read-state-changed', { hasUnreadTurn: false }); assert.equal(r.read().state, 'ended');
    assert.equal(r.tick().state, 'done', 'reading result does not revive task');
    assert.equal(r.bubbles.length, 1, 'no duplicate completion notifications');
  });
  await test('旧任务的新回合可以重新运行，心跳计时连续', async r => {
    r.data.rollout(T0, 4); r.data.turn(TURN1, 'inProgress', T0);
    assert.equal(r.tick().state, 'running', 'older directory is tracked by exact path');
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); assert.equal(r.tick().state, 'done');
    r.setTime(T0 + 5000); r.data.turn(TURN2, 'inProgress', T0 + 5000, 50); r.data.append(T0 + 5000);
    assert.equal(r.tick().state, 'running'); const since = r.read().since;
    r.feed('thread-read-state-changed', { hasUnreadTurn: false }); assert.equal(r.read().state, 'running');
    r.setTime(T0 + 27000); r.data.append(T0 + 27000); assert.equal(r.tick().state, 'running');
    assert.equal(r.read().since, since); assert.equal(r.read().turnId, TURN2);
  });
  await test('数据库不可用时不能凭收尾写入覆盖完成，恢复后识别新回合', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); r.tick();
    const db = path.join(r.home, 'thread_history_1.sqlite'); fs.renameSync(db, db + '.away');
    r.setTime(T0 + 6000); r.data.append(T0 + 6000); assert.equal(r.tick().state, 'done');
    fs.renameSync(db + '.away', db); r.data.turn(TURN2, 'inProgress', T0 + 6000, 50);
    assert.equal(r.tick().state, 'running');
  });
  await test('hook 记录不被 App 采集覆盖', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0);
    sf.writeStatus({ agent: 'codex', sessionId: CID, threadId: CID, cwd: '/fixture', tty: '/dev/ttys901', pid: process.pid, source: 'hook', state: 'waiting', lastEvent: 'PermissionRequest', ts: T0 }, r.dir);
    r.tick(); r.feed('thread-read-state-changed', { hasUnreadTurn: true }); assert.equal(r.read().state, 'waiting'); assert.equal(r.read().source, 'hook');
  });
  await test('已读先于下一轮扫描到达时，不得把新回合锁成结束', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); r.tick();
    r.setTime(T0 + 1000); r.data.turn(TURN2, 'inProgress', T0 + 1000, 50); r.data.append(T0 + 1000);
    r.feed('thread-read-state-changed', { hasUnreadTurn: false });
    assert.equal(r.tick().state, 'running'); assert.equal(r.read().turnId, TURN2);
  });
  await test('完成后数据库仍滞留同一 inProgress 回合，重启也不能复活', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    await r.restart(); r.setTime(T0 + 3000); r.data.append(T0 + 3000);
    assert.equal(r.tick().state, 'done');
  });
  await test('schema:1 终态可兼容读取，明确的新回合才升级运行', async r => {
    fs.mkdirSync(r.dir, { recursive: true });
    fs.writeFileSync(path.join(r.dir, CID + '.json'), JSON.stringify({schema:1, agent:'codex', form:'app', sessionId:CID, threadId:CID, source:'ipc', state:'done', cwd:'', project:'Codex App', tty:null, pid:null, lastEvent:'ipc:turn-unread', ts:T0-60000}));
    r.data.rollout(T0, 4); r.data.turn(TURN1, 'completed', T0 - 120000, 1, T0 - 60000);
    assert.equal(r.tick().state, 'done'); assert.equal(r.read().schema, 1);
    r.data.turn(TURN2, 'inProgress', T0, 50); assert.equal(r.tick().state, 'running');
    assert.equal(r.read().schema, 2); assert.equal(r.read().turnId, TURN2);
  });
  await test('未知回合状态不能恢复完成或让运行中的已读误报结束', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.data.turn(TURN1, 'future-state', T0);
    r.feed('thread-read-state-changed', {hasUnreadTurn:false}); assert.equal(r.read().state, 'running');
    r.feed('thread-read-state-changed', {hasUnreadTurn:true});
    r.data.turn(TURN2, 'future-state', T0 + 1000, 50); r.data.append(T0 + 1000);
    assert.equal(r.tick().state, 'done');
  });
  await test('同回合完成后的队列清理广播不能覆盖完成', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.feed('thread-read-state-changed', {hasUnreadTurn:true});
    r.feed('thread-queued-followups-changed', {messages:[]}); assert.equal(r.tick().state, 'done');
  });
  await test('数据库路径越界或符号链接逃逸时，不采集外部文件', async r => {
    const { DatabaseSync } = require('node:sqlite');
    const file = r.data.rollout(T0, 4); r.data.turn(TURN1, 'inProgress', T0);
    const outside = path.join(r.root, path.basename(file)); fs.renameSync(file, outside);
    const db = new DatabaseSync(path.join(r.home, 'state_5.sqlite'));
    db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(outside, CID);
    assert.equal(r.tick(), undefined);
    db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file, CID); db.close();
    fs.symlinkSync(outside, file); assert.equal(r.tick(), undefined);
    fs.unlinkSync(file); fs.renameSync(outside, file); assert.equal(r.tick().state, 'running', 'positive control: valid path accepted');
  });
  console.log(`codex-state-test: ${passed} passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
