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
const ROWS = 12;

(async () => {
  let host;
  try {
    host = currentHost = await start();
    const { settings, panel } = host;
    const stateDir = host.paths.state;
    const info = (await host.evaluate('window.settings.pluginsList()', settings)).find((plugin) => plugin.id === 'pet-agent-status');
    ok(info?.status === 'active', '插件旁加载安装成功且已激活');
    ok(info.version === require(path.join(PLUGIN_DIR, 'manifest.json')).version, '装上的是当前插件版本');
    // ---- 喂一屏放不下的会话数（等价于用户同时开一堆 agent 会话）----
    const now = Date.now();
    for (let i = 0; i < ROWS; i++) {
      const sid = `pet-as-test-scroll-${i}`;
      fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
        schema: 1, agent: 'claude-code', sessionId: sid, cwd: `/tmp/proj-${i}`, project: `proj-${i}`,
        tty: `/dev/ttys9${String(i).padStart(2, '0')}`, pid: process.pid,
        state: 'running', lastEvent: 'UserPromptSubmit', ts: now - i * 1000,
      }));
    }


    await waitFor(async () => {
      const n = await evalIn(panel, "return document.querySelectorAll('#list .row').length;");
      return n === ROWS ? true : null;
    }, `${ROWS} 行全部渲染`);
    ok(true, `${ROWS} 行全部渲染`);

    // ---- 核心断言：列表被约束在窗内且可滚 ----
    const m = JSON.parse(await evalIn(panel, `
      const list = document.getElementById('list');
      const r = list.getBoundingClientRect();
      return JSON.stringify({
        winH: window.innerHeight,
        listBottom: r.bottom,
        clientH: list.clientHeight,
        scrollH: list.scrollHeight,
        overflowY: getComputedStyle(list).overflowY,
      });`));
    // 修复前：.list 不受限，clientHeight==scrollHeight、底缘超出窗口 —— 下面三条全红
    ok(m.listBottom <= m.winH + 1, '列表容器被约束在窗口内（不再被窗缘裁切）',
      `listBottom=${m.listBottom} winH=${m.winH}`);
    ok(m.scrollH > m.clientH, '内容超出一屏时列表可滚（scrollHeight > clientHeight）',
      `scrollH=${m.scrollH} clientH=${m.clientH}`);
    ok(m.overflowY === 'auto' || m.overflowY === 'scroll', '列表 overflow-y 是滚动态', m.overflowY);

    // ---- 滚到底：scrollTop 真的动了，最后一行进入视口 ----
    const after = JSON.parse(await evalIn(panel, `
      const list = document.getElementById('list');
      list.scrollTop = list.scrollHeight;
      const last = list.querySelector('.row[data-session-id="pet-as-test-scroll-${ROWS - 1}"]')
        || list.lastElementChild;
      const lr = last.getBoundingClientRect();
      const top = document.querySelector('.topbar').getBoundingClientRect();
      return JSON.stringify({
        scrollTop: list.scrollTop,
        lastTop: lr.top, lastBottom: lr.bottom, winH: window.innerHeight,
        topbarTop: top.top, topbarH: top.height,
      });`));
    ok(after.scrollTop > 0, '设置 scrollTop 后真的滚动了', `scrollTop=${after.scrollTop}`);
    ok(after.lastBottom <= after.winH + 1 && after.lastTop >= 0,
      '滚到底后最后一行完整进入视口', `top=${after.lastTop} bottom=${after.lastBottom} winH=${after.winH}`);
    ok(after.topbarTop >= 0 && after.topbarH > 0, '滚动后头部（标题+汇总胶囊）仍常驻可见',
      `topbarTop=${after.topbarTop}`);

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
panel-scroll-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
