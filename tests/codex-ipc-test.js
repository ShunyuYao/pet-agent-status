'use strict';
// Codex App IPC 适配器与深链接（US-8）。
//
// 需求条件 → 断言（先断言后实现）：
//   ① 帧解析：半包/粘包/超长帧/坏 JSON 各一条
//   ② 握手：成功置 ready；超时不死磕 → disabled（退回 Hooks）
//   ③ 只认实录事件：following 生效；【调研】未复现的事件一律忽略，绝不映射成 done
//   ④ 故障即退场：协议错停用不重连；socket 错误走退避重连
//   ⑤ 深链接：只接受 UUID；非法/非 codex:// 拒绝；no-scheme 与 failed 分开
//   ⑥ 导航二选一：App 任务(无 tty+有 threadId)→deeplink；有 tty→tty；都没有→null
//   ⑦ 不碰真 socket、不真跑 open（全注入）
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const ipc = require(path.join(__dirname, '..', 'lib', 'codex-ipc.js'));
const dl = require(path.join(__dirname, '..', 'lib', 'codex-deeplink.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { console.log('  FAIL', name); throw e; }
}

function frameOf(obj) { return ipc.encodeFrame(obj); }

// ---- ① 帧解析 ----
test('粘包：一次 data 给两帧，两条都解出来', () => {
  const p = ipc.createFrameParser();
  const r = p.push(Buffer.concat([frameOf({ a: 1 }), frameOf({ b: 2 })]));
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.messages, [{ a: 1 }, { b: 2 }]);
});

test('半包：分三次喂一帧，凑齐才吐', () => {
  const p = ipc.createFrameParser();
  const f = frameOf({ hello: 'world' });
  assert.deepStrictEqual(p.push(f.subarray(0, 2)).messages, [], '长度前缀都没齐');
  assert.deepStrictEqual(p.push(f.subarray(2, 6)).messages, [], '正文没齐');
  assert.deepStrictEqual(p.push(f.subarray(6)).messages, [{ hello: 'world' }]);
});

test('超长帧判协议错（防内存放大）', () => {
  const p = ipc.createFrameParser();
  const len = Buffer.alloc(4);
  len.writeUInt32LE(ipc.MAX_FRAME + 1, 0);
  const r = p.push(len);
  assert.ok(r.error && /too large/.test(r.error), r.error);
});

