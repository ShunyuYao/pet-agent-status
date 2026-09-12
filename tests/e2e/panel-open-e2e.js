'use strict';
// US-004：首帧快照与普通徽标开合。隐藏实例；不覆盖原生窗口失焦。
// E2E_REPRO=1 保留修复前证据（不把已复现的失败算作通过）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_CDP_PORT || 9345);
const repro = process.env.E2E_REPRO === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
  catch (_) { return []; }
}
async function target(part) {
  return (await targets()).find(t => t.type === 'page' && decodeURIComponent(t.url).includes(part));
}
async function waitFor(fn, label, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}
async function command(t, method, params = {}) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 超时：${method}`)), 10000);
      ws.onmessage = event => {
        const msg = JSON.parse(event.data);
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error || msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg)));
        else resolve(msg.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { ws.close(); }
}
async function evaluate(t, body) {
  const r = await command(t, 'Runtime.evaluate', {
    expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true,
  });
  return r.result.value;
}
const panelTarget = () => target('pet-agent-status/panel/panel.html');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-open-e2e-'));
  const userData = path.join(temp, 'profile');
  const stateDir = path.join(temp, 'state');
  fs.mkdirSync(userData); fs.mkdirSync(stateDir);
  const mf = require(path.join(ROOT, 'manifest.json'));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ plugins: { grants: {
    [mf.id]: { granted: mf.permissions, version: mf.version, at: Date.now() },
  } } }));
  const sid = 'panel-open-fixture';
  const fixture = { schema: 1, agent: 'codex', sessionId: sid, cwd: '', project: 'Open panel fixture',
    tty: null, pid: null, state: 'running', lastEvent: 'ipc:activity', ts: Date.now(), since: Date.now(),
    threadId: '01a08a1d-4f63-7e30-af03-48ae77b414b5', form: 'app', source: 'ipc' };
  fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify(fixture));
  let app; let log = '';
  try {
    app = spawn('npx', ['--no-install', 'electron', '.', `--remote-debugging-port=${PORT}`], {
      cwd: path.join(HOST, 'demo'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PET_USERDATA_DIR: userData, PET_AGENT_STATUS_DIR: stateDir,
        PET_AS_CLAUDE_SETTINGS: path.join(temp, 'claude-settings.json'),
        PET_AS_CODEX_HOOKS: path.join(temp, 'codex', 'hooks.json'), CODEX_HOME: path.join(temp, 'codex'),
        PET_AS_CLAUDE_APP_SUPPORT: path.join(temp, 'claude-app'), PET_AS_WORKBUDDY_HOME: path.join(temp, 'workbuddy'),
        PET_E2E_TEST: '1', PET_E2E_BACKGROUND: '1', PET_E2E_HIDDEN: '1' },
    });
    app.stdout.on('data', d => { log += d; }); app.stderr.on('data', d => { log += d; });
    const pet = await waitFor(() => target('demo/index.html'), '宠物 renderer');
    await evaluate(pet, "window.petAPI.openSettings('plugins');");
    const settings = await waitFor(() => target('settings.html'), '设置窗');
    const installed = await evaluate(settings, `return await window.settings.pluginsInstallPath(${JSON.stringify(ROOT)});`);
    assert.equal(installed.ok, true, JSON.stringify(installed));
    await waitFor(async () => (await evaluate(settings, 'return await window.settings.pluginsList();'))
      .some(p => p.id === mf.id && p.status === 'active'), '插件激活');
    // 先证明真实的徽标入口可交互，再点 DOM；不直接调用 onBadgeClick 或内部状态。
    const overlay = await waitFor(() => target('pet-overlay.html'), '徽标浮层');
    const badgeSelector = 'button.agent-badge--clickable';

    const clickBadge = async () => evaluate(overlay, `
      const el = document.querySelector(${JSON.stringify(badgeSelector)});
      if (!el || el.disabled || getComputedStyle(el).display === 'none') throw new Error('徽标不可交互');
      el.click();`);
    await waitFor(async () => evaluate(overlay, `return !!document.querySelector(${JSON.stringify(badgeSelector)});`), '徽标入口');
    await sleep(1500);
    await clickBadge();
    let panel = await waitFor(panelTarget, '首开面板');
    await waitFor(() => evaluate(panel, `return !!document.querySelector('[data-session-id="${sid}"]');`), '首次会话渲染');
    // 同一目标正向对照：窗口没失焦时，再点确实关闭，证明按钮/测试路径本身通着。
    await clickBadge();
    await waitFor(async () => !(await panelTarget()), '无失焦时再次点击关闭');
    console.log('PASS：无焦点切换时，徽标开/关链路通畅');

    // 刚收到下一轮推送时关窗重开，使旧实现确定落在轮询空档，避免随机相位假绿。
    await clickBadge(); panel = await waitFor(panelTarget, '重新打开');
    await waitFor(() => evaluate(panel, "return document.readyState === 'complete' && !!window.pet;"), '快照订阅前文档就绪');
    await evaluate(panel, `return new Promise(resolve => window.pet.events.on('agent-status:snapshot', resolve));`);
    await evaluate(panel, "document.getElementById('close').click();");
    await waitFor(async () => !(await panelTarget()), '关闭按钮');
    const start = Date.now();
    await clickBadge(); panel = await waitFor(panelTarget, '计时打开');
    await waitFor(() => evaluate(panel, "return document.readyState === 'complete' && !!document.getElementById('empty');"), '面板文档加载');
    const initial = await evaluate(panel, `return {rows:document.querySelectorAll('.row').length,empty:!document.getElementById('empty').hidden};`);
    await waitFor(() => evaluate(panel, `return !!document.querySelector('[data-session-id="${sid}"]');`), '会话首帧');
    const elapsed = Date.now() - start;
    console.log('MEASURE：打开→会话显示', elapsed, 'ms；首次 DOM', JSON.stringify(initial));
    if (!repro) assert(elapsed < 700, `首帧 ${elapsed}ms，仍在等待轮询`);

    if (process.env.E2E_SCREENSHOT) {
      panel = await panelTarget();
      if (panel) {
        const shot = await command(panel, 'Page.captureScreenshot');
        fs.writeFileSync(process.env.E2E_SCREENSHOT, Buffer.from(shot.data, 'base64'));
      }
    }
    console.log(repro ? 'REPRO：以上为修复前实测证据' : 'panel-open-e2e: PASS');
  } catch (err) {
    console.error(err.stack || err); console.error(log.slice(-2000)); process.exitCode = 1;
  } finally {
    if (app?.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
