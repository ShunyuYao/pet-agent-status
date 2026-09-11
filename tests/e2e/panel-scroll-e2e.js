'use strict';
// 真宿主 E2E：会话数超过窗口高度（manifest 定死 320×420）时，列表可上下滚动。
//
// 用户报障（2026-09-11 截图）：6+ 会话时下面的行被裁掉且滚不动——body overflow:hidden
// 且 .list 高度不受限，内容直接被窗口裁切。修法是 body 变纵向 flex、.list 占剩余
// 高度自滚。断言全部取「用户可观测结果」：容器被约束在窗内、scrollTop 真的能动、
// 滚到底后最后一行进视口、头部滚动时仍常驻。
//
// 隔离两要素（AGENTS.md 硬规矩）：PET_USERDATA_DIR 临时目录 + 独立 CDP 端口。
// 禁止点像素：全部经 CDP 在 renderer 里执行 JS。
//
// 跑法：node tests/e2e/panel-scroll-e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
// 端口按 pid 随机化：固定端口在多会话并发跑 E2E 时会串线——脚本连上**别人**的宿主
// 实例（状态目录不同步，断言永远等不到行），2026-09-11 dismiss-e2e 实测踩过。
const CDP = Number(process.env.E2E_CDP_PORT || (9400 + (process.pid % 500)));
const PLUGIN_DIR = path.join(__dirname, '..', '..');
const ROWS = 12; // 远超一屏能放下的行数

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, tries = 60) {
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
    console.log('起隔离宿主实例（CDP', CDP, '/ userData', userData, ')');
    app = spawn('npx', ['--no-install', 'electron', '.', `--remote-debugging-port=${CDP}`], {
      cwd: path.join(HOST, 'demo'),
      env: Object.assign({}, process.env, {
        PET_USERDATA_DIR: userData,
        PET_AGENT_STATUS_DIR: stateDir,
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

    // 安装会弹权限授权卡（外部插件必弹，fresh userData 没有已存授权）。
    // 不 await 安装调用，等授权卡出现后替用户点「同意并启用」——这是真实用户动作，
    // 不是绕过：不点的话 30s 超时按拒绝收场，插件 status=disabled。
    const instP = evalIn(settings, `
      const r = await window.settings.pluginsInstallPath(${JSON.stringify(PLUGIN_DIR)});
      return JSON.stringify(r);`);
    const dlg = await waitFor(() => findTarget('dialog.html'), '权限授权卡出现');
    await waitFor(async () => {
      const r = await evalIn(dlg, `
        const btn = [...document.querySelectorAll('button')].find((b) => /同意并启用/.test(b.textContent));
        if (!btn) return null;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;`);
      return r || null;
    }, '点「同意并启用」');
    const inst = await instP;
    ok(/"ok":true/.test(String(inst)) && /"status":"active"/.test(String(inst)),
      '插件旁加载安装成功且已激活', String(inst).slice(0, 120));
    let lastMe = null;
    await waitFor(async () => {
      const list = JSON.parse(await evalIn(settings, 'return JSON.stringify(await window.settings.pluginsList());'));
      const me = list.find((p) => p.id === 'pet-agent-status');
      lastMe = me || lastMe;
      return me && me.status === 'active' ? me : null;
    }, '插件激活', 120).catch((e) => {
      console.log('  激活失败时插件状态:', JSON.stringify(lastMe));
      throw e;
    });

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

    await evalIn(settings, "await window.settings.pluginsTogglePanel('pet-agent-status'); return 1;");
    const panel = await waitFor(() => findTarget('pet-agent-status/panel/panel.html'), '插件面板打开');

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
      await new Promise((r) => requestAnimationFrame(() => r()));
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

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const d of [userData, stateDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理尽力 */ } }
  }
  console.log(`\npanel-scroll-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