test('坏 JSON 判协议错', () => {
  const p = ipc.createFrameParser();
  const body = Buffer.from('{ not json', 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32LE(body.length, 0);
  const r = p.push(Buffer.concat([len, body]));
  assert.ok(r.error && /JSON/.test(r.error), r.error);
});

// ---- ③ 事件解读 ----
test('只认实录事件：following 生效', () => {
  const ev = ipc.interpret({ type: 'broadcast', method: 'thread-stream-following-changed',
    params: { conversationId: 'c1', hostId: 'h', following: true } });
  assert.deepStrictEqual(ev, { kind: 'following', conversationId: 'c1', following: true });
});

test('未实录语义的事件一律忽略，绝不映射成 done（facts §5/§8.1）', () => {
  // thread-stream-state-changed 是 §8.1 实录反证：被动 client 收不到，永远别加进映射
  for (const m of ['thread-stream-state-changed', 'thread-archived', 'thread-unarchived',
    'query-cache-invalidate', 'client-status-changed', '完全没见过的事件']) {
    assert.strictEqual(ipc.interpret({ type: 'broadcast', method: m, params: { conversationId: 'c1' } }), null, m);
  }
});

test('activity：queued-followups 变化 →（提交时刻信号，facts §8.2）', () => {
  const ev = ipc.interpret({ type: 'broadcast', method: 'thread-queued-followups-changed',
    params: { conversationId: 'c1', messages: [] } });
  assert.deepStrictEqual(ev, { kind: 'activity', conversationId: 'c1' });
});

test('read-state：hasUnreadTurn 布尔原样带出（facts §8.3 时序实验）', () => {
  const t1 = ipc.interpret({ type: 'broadcast', method: 'thread-read-state-changed',
    params: { conversationId: 'c1', hostId: 'local', hasUnreadTurn: true } });
  assert.deepStrictEqual(t1, { kind: 'read-state', conversationId: 'c1', hasUnreadTurn: true });
  const t2 = ipc.interpret({ type: 'broadcast', method: 'thread-read-state-changed',
    params: { conversationId: 'c1', hasUnreadTurn: false } });
  assert.deepStrictEqual(t2, { kind: 'read-state', conversationId: 'c1', hasUnreadTurn: false });
});

test('read-state 缺 hasUnreadTurn 或非布尔时忽略（缺字段不猜）', () => {
  for (const bad of [{}, { hasUnreadTurn: 'true' }, { hasUnreadTurn: 1 }, { hasUnreadTurn: null }]) {
    assert.strictEqual(ipc.interpret({ type: 'broadcast', method: 'thread-read-state-changed',
      params: Object.assign({ conversationId: 'c1' }, bad) }), null, JSON.stringify(bad));
  }
});

test('三个已映射事件缺 conversationId 时都忽略（不造半条状态）', () => {
  for (const m of ['thread-stream-following-changed', 'thread-queued-followups-changed', 'thread-read-state-changed']) {
    assert.strictEqual(ipc.interpret({ type: 'broadcast', method: m, params: { following: true, hasUnreadTurn: true } }), null, m);
  }
});

// ---- ②④ 连接生命周期（全注入，不碰真 socket）----
function mockSock() {
  const s = new EventEmitter();
  s.written = [];
  s.write = (b) => { s.written.push(b); return true; };
  s.destroy = () => { s.destroyed = true; };
  return s;
}
function harness(opts = {}) {
  const timers = [];
  const statuses = [];
  const sockets = [];
  const api = ipc.createCodexIpc({
    socketPath: '/fake/ipc.sock',
    connect: () => { const s = opts.connectThrows ? null : mockSock(); if (opts.connectThrows) throw new Error('ENOENT'); sockets.push(s); return s; },
    randomUUID: () => 'uuid-1',
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cancelled = true; },
    onStatus: (st, reason) => statuses.push([st, reason]),
    onFollowing: opts.onFollowing,
  });
  return { api, timers, statuses, sockets, fire: (t) => { if (t && !t.cancelled) t.fn(); } };
}

test('握手成功 → ready，且发出的是 initialize 帧', () => {
  const h = harness();
  h.api.start();
  const s = h.sockets[0];
  s.emit('connect');
  assert.strictEqual(s.written.length, 1);
  const sent = JSON.parse(s.written[0].subarray(4).toString('utf8'));
  assert.strictEqual(sent.method, 'initialize');
  assert.strictEqual(sent.type, 'request');
  s.emit('data', frameOf({ type: 'response', method: 'initialize', requestId: 'uuid-1', result: {} }));
  assert.strictEqual(h.api.state, 'ready');
});

test('握手超时不死磕 → disabled（退回 Hooks）', () => {
  const h = harness();
  h.api.start();
  h.sockets[0].emit('connect');
  const hs = h.timers.find((t) => t.ms === 5000);
  assert.ok(hs, '应设了握手超时');
  h.fire(hs);
  assert.strictEqual(h.api.state, 'disabled');
});

test('协议错（坏帧）→ 停用且不重连', () => {
  const h = harness();
  h.api.start();
  const s = h.sockets[0];
  s.emit('connect');
  s.emit('data', frameOf({ type: 'response', method: 'initialize' }));
  const bad = Buffer.alloc(4); bad.writeUInt32LE(ipc.MAX_FRAME + 10, 0);
  s.emit('data', bad);
  assert.strictEqual(h.api.state, 'disabled');
  const retry = h.timers.filter((t) => ipc.BACKOFF_MS.includes(t.ms) && !t.cancelled);
  assert.strictEqual(retry.length, 0, '协议错不该安排重连');
});

