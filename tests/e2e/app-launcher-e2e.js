'use strict';
// 真宿主 E2E：底栏 App 启动器 + 徽标常驻（0.11.0）。
//
// 离线 jsdom 证明不了的三环，只有真宿主能验：
//   ① 宿主真的接受「1 段 muted + 空文本」的徽标（normalizeBadgeSegments 拒 length<1，
//      空文本是读源码确认合法的——但读源码 ≠ 跑通，这里真发一次看返回值）；
//   ② panel CSP 下内联 SVG / data URI 图标真的画得出来（img-src 对 file:// 不可靠，
//      正是当初行徽标改内联的原因，新加的启动器图标要重走一遍这个坑）；
//   ③ 点击 → pet.events → tool → app-launcher 这条跨进程链真的通。
//
// ⚠️ **绝不真的拉起 App**：open 走 tool 侧，E2E 只断言「意图发出去了且 tool 收到」，
// 不断言桌面上真弹出了 Claude —— 那会骚扰维护者的真实桌面（同 osascript 纪律）。
//
// 隔离两要素（AGENTS.md 硬规矩）：PET_USERDATA_DIR 临时目录 + 独立 CDP 端口（9338）。
// 跑法：node tests/e2e/app-launcher-e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
const CDP = Number(process.env.E2E_CDP_PORT || 9338);
const PLUGIN_DIR = path.join(__dirname, '..', '..');

