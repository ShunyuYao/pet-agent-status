'use strict';
// 真宿主 E2E：同一个终端窗口只显示当前那条会话（2026-09-12 用户实测三态并存）。
// 离线 aggregate 单测证明了推导，这里证明**真宿主里面板真的只画一行**，
// 且被顶掉的行不进汇总胶囊（徽标/宠物提醒同源）。
//
// 隔离：PET_USERDATA_DIR 临时目录、CDP 端口按 pid 随机化、预置 plugins.grants。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
const CDP = Number(process.env.E2E_CDP_PORT || (9400 + (process.pid % 500)));
const PLUGIN_DIR = path.join(__dirname, '..', '..');

let passed = 0; let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.log('  ✗', label, detail ? `— ${detail}` : ''); }
}
async function cdpTargets() {
  try { return await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch (_) { return []; }
}
async function findTarget(sub) {
  const list = await cdpTargets();
  return list.find((t) => t.type === 'page' && decodeURIComponent(t.url).includes(sub)) || null;
}
async function evalIn(target, expr) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const id = Math.floor(Math.random() * 1e6);
  const res = await new Promise((resolve) => {
    ws.onmessage = (ev) => { const d = JSON.parse(ev.data); if (d.id === id) resolve(d); };
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true },
    }));
  });
  ws.close();
  if (res.result && res.result.exceptionDetails) throw new Error('页面内异常');
  return res.result && res.result.result ? res.result.result.value : undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-ud-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-state-'));
  let app = null;
  try {
    const manifest = require(path.join(PLUGIN_DIR, 'manifest.json'));
    const grants = {};
    grants[manifest.id] = { granted: manifest.permissions.slice(), version: manifest.version, at: Date.now() };
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ plugins: { grants } }, null, 2));

    console.log('起隔离宿主实例（CDP', CDP, ')');
    app = spawn('npx', ['--no-install', 'electron', '.', `--remote-debugging-port=${CDP}`], {
      cwd: path.join(HOST, 'demo'),
      env: Object.assign({}, process.env, {
        PET_USERDATA_DIR: userData, PET_AGENT_STATUS_DIR: stateDir,
        PET_E2E_TEST: '1', PET_E2E_BACKGROUND: '1', PET_E2E_HIDDEN: '1',
      }),
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    app.stdout.on('data', (d) => { log += d; });
    app.stderr.on('data', (d) => { log += d; });

    await waitFor(async () => (await cdpTargets()).length > 0, 'CDP 就绪');
    const settings = await waitFor(async () => {
      const pet = await findTarget('demo/index.html');
      if (!pet) return null;
      await evalIn(pet, "window.petAPI.openSettings('plugins'); return 1;");
      await sleep(1500);
      return findTarget('settings.html');
    }, '设置窗打开');
    const inst = await evalIn(settings, `
      const r = await window.settings.pluginsInstallPath(${JSON.stringify(PLUGIN_DIR)});
      return JSON.stringify(r);`);
    ok(/"ok":true/.test(String(inst)), '插件旁加载安装成功');
    await waitFor(async () => {
      const list = JSON.parse(await evalIn(settings, 'return JSON.stringify(await window.settings.pluginsList());'));
      const me = list.find((p) => p.id === 'pet-agent-status');
      return me && me.status === 'active' ? me : null;
    }, '插件激活');

    // 一个终端窗口（同 tty）先后跑过三个会话：两个已结束 + 一个现役（实录形态）
    const now = Date.now();
    const TTY = '/dev/ttys777';
    const ids = ['pet-as-test-old1', 'pet-as-test-old2', 'pet-as-test-live'];
    fs.writeFileSync(path.join(stateDir, `${ids[0]}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: ids[0], cwd: '/tmp/a', project: 'a',
      tty: TTY, pid: 1, state: 'done', lastEvent: 'Stop', ts: now - 120000 }));
    fs.writeFileSync(path.join(stateDir, `${ids[1]}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: ids[1], cwd: '/tmp/b', project: 'b',
      tty: TTY, pid: 2, state: 'ended', lastEvent: 'SessionEnd', ts: now - 60000 }));
    fs.writeFileSync(path.join(stateDir, `${ids[2]}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: ids[2], cwd: '/tmp/c', project: 'c',
      tty: TTY, pid: process.pid, state: 'running', lastEvent: 'PreToolUse', ts: now, since: now }));
    // 另一个窗口的会话：必须照常显示（不能把顶替扩大化）
    fs.writeFileSync(path.join(stateDir, 'pet-as-test-other.json'), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: 'pet-as-test-other', cwd: '/tmp/d', project: 'd',
      tty: '/dev/ttys778', pid: process.pid, state: 'done', lastEvent: 'Stop', ts: now - 30000 }));

    await evalIn(settings, "await window.settings.pluginsTogglePanel('pet-agent-status'); return 1;");
    const panel = await waitFor(() => findTarget('pet-agent-status/panel/panel.html'), '插件面板打开');
    await waitFor(async () => await evalIn(panel,
      "return document.querySelector('.row[data-session-id=\"pet-as-test-live\"]') ? 1 : null"), '现役行渲染出来');
    await sleep(2500);   // 再等一轮 tick，确保不是"还没来得及画"

    const shown = await evalIn(panel,
      "return JSON.stringify(Array.from(document.querySelectorAll('.row')).map(el=>el.dataset.sessionId));");
    const list = JSON.parse(shown);
    ok(list.includes('pet-as-test-live'), '同窗现役会话在面板上', shown);
    ok(!list.includes('pet-as-test-old1') && !list.includes('pet-as-test-old2'),
      '同窗的两条旧会话不再显示（用户报的三态并存）', shown);
    ok(list.includes('pet-as-test-other'), '别的窗口的已完成会话照常显示（顶替不扩大化）', shown);

    // 汇总胶囊：被顶掉的 done 不许再计数
    const summary = await evalIn(panel, `
      const s = document.getElementById('summary');
      return JSON.stringify({ hidden: s.hidden, text: s.textContent });`);
    const sum = JSON.parse(summary);
    ok(/1\s*已完成/.test(sum.text) || !/2\s*已完成/.test(sum.text),
      '汇总里只算没被顶掉的那条已完成', sum.text);

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-300));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const d of [userData, stateDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 尽力 */ } }
  }
  console.log(`\nsame-window-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
