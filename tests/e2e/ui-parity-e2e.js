'use strict';
// Real hidden Electron + exact production panel/collector/SDK; external sources and
// OS commands are isolated by hidden-host.js. DOM clicks test panel intent delivery;
// native mouse passthrough/focus and actual external App activation are excluded.
const fs = require('fs');
const path = require('path');
const { start } = require('./hidden-host');
const PLUGIN_DIR = path.join(__dirname, '..', '..');
let passed = 0, failed = 0, currentHost;
function ok(condition, label, detail = '') {
  if (condition) { passed++; console.log('  ✓', label); }
  else { failed++; console.log('  ✗', label, detail); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evalIn = (target, body) => currentHost.evaluate(`(async()=>{ ${body} })()`, target);
const findTarget = (needle) => currentHost.findTarget(needle);
const waitFor = (fn, label, tries = 120) => currentHost.waitFor(fn, label, tries * 250);

(async () => {
  let host;
  try {
    host = currentHost = await start();
    const { settings, panel } = host;
    const stateDir = host.paths.state;
    const info = (await host.evaluate('window.settings.pluginsList()', settings)).find((plugin) => plugin.id === 'pet-agent-status');
    ok(info?.status === 'active', '插件旁加载安装成功且已激活');
    ok(info.version === require(path.join(PLUGIN_DIR, 'manifest.json')).version, '装上的是当前插件版本');
    const now = Date.now();
    fs.writeFileSync(path.join(stateDir, `pet-as-test-cli-${now}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: `pet-as-test-cli-${now}`, cwd: '/tmp/cli-proj',
      project: 'cli-proj', tty: '/dev/ttys901', pid: process.pid, state: 'running',
      lastEvent: 'PreToolUse', ts: now, since: now,
    }));
    fs.writeFileSync(path.join(stateDir, `pet-as-test-app-${now}.json`), JSON.stringify({
      schema: 1, agent: 'codex', sessionId: `pet-as-test-app-${now}`, cwd: '', project: 'Codex App',
      tty: null, pid: null, state: 'running', lastEvent: 'ipc:activity', ts: now, since: now,
      threadId: '01a08a1d-4f63-7e30-af03-48ae77b414b5', form: 'app', source: 'ipc',
    }));

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

    // ---- 2. App 形态角标是窗口图形，几何对齐设计稿（Figma 77:10）----
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
        radius: cs.borderTopLeftRadius, ring: cs.borderTopColor, border: cs.borderTopWidth, bg: cs.backgroundColor,
        frameBorder: fs2.boxShadow, barBg: bs.backgroundColor,
      });`));
    ok(!badge.missing, 'CLI 与 App 两种角标都渲染出来了');
    ok(badge.appText === '', 'App 角标不再是字符占位', JSON.stringify(badge.appText));
    ok(badge.cliText === '>_', 'CLI 角标保持设计稿的 >_', badge.cliText);
    ok(Math.abs(badge.frame.w - 6.4) < 0.1 && Math.abs(badge.frame.h - 5) < 0.1,
      `窗口外框 6.4×5（实测 ${badge.frame.w}×${badge.frame.h}）`, JSON.stringify(badge.frame));
    ok(Math.abs(badge.bar.h - 1.1) < 0.1, `标题栏高 1.1（实测 ${badge.bar.h}）`, String(badge.bar.h));
    // 当前在线 Figma：13px 角标内含 1px 描边。
    ok(badge.border === '1px', '角标描边宽 1px', badge.border);
    ok(/rgb\(58,\s*63,\s*76\)/.test(badge.ring), '角标描边是设计稿的 #3A3F4C', badge.ring);
    ok(/rgb\(255,\s*255,\s*255\)/.test(badge.frameBorder) && /rgb\(255,\s*255,\s*255\)/.test(badge.barBg),
      '窗口图形是白色（旧实现是灰色）', `${badge.frameBorder} / ${badge.barBg}`);
    ok(Math.abs(parseFloat(badge.radius) - 4.5) < 0.3, '角标圆角 4.5', badge.radius);

    // ---- 3. 点空白处（面板失焦）自动关闭 ----
    // 真实驱动：让**另一个窗口**（设置窗）抢焦点，等价于用户点了面板以外的地方。
    // 不模拟 blur 事件——那只会证明"我派发的事件被自己收到了"。
    const pinned = await evalIn(panel, "return typeof (window.pet && window.pet.ui && window.pet.ui.setPanelPinned) === 'function';");
    ok(pinned === true, '真宿主 panel 桥暴露了 ui.setPanelPinned（离线 mock 证明不了这一环）');
    console.log('  ~ 未重测原生失焦关闭：本轮视觉验收只运行隐藏实例。');

    const log = fs.readFileSync(host.paths.log, 'utf8');
    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));

    ok(host.errors.length === 0, 'renderer 无异常或 console error', JSON.stringify(host.errors));
    await host.screenshot(path.join(host.paths.artifacts, 'panel.png'));
    console.log('  证据:', host.paths.artifacts);
  } catch (error) {
    failed++;
    console.log('  ✗ E2E 异常:', error.stack || error);
    if (host?.panel) {
      try { await host.screenshot(path.join(host.paths.artifacts, 'failure.png')); }
      catch (captureError) { console.log('  失败截图不可用:', captureError.message); }
    }
  } finally {
    if (host) await host.stop();
  }
  console.log(`
ui-parity-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
