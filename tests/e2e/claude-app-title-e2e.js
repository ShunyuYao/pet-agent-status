'use strict';
// 真宿主 E2E：Claude Desktop App 会话——标题反查 + tty:null 跳转兜底入口。
//
// 覆盖离线测试证明不了的整条链：真实安装管线 → utilityProcess 里的 tool 读
// PET_AS_CLAUDE_APP_SUPPORT 指向的元数据目录（env 要能穿透宿主到插件子进程）→
// 面板真的把 App 元数据里的 AI 标题渲染出来、把 tty:null 的 App 行渲染成可点态。
//
// 刻意不真点 App 行：点击会 `open -b` 把真实 Claude.app 拉到前台（骚扰真实桌面，
// 同 terminal-jump「测试绝不真跑 osascript」纪律）。点击后的执行链由
// tool-lifecycle-test 的注入 execFile 断言（open -b + bundle id + 失败错误条）。
//
// 隔离（AGENTS.md 硬规矩）：PET_USERDATA_DIR 临时目录；CDP 端口按 pid 随机化
// （固定端口在多会话并发跑 E2E 时会串线连上别人的宿主实例）；预置 plugins.grants
// （fresh userData 装外部插件必弹授权卡，隐藏窗没人点则 30s 超时按拒绝收场）。
//
// 跑法：node tests/e2e/claude-app-title-e2e.js
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
  const appSupport = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-ccd-'));
  let app = null;
  try {
    const manifest = require(path.join(PLUGIN_DIR, 'manifest.json'));
    const grants = {};
    grants[manifest.id] = { granted: manifest.permissions.slice(), version: manifest.version, at: Date.now() };
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ plugins: { grants } }, null, 2));

    // 伪造的 App 元数据目录（形态照抄 fixtures/claude-desktop-facts.md §2 实录）
    const appSid = `pet-as-test-app-${Date.now()}`;
    const cliSid = `pet-as-test-cli-${Date.now()}`;
    const APP_TITLE = 'E2E：App 元数据里的 AI 标题';
    const orgDir = path.join(appSupport, 'claude-code-sessions', 'acct-e2e', 'org-e2e');
    fs.mkdirSync(orgDir, { recursive: true });
    fs.writeFileSync(path.join(orgDir, 'local_e2e.json'), JSON.stringify({
      sessionId: 'local_e2e', cliSessionId: appSid, cwd: '/tmp/e2e-app-proj',
      title: APP_TITLE, titleSource: 'auto', createdAt: Date.now(), lastActivityAt: Date.now(),
    }));

    console.log('起隔离宿主实例（CDP', CDP, '/ userData', userData, ')');
    app = spawn('npx', ['--no-install', 'electron', '.', `--remote-debugging-port=${CDP}`], {
      cwd: path.join(HOST, 'demo'),
      env: Object.assign({}, process.env, {
        PET_USERDATA_DIR: userData,
        PET_AGENT_STATUS_DIR: stateDir,
        PET_AS_CLAUDE_APP_SUPPORT: appSupport,   // 必须穿透宿主进 utilityProcess（本用例要验的一环）
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
    ok(/"ok":true/.test(String(inst)), '插件旁加载安装成功', String(inst).slice(0, 120));
    await waitFor(async () => {
      const list = JSON.parse(await evalIn(settings, 'return JSON.stringify(await window.settings.pluginsList());'));
      const me = list.find((p) => p.id === 'pet-agent-status');
      return me && me.status === 'active' ? me : null;
    }, '插件激活');

    // 两条 claude-code 会话都无 tty：一条能在 App 元数据里证明归属，一条不能（对照）
    const now = Date.now();
    fs.writeFileSync(path.join(stateDir, `${appSid}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: appSid, cwd: '/tmp/e2e-app-proj', project: 'e2e-app-proj',
      tty: null, pid: null, state: 'running', lastEvent: 'PreToolUse', ts: now, since: now,
      title: '落盘兜底名（不该显示这个）',
    }));
    fs.writeFileSync(path.join(stateDir, `${cliSid}.json`), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: cliSid, cwd: '/tmp/e2e-cli-proj', project: 'e2e-cli-proj',
      tty: null, pid: null, state: 'running', lastEvent: 'PreToolUse', ts: now, since: now,
      title: 'CLI 无终端兜底名',
    }));

    await evalIn(settings, "await window.settings.pluginsTogglePanel('pet-agent-status'); return 1;");
    const panel = await waitFor(() => findTarget('pet-agent-status/panel/panel.html'), '插件面板打开');

    // ---- 1. App 行主标签 = App 元数据里的 AI 标题（用户可观测结果，不是中间函数被调用）----
    const appRow = await waitFor(async () => {
      const r = await evalIn(panel, `
        const el = document.querySelector('.row[data-session-id="${appSid}"]');
        return el ? JSON.stringify({ txt: el.textContent, cursor: getComputedStyle(el).cursor }) : null;`);
      return r ? JSON.parse(r) : null;
    }, 'App 会话行出现在面板上');
    ok(appRow.txt.includes(APP_TITLE), 'App 行显示元数据里的 AI 标题', appRow.txt.slice(0, 80));
    ok(!appRow.txt.includes('落盘兜底名'), 'AI 标题压过落盘兜底（不是两个都显）', appRow.txt.slice(0, 80));

    // ---- 2. tty:null 的 App 行是可点态（激活 Claude App 兜底入口）----
    ok(/pointer/.test(appRow.cursor), 'App 行可点（tty:null 也有跳转入口）', appRow.cursor);

    // ---- 3. 对照：证明不了归属的无 tty 行不可点（无假入口），且显落盘兜底名 ----
    const cliRow = await waitFor(async () => {
      const r = await evalIn(panel, `
        const el = document.querySelector('.row[data-session-id="${cliSid}"]');
        return el ? JSON.stringify({ txt: el.textContent, cursor: getComputedStyle(el).cursor }) : null;`);
      return r ? JSON.parse(r) : null;
    }, '对照行出现在面板上');
    ok(cliRow.txt.includes('CLI 无终端兜底名'), '对照行照旧显示落盘兜底名', cliRow.txt.slice(0, 80));
    ok(!/pointer/.test(cliRow.cursor), '对照行不可点（证明不了 App 归属就不给假入口）', cliRow.cursor);

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const d of [userData, stateDir, appSupport]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理尽力 */ } }
  }
  console.log(`\nclaude-app-title-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
