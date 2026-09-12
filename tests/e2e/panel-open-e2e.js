'use strict';
// US-004: real overlay badge open/close and immediate first snapshot replay.
// Shared hidden-host keeps the actual collector, panel, SDK and IPC bridge intact;
// external App/session sources and OS execution alone use isolated fixtures.
// E2E_REPRO=1 records pre-fix timing without presenting a reproduced failure as PASS.
// Native window focus/mouse passthrough are outside this hidden DOM-intent test.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('./hidden-host');

const repro = process.env.E2E_REPRO === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}

(async () => {
  let host, panel;
  try {
    host = await start();
    const evaluate = (target, body) => host.evaluate(`(async()=>{${body}})()`, target);
    const panelTarget = () => host.findTarget('pet-agent-status/panel/panel.html');
    const sid = 'panel-open-fixture';
    const now = Date.now();
    host.writeState({
      schema: 1, agent: 'codex', sessionId: sid, cwd: '', project: 'Open panel fixture',
      tty: null, pid: null, state: 'running', lastEvent: 'ipc:activity', ts: now, since: now,
      threadId: '01a08a1d-4f63-7e30-af03-48ae77b414b5', form: 'app', source: 'ipc'
    });
    // start() opens a panel for fixture readiness. Seed and positively observe the
    // real collector first, then close it so badge first-open remains a real input.
    panel = host.panel;
    await waitFor(() => evaluate(panel, `return !!document.querySelector('[data-session-id="${sid}"]');`), '隔离样本已渲染');
    await evaluate(panel, "document.getElementById('close').click();");
    await waitFor(async () => !(await panelTarget()), '关闭 helper 预开面板');

    const overlay = await waitFor(() => host.findTarget('pet-overlay.html'), '徽标浮层');
    const badgeSelector = 'button.agent-badge--clickable';
    const clickBadge = () => evaluate(overlay, `
      const el = document.querySelector(${JSON.stringify(badgeSelector)});
      if (!el || el.disabled || getComputedStyle(el).display === 'none') throw new Error('徽标不可交互');
      el.click();`);
    await waitFor(() => evaluate(overlay, `return !!document.querySelector(${JSON.stringify(badgeSelector)});`), '徽标入口');
    await sleep(1500);
    await clickBadge();
    panel = await waitFor(panelTarget, '徽标首开面板');
    await waitFor(() => evaluate(panel, `return !!document.querySelector('[data-session-id="${sid}"]');`), '首次会话渲染');
    await clickBadge();
    await waitFor(async () => !(await panelTarget()), '无失焦时再次点击关闭');
    console.log('PASS：无焦点切换时，真实徽标开/关链路通畅');

    // Reopen immediately after a periodic production snapshot: the old implementation
    // must then wait almost a whole polling interval, preventing random-phase passes.
    await clickBadge();
    panel = await waitFor(panelTarget, '重新打开');
    await waitFor(() => evaluate(panel, "return document.readyState === 'complete' && !!window.pet;"), '快照订阅前文档就绪');
    await evaluate(panel, "return new Promise(resolve => window.pet.events.on('agent-status:snapshot', resolve));");
    await evaluate(panel, "document.getElementById('close').click();");
    await waitFor(async () => !(await panelTarget()), '关闭按钮');
    const openedAt = Date.now();
    await clickBadge();
    panel = await waitFor(panelTarget, '计时打开');
    await waitFor(() => evaluate(panel, "return document.readyState === 'complete' && !!document.getElementById('empty');"), '面板文档加载');
    const initial = await evaluate(panel, "return {rows:document.querySelectorAll('.row').length,empty:!document.getElementById('empty').hidden};");
    await waitFor(() => evaluate(panel, `return !!document.querySelector('[data-session-id="${sid}"]');`), '会话首帧');
    const elapsed = Date.now() - openedAt;
    console.log('MEASURE：打开→会话显示', elapsed, 'ms；首次 DOM', JSON.stringify(initial));
    fs.writeFileSync(path.join(host.paths.artifacts, 'panel-open-timing.json'), JSON.stringify({ mode: repro ? 'repro' : 'acceptance', elapsed, limit: 700, withinLimit: elapsed < 700, initial }, null, 2));
    await host.screenshot(process.env.E2E_SCREENSHOT || path.join(host.paths.artifacts, 'panel.png'), panel);
    assert.equal(host.errors.length, 0, JSON.stringify(host.errors));
    if (!repro) assert(elapsed < 700, `首帧 ${elapsed}ms，仍在等待轮询`);
    console.log('证据:', host.paths.artifacts);
    console.log(repro ? 'REPRO：以上为实测证据，不作为首帧门禁通过' : 'panel-open-e2e: PASS');
  } catch (error) {
    console.error(error.stack || error);
    if (host) {
      console.error(fs.readFileSync(host.paths.log, 'utf8').slice(-2000));
      if (panel) {
        try { await host.screenshot(path.join(host.paths.artifacts, 'failure.png'), panel); }
        catch (captureError) { console.error('失败截图不可用:', captureError.message); }
      }
      console.error('证据:', host.paths.artifacts);
    }
    process.exitCode = 1;
  } finally {
    if (host) await host.stop();
  }
})();
