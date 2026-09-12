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
    // ---- 2. 喂一条真实状态文件（用户/系统真实动作的等价物）----
    const sid = `pet-as-test-e2e-${Date.now()}`;
    const now = Date.now();
    fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: sid, cwd: '/tmp/e2e-proj', project: 'e2e-proj',
      tty: '/dev/ttys901', pid: process.pid, state: 'done', lastEvent: 'Stop', ts: now - 3000,
    }));


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
    ok(gone === true, '点完就收起：已完成的行点击后从面板消失');
    const actions = fs.readFileSync(host.paths.actions, 'utf8');
    ok(actions.includes('osascript') && actions.includes('/dev/ttys901'), '真实跳转路径生成当前终端命令（隔离记录，不激活终端）');

    // ---- 5. 该会话又有新动静 → 自动复现（已读语义，不是删除）----
    fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: sid, cwd: '/tmp/e2e-proj', project: 'e2e-proj',
      tty: '/dev/ttys901', pid: process.pid, state: 'running', lastEvent: 'UserPromptSubmit', ts: Date.now(),
    }));
    const revived = await waitFor(async () => {
      const r = await evalIn(panel, `
        const el = document.querySelector('.row[data-session-id="${sid}"]');
        return el ? el.className : null;`);
      return r || null;
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
    // 隐藏窗口只验证真实桥存在和复制后的按钮反馈；不声称验证了系统剪贴板读回。
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
dismiss-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
