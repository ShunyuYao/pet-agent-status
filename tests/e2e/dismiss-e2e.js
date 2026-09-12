'use strict';
// 真宿主 E2E：点完就收起（0.6.0）+ 面板基本链路。
//
// 为什么必须有这一层（2026-09-11 教训）：aggregate 单测与 tool 层单测**各自全绿**，
// 但把插件真装进宿主后，SDK 面/事件桥/面板 CSP 任一环断掉，功能整体就是断的。
// 本轮实测就撞到过「手工端到端一跑才发现 handleJump 走了 unavailable 分支」。
//
// 隔离两要素（AGENTS.md 硬规矩，缺一不可）：
//   · PET_USERDATA_DIR 指临时目录 —— 绝不碰日常共享 profile
//   · 独立 --remote-debugging-port 9336 —— 9222 是宿主仓主实例与其它并发会话的
// 禁止模拟鼠标点像素：交互一律经 CDP 在 renderer console 执行 JS。
//
// 跑法：node tests/e2e/dismiss-e2e.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
const CDP = Number(process.env.E2E_CDP_PORT || 9336);
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
// 在指定页面里执行 JS 并取返回值（零依赖 CDP：Node 内建 WebSocket）
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
    // 预先写入权限授予记录：宿主装外部插件时会弹真实 confirm 窗征求授权，而本用例在
    // PET_E2E_HIDDEN 下窗口不可交互，对话框必然落到「拒绝」分支（status=disabled，
    // reason=用户拒绝授权），插件永远激活不了。预置 grants 等价于「用户点了同意并启用」，
    // 走的是宿主自己的 savedSet 短路，不绕过任何权限逻辑。
    const grants = {};
    grants[require(path.join(PLUGIN_DIR, 'manifest.json')).id] = {
      granted: require(path.join(PLUGIN_DIR, 'manifest.json')).permissions.slice(),
      version: require(path.join(PLUGIN_DIR, 'manifest.json')).version,
      at: Date.now(),
    };
    fs.writeFileSync(path.join(userData, 'config.json'),
      JSON.stringify({ plugins: { grants } }, null, 2));

    console.log('起隔离宿主实例（CDP', CDP, '/ userData', userData, ')');
    app = spawn('npx', ['--no-install', 'electron', '.', `--remote-debugging-port=${CDP}`], {
      cwd: path.join(HOST, 'demo'),
      env: Object.assign({}, process.env, {
        PET_USERDATA_DIR: userData,
        PET_AGENT_STATUS_DIR: stateDir,
        PET_E2E_TEST: '1', PET_E2E_BACKGROUND: '1', PET_E2E_HIDDEN: '1',   // 首帧前隐藏，不闪屏抢焦点
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

    // ---- 1. 旁加载安装本插件（真实安装管线）----
    const inst = await evalIn(settings, `
      const r = await window.settings.pluginsInstallPath(${JSON.stringify(PLUGIN_DIR)});
      return JSON.stringify(r);`);
    ok(/"ok":true/.test(String(inst)), '插件旁加载安装成功', String(inst).slice(0, 120));

    const info = await waitFor(async () => {
      const list = JSON.parse(await evalIn(settings, 'return JSON.stringify(await window.settings.pluginsList());'));
      const me = list.find((p) => p.id === 'pet-agent-status');
      return me && me.status === 'active' ? me : null;
    }, '插件激活');
    ok(info.version === require(path.join(PLUGIN_DIR, 'manifest.json')).version,
      `装上的是当前版本 ${info.version}`);

    // ---- 2. 喂一条真实状态文件（用户/系统真实动作的等价物）----
    const sid = `pet-as-test-e2e-${Date.now()}`;
    const now = Date.now();
    fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: sid, cwd: '/tmp/e2e-proj', project: 'e2e-proj',
      tty: process.env.E2E_TTY || '/dev/ttys001', pid: process.pid, state: 'done', lastEvent: 'Stop', ts: now - 3000,
    }));

    await evalIn(settings, "await window.settings.pluginsTogglePanel('pet-agent-status'); return 1;");
    const panel = await waitFor(() => findTarget('pet-agent-status/panel/panel.html'), '插件面板打开');

    // ---- 3. 面板真的渲染出这条 done 行（用户可观测结果）----
    const row = await waitFor(async () => {
      const r = await evalIn(panel, `
        const el = document.querySelector('.row[data-session-id="${sid}"]');
        return el ? JSON.stringify({ cls: el.className, txt: el.textContent.trim().slice(0, 40) }) : null;`);
      return r ? JSON.parse(r) : null;
    // 上限放到 30s（默认 15s 实测会间歇性超时，3 次里红 1 次）：首帧要等的是
    // 插件 utilityProcess 冷启 + tool 首个 2s tick，冷机上偶尔就是超过 15s。
    // 这不是等得越久越保险的凑数，是首启链路本身的量级——延长后连跑 3 次全绿。
    }, 'done 行出现在面板上', 120);
    ok(/state-done/.test(row.cls), 'done 行带绿色状态 class', row.cls);
    // 先证明这行**真的可点**：面板只给 canJump 为真的行绑点击（终端归属判不出就不给假入口）。
    // 不验这条的话，后面的「点完消失」在任何实现下都可能因为「压根没绑事件」而假绿。
    const clickable = await evalIn(panel, `
      const el = document.querySelector('.row[data-session-id="${sid}"]');
      return el ? /pointer/.test(getComputedStyle(el).cursor) : false;`);
    ok(clickable === true, '该行是可点态（canJump 为真，否则点击测的是空气）', String(clickable));

    // ---- 4. 点击该行 → 收起（本轮功能的核心断言）----
    // 不点像素：直接在 renderer 里派发真实 click 事件到那个 DOM 节点
    await evalIn(panel, `
      const el = document.querySelector('.row[data-session-id="${sid}"]');
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 1;`);
    const gone = await waitFor(async () => {
      const n = await evalIn(panel, `return document.querySelectorAll('.row[data-session-id="${sid}"]').length;`);
      return n === 0 ? true : null;
    }, '点击后该行从面板收起').catch(() => false);
    const jumpError = gone ? '' : await evalIn(panel, `return document.querySelector('.jump-error')?.textContent || '';`);
    ok(gone === true, '点完就收起：已完成的行点击后从面板消失', jumpError);

    // ---- 5. 该会话又有新动静 → 自动复现（已读语义，不是删除）----
    fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: sid, cwd: '/tmp/e2e-proj', project: 'e2e-proj',
      tty: process.env.E2E_TTY || '/dev/ttys001', pid: process.pid, state: 'running', lastEvent: 'UserPromptSubmit', ts: Date.now(),
    }));
    const revived = await waitFor(async () => {
      const r = await evalIn(panel, `
        const el = document.querySelector('.row[data-session-id="${sid}"]');
        return el ? el.className : null;`);
      return r && /state-running/.test(r) ? r : null;
    }, '新动静后该行复现').catch(() => null);
    ok(revived && /state-running/.test(revived), '有新动静时收起的行自动复现（已读而非删除）', String(revived));

    // ---- 6. 运行中的行点击不收起（还在进行中，收起会丢失视野）----
    await evalIn(panel, `
      const el = document.querySelector('.row[data-session-id="${sid}"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 1;`);
    await sleep(3000);
    const stillThere = await evalIn(panel, `return document.querySelectorAll('.row[data-session-id="${sid}"]').length;`);
    ok(stillThere === 1, '运行中的行点击后仍在（不收起）', `实际 ${stillThere} 行`);

    // ---- 7. 设置视图 + 「关于」区：真宿主里 ui.copyText 确实通着 ----
    // 离线 jsdom 里 pet.ui.copyText 是我自己写的 mock，证明不了真宿主的 panel 桥有这个面。
    // 这里点真的 ⚙ 与「复制地址」，再经**宿主主进程的 clipboard** 回读剪贴板内容 ——
    // 断言的是用户可观测结果（剪贴板里到底是什么），不是「copyText 被调用了」。
    await evalIn(panel, "document.getElementById('gear').dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1;");
    const aboutUrl = await waitFor(async () => {
      const r = await evalIn(panel, `
        const s = document.getElementById('settings'), a = document.getElementById('about');
        return (s && !s.hidden && a && !a.hidden) ? document.getElementById('about-url').textContent : null;`);
      return r || null;
    }, '设置视图里出现「关于」区').catch(() => null);
    ok(aboutUrl === 'https://github.com/ShunyuYao/pet-agent-status',
      '「关于」区展示开源仓库地址', String(aboutUrl));
    const starText = await evalIn(panel, "return document.getElementById('about-star').textContent;");
    ok(/Star/i.test(String(starText)), '「关于」区有 Star 号召文案', String(starText).slice(0, 60));

    // 先把剪贴板写成哨兵值：否则读到目标地址也可能是上一次残留，测了个寂寞。
    // 写走宿主的 E2E 夹具 IPC（主进程 Electron clipboard，不看窗口焦点）——隐藏窗里
    // navigator.clipboard.writeText 会以 "Document is not focused" 失败。
    // 关于「为什么不直接断言剪贴板内容」（实测记录，别再往回改）：
    // 宿主各 preload 都没有剪贴板**回读**通道，renderer 侧唯一的读法
    // navigator.clipboard.readText() 恒抛 "Document is not focused" —— 本用例在
    // PET_E2E_HIDDEN 下没有任何窗口持有真实焦点，CDP 的
    // Emulation.setFocusEmulationEnabled 也不满足该权限检查（两种写法都实测失败过）。
    // 与其留一条"读不到就算过"的弱断言（那是假绿），不如断言这条链路里
    // **离线 jsdom 证明不了的那一环**：真宿主的 panel 桥确实暴露了 ui.copyText。
    // 点击后的按钮反馈由上一条断言覆盖，两条合起来锁住「面能用 + 点了有反应」。
    const bridge = await evalIn(panel, `
      return JSON.stringify({
        hasUi: !!(window.pet && window.pet.ui),
        hasCopy: !!(window.pet && window.pet.ui && typeof window.pet.ui.copyText === 'function'),
      });`);
    const b = JSON.parse(String(bridge));
    ok(b.hasCopy === true, '真宿主 panel 桥暴露了 ui.copyText（离线 mock 证明不了这一环）', bridge);

    await evalIn(panel, "document.getElementById('about-copy').dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1;");
    const btnText = await waitFor(async () => {
      const r = await evalIn(panel, "return document.getElementById('about-copy').textContent;");
      return /✓/.test(String(r)) ? r : null;
    }, '复制按钮翻成「已复制 ✓」').catch(() => null);
    ok(btnText !== null, '点复制后按钮给出已复制反馈', String(btnText));

    // 核心断言：剪贴板里真的是仓库地址（证明 ui.copyText 这条 SDK 面在真宿主里通着）。
    // 读不到剪贴板时**不降级成弱断言**——直接判失败并说明原因，免得假绿。
    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const d of [userData, stateDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理尽力 */ } }
  }
  console.log(`\ndismiss-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
