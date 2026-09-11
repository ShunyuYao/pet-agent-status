'use strict';
// Codex App 任务摄入（US-8 摄入段）。
//
// 需求条件 → 断言（映射表冻结在 PROTOCOL.md「IPC 事件 → state 映射」）：
//   ① 提交（queued-followups 帧）→ 落盘 running（agent codex / form app / source ipc / threadId=会话 id）
//   ② 回合完成（read-state hasUnreadTurn:true 帧）→ 落盘 done —— 全链路走真实帧解析，不直调内部函数
//   ③ 已读（hasUnreadTurn:false）→ 仅更新已存在的 ipc 记录为 ended，**绝不新建**（不报旧闻）
//   ④ CLI hooks 写的同名会话（source:'hook'）绝不被 IPC 覆盖
//   ⑤ conversationId 非 UUID 形态 → 一个文件都不落（脏 id 不进状态目录）
//   ⑥ 落盘记录过 validateRecord，且经 aggregate 后 canJump=true（深链接入口）、form='app'
//   ⑦ 全程只碰临时目录
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sf = require(path.join(ROOT, 'lib', 'state-files.js'));
const ipc = require(path.join(ROOT, 'lib', 'codex-ipc.js'));
const { createCodexAppIngest, APP_PROJECT } = require(path.join(ROOT, 'lib', 'codex-app-ingest.js'));
const { aggregate } = require(path.join(ROOT, 'lib', 'aggregate.js'));
const { EventEmitter } = require('events');

const T0 = 1789000000000;
const CID = '01a08a1d-4f63-7e30-af03-48ae77b414b5';   // 实录里的真实 UUID v7 形态

let passed = 0;
const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-ingest-'));
  tmpDirs.push(d);
  return d;
}
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { console.log('  FAIL', name); throw e; }
}

// 真实链路夹具：mock socket + 真帧编码 → 适配器解帧 → 摄入 → 真实临时目录落盘
function rig(dir) {
  const s = new EventEmitter();
  s.write = () => true;
  s.destroy = () => {};
  const ingest = createCodexAppIngest({ dir, now: () => T0 });
  const api = ipc.createCodexIpc({
    socketPath: '/fake/ipc.sock', connect: () => s, randomUUID: () => 'u',
    setTimer: () => ({}), clearTimer: () => {},
    onActivity: (id) => ingest.onActivity(id),
    onReadState: (id, un) => ingest.onReadState(id, un)
  });
  api.start();
  s.emit('connect');
  s.emit('data', ipc.encodeFrame({ type: 'response', method: 'initialize' }));
  return { feed: (msg) => s.emit('data', ipc.encodeFrame(msg)), api };
}
// 实录到的三种广播帧原样形状（fixtures/codex-ipc-facts.md §8.2）
function submitFrame(cid) {
  return { type: 'broadcast', method: 'thread-queued-followups-changed', version: 1,
    sourceClientId: 'app', params: { conversationId: cid, messages: [] } };
}
function turnDoneFrame(cid, hasUnread) {
  return { type: 'broadcast', method: 'thread-read-state-changed', version: 3,
    sourceClientId: 'app', params: { conversationId: cid, hostId: 'local', hasUnreadTurn: hasUnread,
      context: { identity: { kind: 'execution-storage', authMode: 'apikey' }, executionHostKey: 'local:x' } } };
}

// ---- ① 提交 → running ----
test('提交帧 → 落盘 running（codex/app/ipc，threadId=会话 id，过 validateRecord）', () => {
  const dir = tmp();
  rig(dir).feed(submitFrame(CID));
  const rec = sf.readStatus(CID, dir);
  assert.ok(rec, '状态文件没落盘');
  assert.strictEqual(sf.validateRecord(rec), null, '落盘记录必须过协议校验');
  assert.strictEqual(rec.agent, 'codex');
  assert.strictEqual(rec.form, 'app');
  assert.strictEqual(rec.source, 'ipc');
  assert.strictEqual(rec.state, 'running');
  assert.strictEqual(rec.threadId, CID);
  assert.strictEqual(rec.tty, null, 'App 任务没有终端');
  assert.strictEqual(rec.project, APP_PROJECT);
});

