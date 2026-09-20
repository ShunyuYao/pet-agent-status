'use strict';
// US-005: three interrupted Claude sessions must stay dismissed after a real host
// restart. State files, collector, panel, SDK storage and restart are production
// paths; only external sources/OS navigation use the hidden-host fixtures.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { start } = require('./hidden-host');

(async () => {
  let host;
  try {
    host = await start();
    console.log('  evidence:', host.paths.artifacts);
    const gone = spawnSync(process.execPath, ['-e', '']);
    assert.equal(gone.status, 0);
    assert.ok(gone.pid > 0);
    assert.throws(() => process.kill(gone.pid, 0), { code: 'ESRCH' });
    const ids = [1, 2, 3].map(i => `pet-as-test-dismiss-restart-${i}`);
    const control = 'pet-as-test-dismiss-untouched';
    const running = 'pet-as-test-dismiss-running';
    const waiting = 'pet-as-test-dismiss-waiting';
    const files = new Map();
    const record = (id, over = {}) => ({
      schema: 2, agent: 'claude-code', sessionId: id, cwd: '/tmp/dismiss-restart',
      project: id, tty: '/dev/ttys950', pid: gone.pid, state: 'running',
      lastEvent: 'Notification', ts: Date.now() - 30 * 60 * 60 * 1000, ...over
    });
    [...ids, control].forEach((id, i) => {
      const file = host.writeState(record(id, { tty: `/dev/ttys${950 + i}` }));
      files.set(file, fs.readFileSync(file, 'utf8'));
    });
    host.writeState(record(running, { tty: '/dev/ttys901', pid: process.pid, ts: Date.now() }));
    host.writeState(record(waiting, { tty: '/dev/ttys902', pid: process.pid, state: 'waiting', ts: Date.now() }));
    const rows = () => host.evaluate(`Array.from(document.querySelectorAll('.row'), el => ({
      id: el.dataset.sessionId, state: el.dataset.state,
      dismissible: el.classList.contains('can-dismiss'), cursor: getComputedStyle(el).cursor
    }))`);
    const click = id => host.evaluate(`document.querySelector('.row[data-session-id="${id}"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await host.waitFor(async () => (await rows()).length === 6, 'all fixture rows visible');
    for (const id of [...ids, control]) {
      const row = (await rows()).find(r => r.id === id);
      assert.equal(row.state, 'sync-paused', 'dead process + stale real state derives interrupted');
      assert.equal(row.dismissible, true, 'prove the click path exists');
      assert.equal(row.cursor, 'pointer');
    }
    for (const id of [running, waiting]) {
      const row = (await rows()).find(r => r.id === id);
      assert.equal(row.dismissible, false);
      assert.equal(row.cursor, 'pointer', 'live row can navigate');
      await click(id);
      assert.ok((await rows()).some(r => r.id === id), 'live sessions are never dismissed');
    }
    // Quick successive clicks must save all three acknowledgements.
    for (const id of ids) await click(id);
    await host.waitFor(async () => !(await rows()).some(r => ids.includes(r.id)), 'three interrupted rows dismissed');
    console.log('  ok three old interrupted sessions appear and disappear on click');
    await host.restart();
    const restored = await rows();
    assert.deepEqual(restored.filter(r => ids.includes(r.id)), [], 'dismissed interrupted sessions must not return after restarting the host');
    assert.equal(restored.find(r => r.id === control)?.state, 'sync-paused', 'untouched interrupted row survives restart (positive control)');
    assert.equal(restored.find(r => r.id === running)?.state, 'running');
    assert.equal(restored.find(r => r.id === waiting)?.state, 'waiting');
    for (const [file, original] of files) assert.equal(fs.readFileSync(file, 'utf8'), original, 'dismissal does not alter hook state files');
    console.log('  ok host restart preserves all three dismissals and retains untouched/live sessions');

    // A real subsequent hook event must bring the acknowledged session back.
    host.fireHook({ hook_event_name: 'UserPromptSubmit', session_id: ids[0], cwd: '/tmp/dismiss-restart', prompt: 'Resume regression fixture' });
    await host.waitFor(async () => (await rows()).find(r => r.id === ids[0])?.state === 'running', 'new hook event revives session');
    assert.equal((await rows()).filter(r => ids.slice(1).includes(r.id)).length, 0);
    await host.restart();
    assert.equal((await rows()).find(r => r.id === ids[0])?.state, 'running', 'revived session survives another restart');
    assert.equal((await rows()).filter(r => ids.slice(1).includes(r.id)).length, 0, 'other acknowledgements survive repeated restarts');
    assert.equal(host.errors.length, 0, JSON.stringify(host.errors));
    await host.screenshot(path.join(host.paths.artifacts, 'dismiss-restart.png'));
    console.log('  ok new hook activity revives only that session; repeated restart remains correct');
    console.log('dismiss-restart-e2e: passed; evidence:', host.paths.artifacts);
  } finally {
    if (host) await host.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