test('socket 错误 → 退避重连（App 随时可能起来）', () => {
  const h = harness();
  h.api.start();
  h.sockets[0].emit('error', { code: 'ECONNREFUSED' });
  const retry = h.timers.find((t) => t.ms === ipc.BACKOFF_MS[0]);
  assert.ok(retry, '应安排首档退避重连');
  assert.notStrictEqual(h.api.state, 'disabled');
});

test('connect 抛异常（socket 不存在）不崩，走退避', () => {
  const h = harness({ connectThrows: true });
  h.api.start();
  assert.ok(h.timers.some((t) => t.ms === ipc.BACKOFF_MS[0]));
  assert.notStrictEqual(h.api.state, 'disabled');
});

test('following 集合随广播增删，stop 后清空', () => {
  const seen = [];
  const h = harness({ onFollowing: (id, f) => seen.push([id, f]) });
  h.api.start();
  const s = h.sockets[0];
  s.emit('connect');
  s.emit('data', frameOf({ type: 'response', method: 'initialize' }));
  s.emit('data', frameOf({ type: 'broadcast', method: 'thread-stream-following-changed', params: { conversationId: 'c1', following: true } }));
  assert.deepStrictEqual(h.api.followingIds(), ['c1']);
  assert.strictEqual(h.api.isFollowing('c1'), true);
  s.emit('data', frameOf({ type: 'broadcast', method: 'thread-stream-following-changed', params: { conversationId: 'c1', following: false } }));
  assert.deepStrictEqual(h.api.followingIds(), []);
  h.api.stop();
  assert.deepStrictEqual(h.api.followingIds(), []);
  assert.deepStrictEqual(seen, [['c1', true], ['c1', false]]);
});

test('activity/read-state 帧经真实数据链路触达摄入回调', () => {
  const acts = [];
  const reads = [];
  const s = mockSock();
  const api = ipc.createCodexIpc({
    socketPath: '/fake/ipc.sock', connect: () => s, randomUUID: () => 'u',
    setTimer: () => ({}), clearTimer: () => {},
    onActivity: (id) => acts.push(id), onReadState: (id, un) => reads.push([id, un])
  });
  api.start();
  s.emit('connect');
  s.emit('data', frameOf({ type: 'response', method: 'initialize' }));
  s.emit('data', frameOf({ type: 'broadcast', method: 'thread-queued-followups-changed', params: { conversationId: 'c9', messages: [] } }));
  s.emit('data', frameOf({ type: 'broadcast', method: 'thread-read-state-changed', params: { conversationId: 'c9', hasUnreadTurn: true } }));
  s.emit('data', frameOf({ type: 'broadcast', method: 'thread-read-state-changed', params: { conversationId: 'c9', hasUnreadTurn: false } }));
  assert.deepStrictEqual(acts, ['c9']);
  assert.deepStrictEqual(reads, [['c9', true], ['c9', false]]);
});

test('摄入回调抛异常不反杀适配器', () => {
  const s = mockSock();
  const api = ipc.createCodexIpc({
    socketPath: '/fake/ipc.sock', connect: () => s, randomUUID: () => 'u',
    setTimer: () => ({}), clearTimer: () => {},
    onActivity: () => { throw new Error('boom'); },
    onReadState: () => { throw new Error('boom'); }
  });
  api.start();
  s.emit('connect');
  s.emit('data', frameOf({ type: 'response', method: 'initialize' }));
  s.emit('data', frameOf({ type: 'broadcast', method: 'thread-queued-followups-changed', params: { conversationId: 'c1', messages: [] } }));
  s.emit('data', frameOf({ type: 'broadcast', method: 'thread-read-state-changed', params: { conversationId: 'c1', hasUnreadTurn: true } }));
  assert.strictEqual(api.state, 'ready', '适配器应活着');
});

