'use strict';
// 真宿主 E2E：按落点过滤：点不进去的后台会话不显示（2026-09-12 用户拍板）。
// 离线单测证明了推导；这里证明**真宿主里**：Ralph 形态（无 tty、无 App 归属）整行不见，
// 而无 tty 但有 App 落点的会话（Claude App 元数据归属成立）仍然在、且可点。
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
  const appSupport = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-ccd-'));
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
        PET_AS_CLAUDE_APP_SUPPORT: appSupport,
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

    const now = Date.now();
    // ① Ralph 形态：无 tty、不属于任何 App —— 一个落点都没有
    fs.writeFileSync(path.join(stateDir, 'pet-as-test-ralph.json'), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: 'pet-as-test-ralph', cwd: '/repo', project: 'repo',
      tty: null, pid: process.pid, state: 'running', lastEvent: 'PreToolUse', ts: now, since: now }));
    // ② Claude App 会话：同样无 tty，但 App 元数据能证明归属 → 可激活 App，有落点
    const appSid = 'pet-as-test-ccapp';
    const orgDir = path.join(appSupport, 'claude-code-sessions', 'acct-e2e', 'org-e2e');
    fs.mkdirSync(orgDir, { recursive: true });
    fs.writeFileSync(path.join(orgDir, 'local_e2e.json'), JSON.stringify({
      sessionId: 'local_e2e', cliSessionId: appSid, cwd: '/tmp/app', title: 'E2E App 会话',
      titleSource: 'auto', createdAt: now, lastActivityAt: now }));
    fs.writeFileSync(path.join(stateDir, `${appSid}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: appSid, cwd: '/tmp/app', project: 'app',
      tty: null, pid: null, state: 'running', lastEvent: 'PreToolUse', ts: now, since: now }));
    // ③ 普通终端会话：对照组，必须在
    fs.writeFileSync(path.join(stateDir, 'pet-as-test-term.json'), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: 'pet-as-test-term', cwd: '/tmp/t', project: 't',
      tty: '/dev/ttys901', pid: process.pid, state: 'running', lastEvent: 'PreToolUse', ts: now, since: now }));

    await evalIn(settings, "await window.settings.pluginsTogglePanel('pet-agent-status'); return 1;");
    const panel = await waitFor(() => findTarget('pet-agent-status/panel/panel.html'), '插件面板打开');
    await waitFor(async () => await evalIn(panel,
      "return document.querySelector('.row[data-session-id=\"pet-as-test-term\"]') ? 1 : null"), '终端会话渲染出来');
    await sleep(2500);   // 再等一轮 tick，确保不是"还没来得及画"

    const shown = JSON.parse(await evalIn(panel,
      "return JSON.stringify(Array.from(document.querySelectorAll('.row')).map(el=>el.dataset.sessionId));"));
    ok(shown.includes('pet-as-test-term'), '普通终端会话在面板上', JSON.stringify(shown));
    ok(!shown.includes('pet-as-test-ralph'),
      'Ralph 形态（无 tty 无 App 归属）不显示——点了不会有任何反应', JSON.stringify(shown));
    ok(shown.includes(appSid),
      'Claude App 会话虽无 tty 但有落点（可激活 App），必须保留', JSON.stringify(shown));

    const appRow = JSON.parse(await evalIn(panel, `
      const el = document.querySelector('.row[data-session-id="${appSid}"]');
      return JSON.stringify({ cursor: el ? getComputedStyle(el).cursor : null, txt: el ? el.textContent : '' });`));
    ok(/pointer/.test(String(appRow.cursor)), 'App 会话仍是可点态', String(appRow.cursor));

    // 0.12.0 起底栏换成了 App 启动器，说明改挂列表下方的 #hidden-note（只在真藏了东西时出现）
    const note = JSON.parse(await evalIn(panel, `
      const el = document.getElementById('hidden-note');
      return JSON.stringify({ hidden: el ? el.hidden : null, txt: el ? el.textContent : null });`));
    ok(note.hidden === false && /1/.test(String(note.txt)) && /后台|hidden/i.test(String(note.txt)),
      '如实说明隐藏了 1 条（不让会话凭空消失）', JSON.stringify(note));

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-300));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const d of [userData, stateDir, appSupport]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 尽力 */ } }
  }
  console.log(`\nno-target-filter-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
