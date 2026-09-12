'use strict';
// Offline launcher regression: real status files and panel intent events, with
// only external data sources and OS execution isolated. Assert snapshots/scripts.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tool = require('../tool');
const { createAppLauncher } = require('../lib/app-launcher');
const { writeStatus } = require('../lib/state-files');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-launcher-test-'));
  const handlers = new Map(), received = new Map(), scripts = [], commands = [];
  let at = Date.now(), failJump = true, collector;
  const pet = {
    storage: { get: async () => false },
    scheduler: { every: async () => 'fixture', cancel: async () => {} },
    events: { on: (name, fn) => handlers.set(name, fn), emit: (name, data) => received.set(name, data) }
  };
  const execFile = (command, args) => { commands.push({ command, args }); };
  const snapshot = () => received.get(tool.SNAPSHOT_EVENT);
  const pending = (id) => received.get(tool.APPS_EVENT).apps.find(a => a.id === id).pendingDone;
  const click = (appId) => handlers.get(tool.OPEN_APP_EVENT)({ appId });
  const record = (id, patch = {}) => ({ sessionId: id, agent: 'claude-code', cwd: '/tmp/launcher',
    tty: '/dev/ttys901', pid: null, state: 'done', lastEvent: 'Stop', ts: at - 2000, ...patch });
  try {
    collector = tool.createCollector({
      dir, now: () => at, isPidAlive: () => true,
      settingsFile: path.join(dir, 'claude-settings.fixture'), codexHooksFile: path.join(dir, 'codex-hooks.fixture'),
      threadTitles: { lookup: () => null }, terminalTitles: { lookup: () => null },
      claudeDesktop: { lookupTitle: () => null, has: () => false },
      rolloutActivity: { activeThreads: () => new Map() }, workbuddySource: { tick() {} },
      psTree: [{ pid: 1, ppid: 0, tty: 'ttys901', comm: '/Applications/iTerm.app/Contents/MacOS/iTerm2' }],
      jumpRunner: (script) => { scripts.push(script); return failJump ? { ok: false, reason: 'fixture execution failure' } : { ok: true }; },
      execFile, createAppLauncher: () => createAppLauncher({ probe: () => '/fixture/app', execFile })
    });
    const done = record('done');
    writeStatus(done, dir);
    await collector.start(pet);
    assert.ok(snapshot().rows[0].canJump, 'positive control: target has a navigable terminal');
    assert.strictEqual(pending('claude'), 1);
    click('claude');
    assert.ok(scripts.at(-1).includes('tty of s is "/dev/ttys901"'));
    assert.strictEqual(commands.length, 0, 'failed CLI jump must never fall back to desktop App');
    assert.strictEqual(snapshot().rows.length, 1, 'execution failure retains the completion');
    assert.ok(snapshot().rows[0].jumpError.includes('fixture execution failure'));
    assert.strictEqual(pending('claude'), 1, 'execution failure retains the green dot');
    failJump = false;
    click('claude');
    assert.strictEqual(snapshot().rows.length, 0, 'retry success dismisses the completion');
    assert.strictEqual(pending('claude'), 0);
    console.log('  ✓ 跳转失败保留行、错误与绿点；重试成功后一并清除');

    // Status changes between scheduler ticks: a click must use the current file.
    at += 1000;
    writeStatus({ ...done, ts: at }, dir);
    click('claude');
    assert.strictEqual(snapshot().rows.length, 0, 'new completion is picked without waiting for a scheduled tick');
    assert.strictEqual(commands.length, 0);
    at += 1000;
    writeStatus({ ...done, ts: at, state: 'running' }, dir);
    click('claude');
    assert.strictEqual(snapshot().rows[0].state, 'running', 'resumed task is not dismissed');
    assert.strictEqual(pending('claude'), 0);
    assert.deepStrictEqual(commands.at(-1), { command: 'open', args: ['-b', 'com.anthropic.claudefordesktop'] });
    console.log('  ✓ 点击使用最新状态；继续运行的会话不会被误收起');

    const buddy = '11111111-2222-4333-8444-666666666666';
    writeStatus(record(buddy, { agent: 'workbuddy', form: 'app', tty: null, ts: at }), dir);
    click('workbuddy');
    assert.deepStrictEqual(commands.at(-1), { command: 'open', args: ['workbuddy://chat/' + buddy] });
    assert.strictEqual(pending('workbuddy'), 0);
    assert.deepStrictEqual(snapshot().rows.map(r => r.sessionId), ['done'], 'other agent running row remains');
    console.log('  ✓ WorkBuddy 完成项使用具体会话深链接，互不影响其他厂牌');

    // Codex CLI may have a threadId; tty still determines the target.
    at += 1000;
    writeStatus({ ...done, agent: 'codex', form: 'cli', threadId: buddy, ts: at }, dir);
    const commandsBefore = commands.length;
    click('codex');
    assert.ok(scripts.at(-1).includes('tty of s is "/dev/ttys901"'));
    assert.strictEqual(commands.length, commandsBefore, 'CLI threadId must not cause a deep link');
    assert.strictEqual(pending('codex'), 0);
    assert.strictEqual(snapshot().rows.length, 0);
    console.log('  ✓ Codex CLI 即使带 threadId 也返回真实终端');
    const before = [scripts.length, commands.length];
    for (const id of [null, '', 'toString', '../../evil', 'com.evil.app']) click(id);
    assert.deepStrictEqual([scripts.length, commands.length], before);
    console.log('  ✓ 未知厂牌不能发起外部跳转');
    console.log('launcher-completion-test: 5 passed');
  } finally {
    if (collector) await collector.stop(pet);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