test('消费方回调抛异常不反杀适配器', () => {
  const h = harness({ onFollowing: () => { throw new Error('consumer exploded'); } });
  h.api.start();
  const s = h.sockets[0];
  s.emit('connect');
  s.emit('data', frameOf({ type: 'response', method: 'initialize' }));
  s.emit('data', frameOf({ type: 'broadcast', method: 'thread-stream-following-changed', params: { conversationId: 'c1', following: true } }));
  assert.strictEqual(h.api.state, 'ready', '适配器应活着');
});

// ---- ⑤ 深链接 ----
test('只接受 UUID 形态的 threadId', () => {
  const good = '01a08ab6-557f-77b3-bc37-3553f712b2e0';
  assert.strictEqual(dl.buildDeepLink(good), `codex://threads/${good}`);
  for (const bad of ['', null, undefined, 'not-a-uuid', '../../etc/passwd',
    '01a08ab6-557f-77b3-bc37-3553f712b2e0 && rm -rf /', '<script>']) {
    assert.strictEqual(dl.buildDeepLink(bad), null, String(bad));
  }
});

test('openDeepLink 拒绝非 codex:// 的 URL', () => {
  const calls = [];
  const r = dl.openDeepLink('https://evil.example.com', (c, a) => calls.push([c, a]));
  assert.deepStrictEqual(r, { ok: false, reason: 'invalid' });
  assert.strictEqual(calls.length, 0, '非法 URL 不该真去 open');
});

test('openDeepLink 成功时把 URL 原样交给 open', () => {
  const calls = [];
  const url = 'codex://threads/01a08ab6-557f-77b3-bc37-3553f712b2e0';
  assert.deepStrictEqual(dl.openDeepLink(url, (c, a) => calls.push([c, a])), { ok: true });
  assert.deepStrictEqual(calls, [['open', [url]]]);
});

test('Scheme 未注册与一般失败分成两种 reason（文案不同）', () => {
  const url = 'codex://threads/01a08ab6-557f-77b3-bc37-3553f712b2e0';
  assert.strictEqual(dl.openDeepLink(url, () => { throw new Error('kLSApplicationNotFoundErr'); }).reason, 'no-scheme');
  assert.strictEqual(dl.openDeepLink(url, () => { throw new Error('some other failure'); }).reason, 'failed');
});

// ---- ⑥ 导航二选一 ----
test('App 任务（form app + 无 tty + 有 threadId）→ deeplink', () => {
  const n = dl.pickNavigator({ agent: 'codex', form: 'app', tty: null, threadId: '01a08ab6-557f-77b3-bc37-3553f712b2e0' });
  assert.strictEqual(n.kind, 'deeplink');
  assert.ok(n.url.startsWith('codex://threads/'));
});

test('Codex CLI 会话（非 app 形态）即便有 threadId 且丢了 tty 也不给深链接（v0.5.0 CI 回归）', () => {
  // CLI 会话的 threadId 是给「有 tty 时」将来增强用的；tty 丢了走深链接会跳进 App 里不存在的任务页
  for (const form of [undefined, 'cli']) {
    assert.strictEqual(dl.pickNavigator({ agent: 'codex', form, tty: null, threadId: '01a08ab6-557f-77b3-bc37-3553f712b2e0' }), null, String(form));
  }
});

test('有 tty 的会话（含 Codex CLI）→ 走既有 tty 链路', () => {
  assert.deepStrictEqual(dl.pickNavigator({ agent: 'codex', tty: '/dev/ttys026', threadId: '01a08ab6-557f-77b3-bc37-3553f712b2e0' }), { kind: 'tty' });
  assert.deepStrictEqual(dl.pickNavigator({ agent: 'claude-code', tty: '/dev/ttys017' }), { kind: 'tty' });
});

test('两样都没有 → null（不显示跳转入口，不做假按钮）', () => {
  assert.strictEqual(dl.pickNavigator({ agent: 'codex', tty: null, threadId: 'bogus' }), null);
  assert.strictEqual(dl.pickNavigator({ agent: 'claude-code', tty: null }), null);
  assert.strictEqual(dl.pickNavigator(null), null);
});

console.log(`codex-ipc-test: ${passed} passed`);
