'use strict';
// 真宿主 E2E：2026-09-12 用户对照 Figma 指出的三处不一致。
//
// 离线 jsdom 没有布局引擎（getBoundingClientRect 恒 0），"两个钮一样大"只能在真宿主里量；
// "点空白处自动关闭"更是宿主窗口行为（runtime.js 的 blur 分支），离线证明不了。
//
// 隔离：PET_USERDATA_DIR 临时目录、CDP 端口按 pid 随机化、预置 plugins.grants。
// 不点像素：交互一律经 CDP 在 renderer 里执行 JS；失焦用 CDP 在**另一个窗口**抢焦点触发。
//
// 跑法：node tests/e2e/ui-parity-e2e.js
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
  if (res.result && res.result.exceptionDetails) {
    throw new Error('页面内异常: ' + JSON.stringify(res.result.exceptionDetails).slice(0, 300));
  }
  return res.result && res.result.result ? res.result.result.value : undefined;
}
// 把某个页面提到最前（真实窗口焦点变化，用于驱动另一个窗口的 blur）
async function bringToFront(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ id: 1, method: 'Page.bringToFront' }));
  await new Promise((r) => setTimeout(r, 800));
  ws.close();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 还没就绪 */ }
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
        PET_USERDATA_DIR: userData,
        PET_AGENT_STATUS_DIR: stateDir,
        // 失焦关闭这条必须有真实窗口焦点：PET_E2E_HIDDEN 下窗口根本不显示，
        // 不存在"点到面板以外"这回事，blur 永不触发（实测 15/1 时的那条红）。
        // 故本用例**刻意可见**（E2E_VISIBLE=1 时），其余用例仍守隐藏窗纪律。
        PET_E2E_TEST: '1',
        ...(process.env.E2E_VISIBLE === '1' ? {} : { PET_E2E_BACKGROUND: '1', PET_E2E_HIDDEN: '1' }),
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
    ok(/"ok":true/.test(String(inst)), '插件旁加载安装成功', String(inst).slice(0, 120));
    await waitFor(async () => {
      const list = JSON.parse(await evalIn(settings, 'return JSON.stringify(await window.settings.pluginsList());'));
      const me = list.find((p) => p.id === 'pet-agent-status');
      return me && me.status === 'active' ? me : null;
    }, '插件激活');

    const now = Date.now();
    fs.writeFileSync(path.join(stateDir, `pet-as-test-cli-${now}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: `pet-as-test-cli-${now}`, cwd: '/tmp/cli-proj',
      project: 'cli-proj', tty: '/dev/ttys001', pid: process.pid, state: 'running',
      lastEvent: 'PreToolUse', ts: now, since: now,
    }));
    fs.writeFileSync(path.join(stateDir, `pet-as-test-app-${now}.json`), JSON.stringify({
      schema: 1, agent: 'codex', sessionId: `pet-as-test-app-${now}`, cwd: '', project: 'Codex App',
      tty: null, pid: null, state: 'running', lastEvent: 'ipc:activity', ts: now, since: now,
      threadId: '01a08a1d-4f63-7e30-af03-48ae77b414b5', form: 'app', source: 'ipc',
    }));

    await evalIn(settings, "await window.settings.pluginsTogglePanel('pet-agent-status'); return 1;");
    const panel = await waitFor(() => findTarget('pet-agent-status/panel/panel.html'), '插件面板打开');
    await waitFor(async () => await evalIn(panel, "return document.querySelectorAll('.row').length >= 2 ? 1 : null;"),
      '两条行都渲染出来');

    // ---- 1. ⚙ 与 ✕ 真实渲染尺寸一致（离线 jsdom 量不出来，这才是用户看到的那一层）----
    const btns = JSON.parse(await evalIn(panel, `
      const box = (el) => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
      const g = document.getElementById('gear'), c = document.getElementById('close');
      return JSON.stringify({
        gear: box(g), close: box(c),
        gearIcon: box(g.querySelector('svg')), closeIcon: box(c.querySelector('svg')),
        gearColor: getComputedStyle(g).color, closeColor: getComputedStyle(c).color,
      });`));
    ok(btns.gear.w === btns.close.w && btns.gear.h === btns.close.h,
      `两个头部钮命中区同尺寸（${btns.gear.w}×${btns.gear.h}）`, JSON.stringify(btns));
    ok(btns.gearIcon.w === btns.closeIcon.w && btns.gearIcon.h === btns.closeIcon.h,
      `两个图标同尺寸（${btns.gearIcon.w}×${btns.gearIcon.h}）`, JSON.stringify(btns));
    ok(Math.abs(btns.gearIcon.w - 13) < 0.6, '图标尺寸对齐设计稿 13px', String(btns.gearIcon.w));
    ok(btns.gearColor === btns.closeColor, '两个钮同色', `${btns.gearColor} vs ${btns.closeColor}`);

    // ---- 2. App 形态角标是窗口图形，几何对齐设计稿（Figma 7:25）----
    const badge = JSON.parse(await evalIn(panel, `
      const app = document.querySelector('.form-badge[data-form="app"]');
      const cli = document.querySelector('.form-badge[data-form="cli"]');
      if (!app || !cli) return JSON.stringify({ missing: true });
      const fr = app.querySelector('.win-frame'), bar = app.querySelector('.win-bar');
      const cs = getComputedStyle(app), fs2 = getComputedStyle(fr), bs = getComputedStyle(bar);
      const box = (el) => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
      return JSON.stringify({
        appText: app.textContent, cliText: cli.textContent,
        appBox: box(app), frame: box(fr), bar: box(bar),
        radius: cs.borderTopLeftRadius, ring: cs.boxShadow, bg: cs.backgroundColor,
        frameBorder: fs2.borderTopColor, barBg: bs.backgroundColor,
      });`));
    ok(!badge.missing, 'CLI 与 App 两种角标都渲染出来了');
    ok(badge.appText === '', 'App 角标不再是字符占位', JSON.stringify(badge.appText));
    ok(badge.cliText === '>_', 'CLI 角标保持设计稿的 >_', badge.cliText);
    ok(Math.abs(badge.frame.w - 7) < 0.8 && Math.abs(badge.frame.h - 5.5) < 0.8,
      `窗口外框 ≈7×5.5（实测 ${badge.frame.w}×${badge.frame.h}）`, JSON.stringify(badge.frame));
    ok(Math.abs(badge.bar.h - 1.6) < 0.6, `标题栏高 ≈1.6（实测 ${badge.bar.h}）`, String(badge.bar.h));
    // 描边做在**外圈** box-shadow 而不是内边框：与自身同色的暗环压在 Codex 那张圆形渐变云上
    // 会成一坨黑块（另一会话 2026-09-12 实测），合并时采纳了这个做法，颜色仍是设计稿的 #3A3F4C。
    ok(/rgb\(58,\s*63,\s*76\)/.test(badge.ring), '角标描边（外圈）是设计稿的 #3A3F4C', badge.ring);
    ok(/rgb\(255,\s*255,\s*255\)/.test(badge.frameBorder) && /rgb\(255,\s*255,\s*255\)/.test(badge.barBg),
      '窗口图形是白色（旧实现是灰色）', `${badge.frameBorder} / ${badge.barBg}`);
    ok(Math.abs(parseFloat(badge.radius) - 4.5) < 0.3, '角标圆角 4.5', badge.radius);

    // ---- 3. 点空白处（面板失焦）自动关闭 ----
    // 真实驱动：让**另一个窗口**（设置窗）抢焦点，等价于用户点了面板以外的地方。
    // 不模拟 blur 事件——那只会证明"我派发的事件被自己收到了"。
    const pinned = await evalIn(panel, "return typeof (window.pet && window.pet.ui && window.pet.ui.setPanelPinned) === 'function';");
    ok(pinned === true, '真宿主 panel 桥暴露了 ui.setPanelPinned（离线 mock 证明不了这一环）');
    if (process.env.E2E_VISIBLE === '1') {
      // 真实驱动：把设置窗提到最前（等价于用户点了面板以外的地方），不模拟 blur 事件
      await bringToFront(settings);
      const gone = await waitFor(async () => {
        const t = await findTarget('pet-agent-status/panel/panel.html');
        return t ? null : true;
      }, '面板因失焦自动关闭', 40).catch(() => false);
      ok(gone === true, '点面板以外的地方 → 面板自动关闭');
    } else {
      console.log('  ~ 跳过「失焦自动关闭」：隐藏窗没有真实焦点，用 E2E_VISIBLE=1 跑可见实例验证');
    }

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const d of [userData, stateDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理尽力 */ } }
  }
  console.log(`\nui-parity-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
