'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createCollector, SNAPSHOT_EVENT, SET_SETTING_EVENT } = require('../tool');
const { createCodexIpc, encodeFrame } = require('../lib/codex-ipc');
const sf = require('../lib/state-files');
const { createData, CID, TURN1, TURN2, RUNTIME } = require('./fixtures/codex-state-data');
const T0 = new Date(2026, 8, 12, 12).getTime();
async function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-codex-state-'));
  const home = path.join(root, 'codex'), dir = path.join(root, 'state');
  const data = createData(home); let at = T0, scheduled, socket, collector;
  const snapshots = [], bubbles = [];
  const settings = new Map([['codexIpcEnabled', true]]), listeners = new Map();
  const pet = {
    events: { on(name, fn) { listeners.set(name, fn); }, emit(name, value) { if (name === SNAPSHOT_EVENT) snapshots.push(value); } },
    storage: { async get(key) { return settings.get(key); }, async set(key, value) { settings.set(key, value); } },
    scheduler: { async every(ms, fn) { scheduled = fn; return 'timer'; }, async cancel() {} },
    pet: { bubble: text => bubbles.push(text), playAnim() {} }
  };
  const boot = async () => {
    listeners.clear();
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
    setting: async value => { listeners.get(SET_SETTING_EVENT)({key:'codexIpcEnabled', value}); await new Promise(resolve => setImmediate(resolve)); },
    restart: async () => { await collector.stop(pet); await boot(); },
    close: async () => { await collector.stop(pet); data.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
(async () => {
  let passed = 0;
  async function test(name, fn) { const r = await rig(); try { await fn(r); passed++; console.log('  ok', name); } finally { await r.close(); } }
  await test('完成通知缺失时，明确的本轮结束记录仍纠正运行计数', async r => {
    r.data.rollout(T0, 4); r.data.turn(TURN1, 'inProgress', T0);
    assert.equal(r.tick().state, 'running');
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.setTime(T0 + 2000);
    assert.equal(r.tick().state, 'done');
    assert.equal(r.read().turnId, TURN1);
    r.data.append(T0 + 3000); r.setTime(T0 + 3000);
    assert.equal(r.tick().state, 'done');
  });
  await test('历史任务内部 ID 改变后续聊，仍显示原任务且完成屏障跟随新回合', async r => {
    r.data.rollout(T0, 4); r.data.turn(TURN1, 'inProgress', T0);
    assert.equal(r.tick().state, 'running', 'positive control: original task is visible');
    r.data.turn(TURN1, 'interrupted', T0, 142, T0 + 1000);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    assert.equal(r.tick().state, 'stopped');
    const resumedAt = T0 + 86400000;
    r.setTime(resumedAt); r.data.rollout(resumedAt, 5, RUNTIME);
    r.data.turn(TURN2, 'inProgress', resumedAt, 1, null, RUNTIME);
    r.feed('thread-read-state-changed', { hasUnreadTurn: false });
    assert.equal(r.tick()?.state, 'running', 'resumed task must not disappear behind the old interrupted turn');
    assert.equal(r.read().threadId, CID); assert.equal(r.read().turnId, TURN2);
    assert.equal(sf.readStatus(RUNTIME, r.dir), null, 'internal runtime must not become a separate task');
    await r.restart(); assert.equal(r.tick()?.state, 'running');
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    assert.equal(r.tick()?.state, 'running', 'delayed completion cannot end the resumed turn');
    r.data.turn(TURN2, 'completed', resumedAt, 1, resumedAt + 1000, RUNTIME);
    assert.equal(r.tick().state, 'done'); assert.equal(r.read().turnId, TURN2);
    r.data.append(resumedAt + 1000); r.setTime(resumedAt + 1000);
    assert.equal(r.tick().state, 'done', 'final flush cannot revive the completed runtime');
  });
  await test('内部 ID 关联缺失或路径不匹配时，不借用其他任务的运行回合', async r => {
    const { DatabaseSync } = require('node:sqlite');
    const { createCodexThreadState } = require('../lib/codex-thread-state');
    r.data.rollout(T0, 4); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); r.tick();
    r.setTime(T0 + 5000);
    const file = r.data.rollout(T0 + 5000, 4, RUNTIME);
    assert.equal(r.tick().state, 'done', 'missing runtime history cannot cross a completion barrier');
    r.data.turn(TURN2, 'inProgress', T0 + 5000, 1, null, RUNTIME);
    const other = path.join(path.dirname(file), `rollout-fixture-${TURN2}_${RUNTIME}.jsonl`);
    fs.renameSync(file, other);
    const db = new DatabaseSync(path.join(r.home, 'state_5.sqlite'));
    db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(other, CID);
    assert.equal(createCodexThreadState({codexHome:r.home}).read([CID]).get(CID).turn.id, TURN1,
      'mismatched App ID must not authorize the runtime lookup');
    assert.equal(r.tick().state, 'done');
    db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file, CID); db.close();
    fs.renameSync(other, file);
    assert.equal(r.tick().state, 'running', 'positive control: matching indexed alias resumes');
  });
  await test('排队续聊先开跑、上一轮未读通知后到达，长任务仍持续显示', async r => {
    r.data.rollout(T0, 4); r.data.turn(TURN1, 'inProgress', T0);
    assert.equal(r.tick().state, 'running', 'positive control: initial turn is visible');
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.setTime(T0 + 1000); r.data.turn(TURN2, 'inProgress', T0 + 1000, 50);
    r.data.append(T0 + 1000);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    r.feed('thread-read-state-changed', { hasUnreadTurn: false });
    // Real long-running continuation: file activity continues after old done rows expire.
    r.setTime(T0 + 21 * 60000); r.data.append(T0 + 21 * 60000);
    assert.equal(r.tick()?.state, 'running', 'queued prompt must not disappear into the empty panel');
    assert.equal(r.read().turnId, TURN2);
    assert.equal(r.bubbles.length, 0, 'previous turn must not announce the running continuation as complete');
  });
  await test('完成事件后旧活动不得覆盖 done，重启和收尾追加也不得复活', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0);
    assert.equal(r.tick().state, 'running', 'positive control: real file reaches snapshot');
    r.setTime(T0 + 2000); r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    assert.equal(r.tick().state, 'running', 'unscoped completion waits for terminal metadata');
    assert.equal(r.bubbles.length, 0, 'no premature completion notification');
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 2000);
    assert.equal(r.tick().state, 'done', 'completion must survive next scheduled poll');
    assert.equal(r.bubbles.length, 1, 'completion reaches pet notification');
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 2000);
    r.setTime(T0 + 4000); r.data.append(T0 + 4000);
    assert.equal(r.tick().state, 'done', 'final log flush is same completed turn');
    await r.restart(); assert.equal(r.tick().state, 'done', 'restart retains completion barrier');
    r.feed('thread-read-state-changed', { hasUnreadTurn: false }); assert.equal(r.read().state, 'done'); assert.equal(r.read().read, true);
    assert.equal(r.tick().state, 'done', 'reading result does not revive task');
    assert.equal(r.bubbles.length, 1, 'no duplicate completion notifications');
  });
  await test('迟到未读通知不能撤销同轮已读，也不能刷新完成时间', async r => {
    r.data.rollout(T0);r.data.turn(TURN1,'inProgress',T0);r.tick();
    r.setTime(T0+1000);r.data.turn(TURN1,'completed',T0,1,T0+1000);r.tick();
    const completed=r.read();r.feed('thread-read-state-changed',{hasUnreadTurn:false});
    r.setTime(T0+2000);r.feed('thread-read-state-changed',{hasUnreadTurn:true});
    assert.equal(r.read().read,true);assert.equal(r.read().ts,completed.ts);
    assert.equal(r.read().runId,completed.runId);assert.equal(r.bubbles.length,1);
  });
  await test('旧任务的新回合可以重新运行，心跳计时连续', async r => {
    r.data.rollout(T0, 4); r.data.turn(TURN1, 'inProgress', T0);
    assert.equal(r.tick().state, 'running', 'older directory is tracked by exact path');
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); assert.equal(r.tick().state, 'done');
    r.setTime(T0 + 5000); r.data.turn(TURN2, 'inProgress', T0 + 5000, 50); r.data.append(T0 + 5000);
    assert.equal(r.tick().state, 'running'); const since = r.read().since;
    r.feed('thread-read-state-changed', { hasUnreadTurn: false }); assert.equal(r.read().state, 'running');
    r.setTime(T0 + 27000); r.data.append(T0 + 27000); assert.equal(r.tick().state, 'running');
    assert.equal(r.read().since, since); assert.equal(r.read().turnId, TURN2);
  });
  await test('数据库不可用时不能凭收尾写入覆盖完成，恢复后识别新回合', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
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
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); r.tick();
    r.setTime(T0 + 1000); r.data.turn(TURN2, 'inProgress', T0 + 1000, 50); r.data.append(T0 + 1000);
    r.feed('thread-read-state-changed', { hasUnreadTurn: false });
    assert.equal(r.tick().state, 'running'); assert.equal(r.read().turnId, TURN2);
  });
  await test('已核验完成后数据库回退为同一 inProgress 回合，重启也不能复活', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    r.data.turn(TURN1, 'inProgress', T0);
    await r.restart(); r.setTime(T0 + 3000); r.data.append(T0 + 3000);
    assert.equal(r.tick().state, 'done');
  });
  await test('schema:1 终态可兼容读取，明确的新回合才升级运行', async r => {
    fs.mkdirSync(r.dir, { recursive: true });
    fs.writeFileSync(path.join(r.dir, CID + '.json'), JSON.stringify({schema:1, agent:'codex', form:'app', sessionId:CID, threadId:CID, source:'ipc', state:'done', cwd:'', project:'Codex App', tty:null, pid:null, lastEvent:'ipc:turn-unread', ts:T0-60000}));
    r.data.rollout(T0, 4); r.data.turn(TURN1, 'completed', T0 - 120000, 1, T0 - 60000);
    assert.equal(r.tick().state, 'done'); assert.equal(r.read().schema, 1);
    r.data.turn(TURN2, 'inProgress', T0, 50); assert.equal(r.tick().state, 'running');
    assert.equal(r.read().schema, 3); assert.equal(r.read().turnId, TURN2);
  });
  await test('未知回合状态不能恢复完成或让运行中的已读误报结束', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.data.turn(TURN1, 'future-state', T0);
    r.feed('thread-read-state-changed', {hasUnreadTurn:false}); assert.equal(r.read().state, 'running');
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.feed('thread-read-state-changed', {hasUnreadTurn:true});
    r.data.turn(TURN2, 'future-state', T0 + 1000, 50); r.data.append(T0 + 1000);
    assert.equal(r.tick().state, 'done');
  });
  await test('同回合完成后的队列清理广播不能覆盖完成', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.feed('thread-read-state-changed', {hasUnreadTurn:true});
    r.feed('thread-queued-followups-changed', {messages:[]}); assert.equal(r.tick().state, 'done');
  });
  await test('已经扫描到续聊回合后，迟到未读与已读通知也不能隐藏它', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0 - 10000); r.tick();
    r.data.turn(TURN1, 'completed', T0 - 10000, 1, T0);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); assert.equal(r.tick().state, 'done');
    r.setTime(T0 + 1000); r.data.turn(TURN2, 'inProgress', T0 + 1000, 50); r.data.append(T0 + 1000);
    assert.equal(r.tick().state, 'running');
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    r.feed('thread-read-state-changed', { hasUnreadTurn: false });
    r.setTime(T0 + 21000); r.data.append(T0 + 21000);
    assert.equal(r.tick().state, 'running'); assert.equal(r.read().turnId, TURN2);
    assert.equal(r.bubbles.length, 1, 'only the initial completed turn notified');
    // Once the continuation actually ends, its completion still reaches the panel.
    r.data.turn(TURN2, 'completed', T0 + 1000, 50, T0 + 21000);
    assert.equal(r.tick().state, 'done'); assert.equal(r.read().state, 'done'); assert.equal(r.read().read, false);
    assert.equal(r.bubbles.length, 2, 'previous unscoped read cannot mark the continuation completion read');
  });
  await test('数据库中断期间保留执行事实，恢复后无需未读通知即可收尾', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    const db = path.join(r.home, 'thread_history_1.sqlite'); fs.renameSync(db, db + '.away');
    r.feed('thread-read-state-changed', {hasUnreadTurn:true});
    r.setTime(T0 + 60000); r.tick(); assert.equal(r.read().state, 'running');
    fs.renameSync(db + '.away', db);
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    assert.equal(r.tick().state, 'done'); assert.equal(r.read().turnId, TURN1);
    assert.equal(r.bubbles.length, 1);
  });
  await test('新回合丢弃旧回合待确认通知，重启不根据数据库补发完成', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    r.setTime(T0 + 1000); r.data.turn(TURN2, 'inProgress', T0 + 1000, 50); r.data.append(T0 + 1000);
    assert.equal(r.tick().state, 'running'); assert.equal(r.read().turnId, TURN2);
    r.data.turn(TURN2, 'completed', T0 + 1000, 50, T0 + 2000);
    r.tick(); assert.equal(r.read().state, 'done', 'new turn terminal metadata is independent of old notification');
    await r.restart(); r.tick(); assert.equal(r.read().state, 'done');
    assert.equal(r.bubbles.length, 1);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); assert.equal(r.tick().state, 'done');
  });
  await test('没有状态文件或 following 的未读通知，也会继续核验该回合', async r => {
    r.feed('thread-stream-following-changed', { following: false });
    r.data.turn(TURN1, 'inProgress', T0);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true }); assert.equal(r.tick(), undefined);
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    assert.equal(r.tick(), undefined); assert.equal(r.read(), null);
  });
  await test('待确认的陌生会话已被读过时，不新建 ended 记录', async r => {
    r.feed('thread-stream-following-changed', { following: false });
    r.data.turn(TURN1, 'inProgress', T0);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    r.feed('thread-read-state-changed', { hasUnreadTurn: false });
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    assert.equal(r.tick(), undefined); assert.equal(r.read(), null);
  });
  await test('关闭增强或停止插件会丢弃尚未确认的通知', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    await r.setting(false);
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.tick(); assert.equal(r.read().state, 'running');
    await r.setting(true); r.tick(); assert.equal(r.read().state, 'done');
    r.data.turn(TURN1, 'inProgress', T0);
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    await r.restart();
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    r.tick(); assert.equal(r.read().state, 'done'); assert.equal(r.bubbles.length, 1);
  });
  await test('未知回合状态等待核验；等待期间出现 hook 记录仍受保护', async r => {
    r.data.rollout(T0); r.data.turn(TURN1, 'inProgress', T0); r.tick();
    r.feed('thread-read-state-changed', { hasUnreadTurn: true });
    r.data.turn(TURN1, 'future-state', T0);
    r.tick(); assert.equal(r.read().state, 'running');
    sf.writeStatus({ agent:'codex', sessionId:CID, threadId:CID, cwd:'/fixture', tty:'/dev/ttys901', pid:process.pid, source:'hook', state:'waiting', lastEvent:'PermissionRequest', ts:T0 }, r.dir);
    r.data.turn(TURN1, 'completed', T0, 1, T0 + 1000);
    assert.equal(r.tick().state, 'waiting'); assert.equal(r.read().source, 'hook');
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