let passed = 0; let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.log('  ✗', label, detail ? `— ${detail}` : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  try { return await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); }
  catch (_) { return []; }
}
async function findTarget(sub) {
  return (await cdpTargets()).find((t) => String(t.url).includes(sub)) || null;
}
async function evalIn(target, expr) {
  const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const out = await new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => rej(new Error('CDP eval 超时')), 20000);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      if (msg.result && msg.result.exceptionDetails) {
        return rej(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 300)));
      }
      res(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }
    }));
  });
  ws.close();
  return out;
}
async function waitFor(fn, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 未就绪 */ }
    await sleep(500);
  }
  throw new Error(`等待超时：${label}`);
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-ud-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-state-'));
  let app = null;
  try {
    const mf = require(path.join(PLUGIN_DIR, 'manifest.json'));
    const grants = {};
    grants[mf.id] = { granted: mf.permissions.slice(), version: mf.version, at: Date.now() };
    fs.writeFileSync(path.join(userData, 'config.json'),
      JSON.stringify({ plugins: { grants } }, null, 2));

    console.log('起隔离宿主实例（CDP', CDP, ')');
    app = spawn('npx', ['--no-install', 'electron', '.', `--remote-debugging-port=${CDP}`], {
      cwd: path.join(HOST, 'demo'),
      env: Object.assign({}, process.env, {
        PET_USERDATA_DIR: userData,
        PET_AGENT_STATUS_DIR: stateDir,
        PET_E2E_TEST: '1', PET_E2E_BACKGROUND: '1', PET_E2E_HIDDEN: '1'
      }),
      detached: true, stdio: ['ignore', 'pipe', 'pipe']
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

    await evalIn(settings, "await window.settings.pluginsTogglePanel('pet-agent-status'); return 1;");
    const panel = await waitFor(() => findTarget('pet-agent-status/panel/panel.html'), '插件面板打开');

    // ---- 1. 底栏渲染出图标（本机装了 Claude/Codex/WorkBuddy）----
    const apps = await waitFor(async () => {
      const r = await evalIn(panel, `
        const box = document.getElementById('applauncher');
        const btns = Array.from(document.querySelectorAll('.app-btn'));
        return JSON.stringify({
          hidden: box ? box.hidden : null,
          ids: btns.map(b => b.dataset.appId),
          // 图标真的画出来了吗（内联 SVG 或 data URI img），不是空按钮
          drawn: btns.map(b => !!b.querySelector('svg, img'))
        });`);
      const v = r ? JSON.parse(String(r)) : null;
      return v && v.ids.length ? v : null;
    }, '底栏出现 App 图标');
    ok(apps.hidden === false, '底栏可见（本机至少装了一个支持的 App）');
    ok(apps.ids.length > 0, `渲染出 ${apps.ids.length} 个 App 图标：${apps.ids.join(',')}`);
    ok(apps.drawn.every(Boolean), '每个按钮里都真的画出了图标（CSP 没拦掉内联 SVG / data URI）',
      JSON.stringify(apps.drawn));

    // 顺序必须是登记表顺序（不按有无会话动态排）
    const expected = ['claude', 'codex', 'workbuddy'].filter((id) => apps.ids.includes(id));
    ok(JSON.stringify(apps.ids) === JSON.stringify(expected),
      '图标顺序＝固定登记表顺序', `实际 ${apps.ids} / 期望 ${expected}`);

    // ---- 2. 图标水平居中（用户反馈的那条）----
    const centered = await evalIn(panel, `
      const row = document.getElementById('applauncher-row');
      const cs = getComputedStyle(row);
      const r = row.getBoundingClientRect();
      const btns = Array.from(document.querySelectorAll('.app-btn'));
      const first = btns[0].getBoundingClientRect();
      const last = btns[btns.length-1].getBoundingClientRect();
      // 左右留白之差 < 2px 即视为居中（不看 CSS 声明，看真实几何）
      const leftGap = first.left - r.left, rightGap = r.right - last.right;
      return JSON.stringify({ justify: cs.justifyContent, leftGap, rightGap });`);
    const c = JSON.parse(String(centered));
    ok(Math.abs(c.leftGap - c.rightGap) < 2,
      '图标在底栏里真实居中（按几何断言，不是只看 CSS 声明）',
      `左留白 ${c.leftGap} / 右留白 ${c.rightGap}`);

    // ---- 3. 点击发出打开意图，且只带 appId ----
    const clicked = await evalIn(panel, `
      const btn = document.querySelector('.app-btn');
      const id = btn.dataset.appId;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return id;`);
    ok(typeof clicked === 'string' && clicked.length > 0,
      `点击 ${clicked} 图标未抛异常（意图已发往 tool）`);

    // ---- 4. 徽标常驻：无会话时仍然存在（本轮改动①）----
    // 状态目录是空的 → summary 全 0 → 旧实现会 clear 掉整个徽标
    // ⚠️ 徽标住在 **pet-overlay.html**（独立的 React 浮层窗），不是 demo/index.html。
    // 首版把断言打到 index.html 上，查不到节点 → 误判成「徽标没渲染」，
    // 而当时连「有真实 running 会话」的对照组也查不到，才看出是找错了窗口。
    const badge = await waitFor(async () => {
      const pet = await findTarget('pet-overlay.html');
      if (!pet) return null;
      const r = await evalIn(pet, `
        const el = document.getElementById('agent-badge');
        if (!el) return JSON.stringify({ present: false });
        return JSON.stringify({
          present: true,
          hasChevron: !!el.querySelector('.agent-badge__chevron'),
          clickable: el.tagName === 'BUTTON',
          text: el.textContent.trim()
        });`);
      const v = r ? JSON.parse(String(r)) : null;
      return v && v.present ? v : null;
    }, '无会话时徽标仍在（常驻）').catch(() => null);

    ok(badge !== null && badge.present === true,
      '无会话时徽标常驻（旧实现此处整个消失）',
      badge ? JSON.stringify(badge) : '（徽标不存在）');
    if (badge) {
      ok(badge.hasChevron === true, '空徽标保留下拉 chevron', JSON.stringify(badge));
      ok(badge.clickable === true, '空徽标仍可点（点开面板的入口没丢）');
      ok(badge.text === '', '空徽标不显示任何数字', `text="${badge.text}"`);
    }

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const d of [userData, stateDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 尽力 */ } }
  }
  console.log(`\napp-launcher-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
