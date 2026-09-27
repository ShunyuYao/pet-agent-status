'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createDiagnostics, errorCode } = require('../lib/diagnostics');
const { createCodexIpc, encodeFrame, BACKOFF_MS, MAX_FRAME } = require('../lib/codex-ipc');
const { createCodexThreadState } = require('../lib/codex-thread-state');
const { createCodexAppIngest } = require('../lib/codex-app-ingest');
const { createData, CID, TURN1 } = require('./fixtures/codex-state-data');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-diagnostics-'));
let at = Date.now();
const file = dir => path.join(dir, 'diagnostics', 'agent-status.jsonl');
const read = dir => fs.readFileSync(file(dir), 'utf8').trim().split('\n').map(JSON.parse);
try {
  const dir = path.join(root, 'logs');
  let log = createDiagnostics({ dir, now: () => at, version: '0.13.1' });
  log.record('collector.started', { title: 'SECRET', path: '/private/SECRET', message: 'SECRET', stack: 'SECRET' });
  log.record('metadata.error', { reason: 'read-error', code: errorCode({code: 'SQLITE_BUSY', message: 'SECRET'}), database: 'state_5.sqlite' }, 60000);
  log.record('metadata.error', { reason: 'read-error', code: 'SQLITE_BUSY', database: 'state_5.sqlite' }, 60000);
  assert.equal(read(dir).length, 2);
  at += 60000;
  log.record('metadata.error', { reason: 'read-error', code: 'SQLITE_BUSY', database: 'state_5.sqlite' }, 60000);
  log = createDiagnostics({ dir, now: () => at, version: '0.13.1' });
  log.record('collector.started');
  const entries = read(dir);
  assert.equal(entries.length, 4);
  assert.notEqual(entries[0].instance, entries[3].instance);
  assert.equal(entries[0].version, '0.13.1');
  assert(!fs.readFileSync(file(dir), 'utf8').includes('SECRET'));
  assert.equal(fs.statSync(file(dir)).mode & 0o777, 0o600);
  assert.equal(errorCode(new Error('SECRET')), 'UNCLASSIFIED');
  console.log('  ok metadata whitelist, dedup, file permissions and restart retention');

  const rotate = path.join(root, 'rotate');
  const rotating = createDiagnostics({ dir: rotate, maxBytes: 1024 });
  for (let i = 0; i < 100; i++) rotating.record('ipc.retry', { reason: 'closed', attempt: i });
  const files = fs.readdirSync(path.dirname(file(rotate)));
  assert.deepEqual(files.sort(), ['agent-status.jsonl', 'agent-status.jsonl.1', 'agent-status.jsonl.2']);
  for (const name of files) {
    const full = path.join(path.dirname(file(rotate)), name);
    assert(fs.statSync(full).size <= 1024);
    for (const line of fs.readFileSync(full, 'utf8').trim().split('\n')) JSON.parse(line);
  }
  assert.equal(read(rotate).at(-1).attempt, 99);
  console.log('  ok rotation retains bounded complete JSON lines and latest evidence');

  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const resilient = createDiagnostics({ dir: blocked, now: () => at });
  assert.equal(resilient.record('collector.started'), false);
  fs.unlinkSync(blocked);
  assert.equal(resilient.record('collector.started'), false);
  at += 30000;
  assert.equal(resilient.record('collector.started'), true);
  console.log('  ok unwritable logging fails safely and recovers after cooldown');

  const ipcDir = path.join(root, 'ipc');
  const logger = createDiagnostics({ dir: ipcDir, now: () => at });
  const timers = [], sockets = [];
  const api = createCodexIpc({ now: () => at, socketPath: '/fixture',
    connect() { const socket = new EventEmitter(); socket.write = () => {}; socket.destroy = () => {}; sockets.push(socket); return socket; },
    setTimer(fn, ms) { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cancelled = true; },
    onDiagnostic: (event, data) => logger.record(event, data)
  });
  const fire = timer => { assert(timer && !timer.cancelled); timer.cancelled = true; at += timer.ms; timer.fn(); };
  api.start();
  // Repeated absent initialize responses: real elapsed timer equivalents, no private flags.
  for (let i = 0; i < 5; i++) {
    sockets.at(-1).emit('connect');
    fire(timers.at(-1));
    assert.equal(api.state, 'idle');
    assert.equal(timers.at(-1).ms, BACKOFF_MS[Math.min(i, 3)]);
    fire(timers.at(-1));
  }
  const socket = sockets.at(-1); socket.emit('connect');
  socket.emit('data', encodeFrame({ type: 'response', method: 'initialize' }));
  socket.emit('data', encodeFrame({ type: 'broadcast', method: 'thread-stream-following-changed', params: {conversationId: CID, following: true, prompt: 'SECRET'} }));
  assert.equal(api.state, 'ready'); assert.deepEqual(api.followingIds(), [CID]);
  const bad = Buffer.alloc(4); bad.writeUInt32LE(MAX_FRAME + 8);
  socket.emit('data', bad);
  assert.equal(api.state, 'disabled');
  assert(!timers.some(t => !t.cancelled));
  let records = read(ipcDir);
  assert.deepEqual(records.filter(x => x.event === 'ipc.retry').map(x => x.retryMs), [1000,5000,15000,60000,60000]);
  assert(records.filter(x => x.event === 'ipc.retry').every(x => x.reason === 'handshake-timeout' && x.retryAt));
  assert.equal(records.find(x => x.event === 'ipc.ready').attempt, 5);
  assert.equal(records.at(-1).reason, 'frame-too-large');
  assert.equal(records.at(-1).frameBytes, MAX_FRAME + 8);
  assert(!fs.readFileSync(file(ipcDir),'utf8').includes('SECRET'));
  api.stop(); api.start(); sockets.at(-1).emit('connect');
  sockets.at(-1).emit('error', { code: 'ECONNRESET' });
  assert.equal(timers.at(-1).ms, 1000);
  api.stop(); assert(!timers.some(t => !t.cancelled));
  assert.equal(read(ipcDir).find(x => x.code === 'ECONNRESET').reason, 'socket-error');
  console.log('  ok bounded backoff, recovery, exact protocol fault and stop cancellation recorded');

  const home = path.join(root, 'codex'), metadataLog = path.join(root, 'metadata-log');
  const metadataLogger = createDiagnostics({dir: metadataLog});
  const report = (event, data) => metadataLogger.record(event, data, 60000);
  const reader = createCodexThreadState({codexHome: home, onDiagnostic: report});
  assert.equal(reader.read([CID]).size, 0);
  assert(read(metadataLog).some(x => x.event === 'metadata.error'));
  const fixture = createData(home);
  try {
    fixture.rollout(at); fixture.turn(TURN1, 'inProgress', at);
    assert.equal(reader.read([CID]).get(CID).turn.id, TURN1);
    assert(read(metadataLog).some(x => x.event === 'metadata.ready' && x.database === 'thread_history_1.sqlite'));
    const unavailable = path.join(root, 'unavailable'); fs.writeFileSync(unavailable, 'blocked');
    const ingest = createCodexAppIngest({dir: unavailable, onDiagnostic: report, threadFor: id => reader.read([id]).get(id)});
    ingest.onActivity(CID);
    assert(read(metadataLog).some(x => x.event === 'ingest.error' && x.reason === 'write-error'));
  } finally { fixture.close(); }
  console.log('  ok actual metadata read failure/recovery and status write failure leave evidence');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('diagnostics-test: passed');
