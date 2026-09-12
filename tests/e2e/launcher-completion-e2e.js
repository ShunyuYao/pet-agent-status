'use strict';
// Real state files → production collector → hidden host SDK → panel click → OS command.
// OS commands are recorded at the execution boundary; no daily App is activated.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('./hidden-host');

let host, passed = 0;
const failures = [];
async function check(label, fn) {
  try { await fn(); passed++; console.log('  ✓', label); }
  catch (error) { failures.push({ label, error: error.message }); console.log('  ✗', label, error.message); }
}
const actions = () => fs.readFileSync(host.paths.actions, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const rows = () => host.evaluate("[...document.querySelectorAll('.row')].map(r=>({id:r.dataset.sessionId,state:r.dataset.state,jump:r.classList.contains('can-jump')}))");
const dot = (id) => host.evaluate(`!!document.querySelector('.app-btn.is-${id} .app-run-dot')`);
async function clickApp(id, onDot = false) {
  const before = actions().length;
  assert.strictEqual(await host.evaluate(`(() => {
    const b=document.querySelector('.app-btn.is-${id}');
    return !!b && !b.disabled && b.getBoundingClientRect().width > 0;
  })()`), true, 'launcher is an enabled visible button');
  await host.evaluate(`(() => {
    const b=document.querySelector('.app-btn.is-${id}');
    (${onDot} ? b.querySelector('.app-run-dot') || b : b).click();
  })()`);
  return host.waitFor(() => actions()[before], 'OS command after launcher click', 6000);
}
const waitRemoved = (id) => host.waitFor(async () => !(await rows()).some(r => r.id === id), 'dismiss ' + id, 5000);

(async () => {
  try {
    host = await start({ artifactDir: process.env.E2E_ARTIFACT_DIR });
    const at = Date.now();
    const record = (sessionId, patch) => ({ schema: 1, sessionId, agent: 'claude-code',
      cwd: '/tmp/launcher-e2e', project: sessionId, title: sessionId, pid: null,
      tty: '/dev/ttys901', state: 'done', lastEvent: 'Stop', ts: at - 3000, ...patch });
    const first = record('claude-first', { tty: '/dev/ttys901', ts: at - 1000 });
    const second = record('claude-second', { tty: '/dev/ttys902', ts: at - 2000 });
    const active = record('claude-running', { tty: '/dev/ttys903', state: 'running', ts: at, lastEvent: 'UserPromptSubmit' });
    const threadId = '11111111-2222-4333-8444-555555555555';
    const codex = record('codex-done', { agent: 'codex', form: 'app', tty: null, threadId });
    for (const r of [second, active, codex, first]) host.writeState(r);
    await host.waitFor(async () => (await rows()).length === 4, 'all four real collected rows');
    assert.ok((await rows()).every(r => r.jump), 'positive control: all fixture rows can actually navigate');
    await host.screenshot(path.join(host.paths.artifacts, 'before-click.png'));
    await check('只有已完成会话的 Codex 也有绿点', async () => assert.strictEqual(await dot('codex'), true));
    await check('Claude 多条完成会话共用一个绿点', async () => assert.strictEqual(await dot('claude'), true));

    const action1 = await clickApp('claude', true);
    await check('点 Claude 绿点定位列表第一条已完成 CLI 的 iTerm 标签', () => {
      assert.strictEqual(action1.command, 'osascript');
      assert.ok(action1.args[1].includes('tell application "iTerm2"'));
      assert.ok(action1.args[1].includes('tty of s is "/dev/ttys901"'));
    });
    await check('第一次点击只收起第一条完成会话', async () => {
      await waitRemoved(first.sessionId);
      assert.deepStrictEqual((await rows()).map(r => r.id).sort(), [active.sessionId, second.sessionId, codex.sessionId].sort());
    });
    await check('还有第二条完成会话时 Claude 绿点保留', async () => assert.strictEqual(await dot('claude'), true));
    const action2 = await clickApp('claude');
    await check('再次点击图标定位第二条完成会话', () => {
      assert.strictEqual(action2.command, 'osascript');
      assert.ok(action2.args[1].includes('tty of s is "/dev/ttys902"'));
    });
    await check('完成会话全部点掉后绿点消失，运行中会话仍在', async () => {
      await waitRemoved(second.sessionId);
      await host.waitFor(async () => !(await dot('claude')), 'completion dot cleared', 5000);
      assert.ok((await rows()).some(r => r.id === active.sessionId && r.state === 'running'));
      assert.strictEqual(await dot('codex'), true, 'another agent completion is untouched');
    });
    // Finish the independent App path even when CLI assertions fail in a reproduction run.
    const action3 = await clickApp('codex', true);
    await check('Codex App 完成项使用具体线程深链接', () => assert.deepStrictEqual(action3,
      { at: action3.at, command: 'open', args: ['codex://threads/' + threadId] }));
    await check('App 完成项点击后行和绿点同步清除', async () => {
      await waitRemoved(codex.sessionId);
      await host.waitFor(async () => !(await dot('codex')), 'App dot cleared', 5000);
    });
    if (!failures.length) {
      const normalOpen = await clickApp('claude');
      await check('无完成项时仍可正常打开 Claude App', () => assert.deepStrictEqual(normalOpen.args, ['-b', 'com.anthropic.claudefordesktop']));
      // Real later status event: the same session becomes unread again.
      host.writeState({ ...first, ts: Date.now() });
      await host.waitFor(async () => (await rows()).some(r => r.id === first.sessionId) && await dot('claude'), 'new completion reappears');
      await host.evaluate("document.querySelector('.row[data-session-id=\"claude-first\"]').click()");
      await check('新完成事件重新亮点，直接点击会话行也能清掉底栏绿点', async () => {
        await waitRemoved(first.sessionId);
        await host.waitFor(async () => !(await dot('claude')), 'row click cleared dot', 5000);
      });
    }
    await host.screenshot(path.join(host.paths.artifacts, 'after-clicks.png'));
    await check('真实宿主无未处理异常', () => {
      assert.deepStrictEqual(host.errors, []);
      assert.ok(!/TypeError|Uncaught|Unhandled/.test(fs.readFileSync(host.paths.log, 'utf8')));
    });
    fs.writeFileSync(path.join(host.paths.artifacts, 'results.json'), JSON.stringify({ passed, failures }, null, 2));
    console.log('  证据:', host.paths.artifacts);
  } catch (error) { failures.push({ label: 'E2E', error: error.stack }); console.error(error); }
  finally { if (host) await host.stop(); }
  console.log(`launcher-completion-e2e: ${passed} 通过 / ${failures.length} 失败`);
  process.exitCode = failures.length ? 1 : 0;
})();
