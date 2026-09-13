'use strict';
// Real status/storage files and panel intent events; no real profiles, processes,
// network or Electron. A fresh collector + fresh SDK represent each restart.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tool = require('../tool');
const { writeStatus } = require('../lib/state-files');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-dismiss-test-'));
  const dir = path.join(root, 'state'), storeFile = path.join(root, 'storage.fixture');
  fs.mkdirSync(dir);
  fs.writeFileSync(storeFile, '{}');
  const sessions = [];
  let at = 1789000000000;
  const store = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const record = (id, over = {}) => writeStatus({
    sessionId: id, agent: 'claude-code', cwd: '/tmp/dismiss-test', tty: `/dev/${id}`,
    pid: 42, state: 'running', lastEvent: 'Notification', ts: at - 30 * 60 * 60 * 1000, ...over
  }, dir).file;
  async function start(options = {}) {
    const handlers = new Map(), snapshots = [];
    let poll;
    const pet = {
      storage: {
        async get(key) {
          if (key === 'codexIpcEnabled') return false;
          if (options.beforeRead) await options.beforeRead();
          return store()[key];
        },
        async set(key, value) {
          if (options.beforeWrite) await options.beforeWrite(value);
          fs.writeFileSync(storeFile, JSON.stringify({ ...store(), [key]: value }));
        }
      },
      scheduler: { every: async (_ms, fn) => { poll = fn; return 'fixture'; }, cancel: async () => {} },
      events: {
        on: (name, fn) => handlers.set(name, fn),
        emit: (name, data) => { if (name === tool.SNAPSHOT_EVENT) snapshots.push(data); }
      }
    };
    const collector = tool.createCollector({
      dir, now: () => at, isPidAlive: () => false,
      settingsFile: path.join(root, 'claude.fixture'), codexHooksFile: path.join(root, 'codex.fixture'),
      threadState: { read: () => new Map() }, threadTitles: { lookup: () => null },
      terminalTitles: { lookup: () => null }, claudeDesktop: { lookupTitle: () => null, has: () => false },
      rolloutActivity: { activeThreads: () => new Map() }, workbuddySource: { tick() {} },
      psTree: [], createAppLauncher: () => ({ detect: () => [], open() {} })
    });
    await collector.start(pet);
    const session = {
      snapshots, rows: () => snapshots.at(-1).rows,
      click: id => handlers.get(tool.JUMP_EVENT)({ sessionId: id }),
      poll: () => poll(), stop: () => collector.stop(pet)
    };
    sessions.push(session);
    return session;
  }
  try { await run({ record, start, store, storeFile, advance: ms => { at += ms; } }); }
  finally {
    for (const session of sessions) await session.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  await fixture(async ({ record, start, advance }) => {
    const ids = ['a', 'b', 'c'];
    const files = ids.map(id => record(id));
    const originals = files.map(file => fs.readFileSync(file, 'utf8'));
    record('untouched');
    const first = await start();
    assert.equal(first.rows().length, 4);
    for (const id of ids) {
      assert.equal(first.rows().find(row => row.sessionId === id).canDismiss, true);
      first.click(id);
    }
    assert.deepEqual(first.rows().map(row => row.sessionId), ['untouched']);
    await first.stop();
    const second = await start();
    for (const snapshot of second.snapshots) {
      assert.deepEqual(snapshot.rows.map(row => row.sessionId), ['untouched'], 'even the first snapshot must honor acknowledgements');
      assert.equal(snapshot.summary.total, 1, 'summary shares the same filtered rows');
    }
    files.forEach((file, i) => assert.equal(fs.readFileSync(file, 'utf8'), originals[i]));
    advance(1000);
    record('a', { ts: 1789000001000, state: 'done', lastEvent: 'Stop' });
    second.poll();
    assert.equal(second.rows().find(row => row.sessionId === 'a').state, 'done', 'new completion is unread again');
    await second.stop();
    const third = await start();
    assert.deepEqual(new Set(third.rows().map(row => row.sessionId)), new Set(['a', 'untouched']));
    third.click('a');
    await third.stop();
    assert.deepEqual((await start()).rows().map(row => row.sessionId), ['untouched'], 'done also stays dismissed across restart');
  });
  console.log('  ok three dismissals survive restart from the first snapshot; new activity revives only that session');

  await fixture(async ({ record, start }) => {
    for (const id of ['a', 'b', 'c']) record(id);
    let release;
    const first = await start({ beforeWrite: async value => {
      if (Object.keys(value).length === 1) await new Promise(resolve => { release = resolve; });
    } });
    first.click('a');
    await settle();
    first.click('b'); first.click('c');
    await settle();
    release();
    await first.stop();
    assert.equal((await start()).rows().length, 0, 'a slow earlier save cannot overwrite later clicks');
  });
  console.log('  ok rapid clicks and delayed storage preserve every acknowledgement');

  await fixture(async ({ record, start }) => {
    record('a');
    let fail = true;
    const first = await start({ beforeWrite: () => { if (fail) throw new Error('fixture disk unavailable'); } });
    first.click('a');
    await settle();
    assert.equal(first.rows().length, 0, 'storage failure does not break the current view');
    fail = false;
    first.poll();
    await first.stop();
    assert.equal((await start()).rows().length, 0, 'scheduled retry saves the dismissal after storage recovers');
  });
  console.log('  ok failed writes retry without interrupting collection');

  await fixture(async ({ record, start }) => {
    record('a'); record('b');
    const first = await start(); first.click('a'); await first.stop();
    let fail = true;
    const second = await start({ beforeRead: () => { if (fail) throw new Error('fixture read unavailable'); } });
    second.click('b');
    await settle();
    fail = false;
    second.poll();
    await second.stop();
    assert.equal((await start()).rows().length, 0, 'failed initial read never overwrites older dismissals with an empty map');
  });
  console.log('  ok read recovery merges earlier and newly dismissed sessions');

  await fixture(async ({ record, start, store, storeFile }) => {
    const file = record('a'), original = fs.readFileSync(file, 'utf8');
    const first = await start(); first.click('a'); await first.stop();
    fs.writeFileSync(file, '{');
    const second = await start(); await second.stop();
    fs.writeFileSync(file, original);
    assert.equal((await start()).rows().length, 0, 'temporary unreadable state cannot erase the acknowledgement');
    fs.writeFileSync(storeFile, JSON.stringify({ ...store(), dismissedSessions: { a: 'invalid', b: null } }));
    assert.equal((await start()).rows().length, 1, 'malformed saved timestamps cannot hide a session');
  });
  console.log('  ok temporary bad state files preserve acknowledgements; invalid storage values are ignored');
  console.log('dismiss-persistence-test: 5 passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