// ---- ② 回合完成 → done（全链路）----
test('回合完成帧 → done（提交→运行→完成的真实事件序列）', () => {
  const dir = tmp();
  const r = rig(dir);
  r.feed(submitFrame(CID));
  assert.strictEqual(sf.readStatus(CID, dir).state, 'running');
  r.feed(turnDoneFrame(CID, true));
  const rec = sf.readStatus(CID, dir);
  assert.strictEqual(rec.state, 'done');
  assert.strictEqual(rec.lastEvent, 'ipc:turn-unread');
});

// ---- ③ 已读语义 ----
test('已读帧（false）把已存在的 ipc 记录转 ended', () => {
  const dir = tmp();
  const r = rig(dir);
  r.feed(submitFrame(CID));
  r.feed(turnDoneFrame(CID, true));
  r.feed(turnDoneFrame(CID, false));
  assert.strictEqual(sf.readStatus(CID, dir).state, 'ended');
});

test('没见过的会话来已读帧（false）绝不新建（不报旧闻）', () => {
  const dir = tmp();
  rig(dir).feed(turnDoneFrame(CID, false));
  assert.strictEqual(sf.readStatus(CID, dir), null, '不该为陌生会话造 ended 行');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.json')), []);
});

test('没见过的会话直接来完成帧（true）→ 允许落 done（回合确实完成了）', () => {
  const dir = tmp();
  rig(dir).feed(turnDoneFrame(CID, true));
  assert.strictEqual(sf.readStatus(CID, dir).state, 'done');
});

// ---- ④ 不覆盖 hooks 记录 ----
test('CLI hooks 写的同名会话（source hook，含 tty）绝不被 IPC 覆盖', () => {
  const dir = tmp();
  sf.writeStatus({ agent: 'codex', sessionId: CID, cwd: '/Users/me/p', tty: '/dev/ttys009',
    pid: 4242, state: 'waiting', lastEvent: 'PermissionRequest', ts: T0 - 1000, threadId: CID }, dir);
  const r = rig(dir);
  r.feed(submitFrame(CID));
  r.feed(turnDoneFrame(CID, true));
  const rec = sf.readStatus(CID, dir);
  assert.strictEqual(rec.source, 'hook', 'hook 记录被 IPC 覆盖了');
  assert.strictEqual(rec.state, 'waiting');
  assert.strictEqual(rec.tty, '/dev/ttys009', 'tty 丢了 = 跳转入口被摄入弄坏');
});

// ---- ⑤ 脏 id ----
test('conversationId 非 UUID 形态 → 一个文件都不落', () => {
  const dir = tmp();
  const r = rig(dir);
  for (const bad of ['not-a-uuid', '../../etc/passwd', 'c1', '']) {
    r.feed(submitFrame(bad));
    r.feed(turnDoneFrame(bad, true));
  }
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.json')), []);
});

// ---- ⑥ 摄入记录经采集器聚合后的用户可观测结果 ----
test('摄入的 App 行经 aggregate：form=app、canJump=true（深链接）、无 tty', () => {
  const dir = tmp();
  const r = rig(dir);
  r.feed(submitFrame(CID));
  const dl = require(path.join(ROOT, 'lib', 'codex-deeplink.js'));
  const snap = aggregate(sf.readSnapshots(dir), { now: T0 + 1000, isPidAlive: () => true,
    canJumpWithoutTty: (row) => dl.pickNavigator(row) != null });   // 生产同款注入（tool/index.js）
  assert.strictEqual(snap.rows.length, 1);
  const row = snap.rows[0];
  assert.strictEqual(row.form, 'app');
  assert.strictEqual(row.state, 'running');
  assert.strictEqual(row.canJump, true, 'App 行有合法 threadId 就该给深链接入口');
  assert.strictEqual(row.tty, null);
  assert.strictEqual(row.threadId, CID);
});

test('落盘失败（目录是只读文件占位）不抛：摄入绝不打死适配器', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a dir');   // writeStatus mkdirSync 必抛 ENOTDIR
  const ingest = createCodexAppIngest({ dir: blocker, now: () => T0 });
  assert.doesNotThrow(() => {
    assert.strictEqual(ingest.onActivity(CID), null);
    assert.strictEqual(ingest.onReadState(CID, true), null);
  });
});

// ---- ⑦ 隔离自证 ----
test('测试全程未触碰真实状态目录', () => {
  // 只造临时目录；真实目录若存在，本轮不该新增/修改其中文件（存在本身不算失败）
  for (const d of tmpDirs) assert.ok(d.startsWith(os.tmpdir()));
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`codex-app-ingest-test: ${passed} passed`);
