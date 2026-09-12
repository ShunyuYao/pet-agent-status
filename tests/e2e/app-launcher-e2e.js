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
    // ---- 1. 底栏渲染出图标（隔离安装目录夹具含 Claude/Codex/WorkBuddy）----
    const apps = await waitFor(async () => {
      const r = await evalIn(panel, `
        const box = document.getElementById('applauncher');
        const btns = Array.from(document.querySelectorAll('.app-btn'));
        return JSON.stringify({
          hidden: box ? box.hidden : null,
          ids: btns.map(b => b.dataset.appId),
          // 验证已解码的真实 PNG，不能用 SVG 或空图片冒充
          drawn: btns.map(b => { const i = b.querySelector('img'); return !!i && i.complete && i.naturalWidth >= 78 && i.src.startsWith('data:image/png;base64,') && !b.querySelector('svg'); })
        });`);
      const v = r ? JSON.parse(String(r)) : null;
      return v && v.ids.length ? v : null;
    }, '底栏出现 App 图标');
    ok(apps.hidden === false, '底栏可见（隔离夹具安装了三个支持的 App）');
    ok(apps.ids.length > 0, `渲染出 ${apps.ids.length} 个 App 图标：${apps.ids.join(',')}`);
    ok(apps.drawn.every(Boolean), '每个按钮里的真实 PNG 都已解码（CSP 未拦截）',
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
    const openAction = await waitFor(() => {
      const records = fs.readFileSync(host.paths.actions, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return records.find((record) => record.command === 'open');
    }, '真实事件桥发出外部打开命令');
    ok(openAction.args[0] === '-b' && openAction.args[1] === 'com.anthropic.claudefordesktop',
      'tool 按登记表把 Claude 打开意图送达进程边界（隔离记录，不激活真实 App）', JSON.stringify(openAction));

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
app-launcher-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
