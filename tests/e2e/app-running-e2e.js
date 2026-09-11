'use strict';
// 真宿主 E2E：Codex App 任务运行中要看得见（2026-09-11 用户实测缺陷，facts §10）。
//
// 缺陷形态：App 任务只在结束时出现在面板（done），运行全程没有行——
// 因为 running 映射挂在 thread-queued-followups-changed 广播上，实测普通提交不发。
// 修复后 running 的主信号是线程 rollout 文件的新鲜 mtime（PROTOCOL.md「rollout 活动信号」）。
//
// 本用例喂的输入是**系统真实产物的等价物**：
//   · 假 CODEX_HOME 里的 rollout 文件（App 任务运行时 Codex 的真实落盘行为，实测 §10.2），
//     测试期间周期性 touch 模拟持续追加；
//   · 上一回合留下的 ipc 记录（实测线上形态 ended/ipc:turn-read）——归属证据。
// 断言用户可观测结果：面板上出现 state-running 的 App 行，且持续保持（不被翻成已结束）。
//
// 隔离（AGENTS.md 硬规矩）：PET_USERDATA_DIR/PET_AGENT_STATUS_DIR/CODEX_HOME 全指临时目录，
// CDP 9337（9336 归 dismiss-e2e，9222 归宿主仓主实例）。禁点像素，交互经 CDP。
//
// 跑法：node tests/e2e/app-running-e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
const CDP = Number(process.env.E2E_CDP_PORT || 9337);
const PLUGIN_DIR = path.join(__dirname, '..', '..');
const CID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';   // UUID 形态（rollout 归属白名单要求）

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
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-codex-'));
  let app = null;
  let toucher = null;
  try {
    // 预置授权（与 dismiss-e2e 同因：隐藏窗答不了真实授权弹窗，预置=走宿主 savedSet 短路）
    const manifest = require(path.join(PLUGIN_DIR, 'manifest.json'));
    const grants = {};
    grants[manifest.id] = { granted: manifest.permissions.slice(), version: manifest.version, at: Date.now() };
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ plugins: { grants } }, null, 2));

    // 上一回合留下的 App 摄入记录（真实线上形态）——rollout 活动的归属证据
    fs.writeFileSync(path.join(stateDir, `${CID}.json`), JSON.stringify({
      schema: 1, agent: 'codex', form: 'app', sessionId: CID, threadId: CID,
      cwd: '', project: 'Codex App', tty: null, pid: null,
      state: 'ended', lastEvent: 'ipc:turn-read', source: 'ipc', ts: Date.now() - 60000,
    }));

    // 假 CODEX_HOME 里的 rollout 文件：App 任务运行时的真实落盘产物（facts §10.2），
    // 周期性 touch 模拟运行期间每 2–12s 的持续追加
    const d = new Date();
    const dayDir = path.join(codexHome, 'sessions', String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    fs.mkdirSync(dayDir, { recursive: true });
    const rollout = path.join(dayDir, `rollout-2026-09-11T21-00-00-${CID}.jsonl`);
    fs.writeFileSync(rollout, '');
    toucher = setInterval(() => { try { fs.appendFileSync(rollout, '\n'); } catch (_) { /* 尽力 */ } }, 5000);

    console.log('起隔离宿主实例（CDP', CDP, '/ userData', userData, ')');
    app = spawn('npx', ['--no-install', 'electron', '.', `--remote-debugging-port=${CDP}`], {
      cwd: path.join(HOST, 'demo'),
      env: Object.assign({}, process.env, {
        PET_USERDATA_DIR: userData,
        PET_AGENT_STATUS_DIR: stateDir,
        CODEX_HOME: codexHome,   // rollout 扫描与 IPC socket 路径同源认它（协议约定）
        PET_E2E_TEST: '1', PET_E2E_BACKGROUND: '1', PET_E2E_HIDDEN: '1',
      }),
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    app.stdout.on('data', (x) => { log += x; });
    app.stderr.on('data', (x) => { log += x; });

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

    // ---- 核心断言：运行中的 App 任务在面板上是 running 行 ----
    // 修复前这里恒 ended（提交时刻的已读广播/无 running 信号）——正是用户报的缺陷
    const row = await waitFor(async () => {
      const r = await evalIn(panel, `
        const el = document.querySelector('.row[data-session-id="${CID}"]');
        return el ? JSON.stringify({ cls: el.className, txt: el.textContent.trim().slice(0, 60) }) : null;`);
      const v = r ? JSON.parse(r) : null;
      return v && /state-running/.test(v.cls) ? v : null;
    }, 'App 行以 running 出现在面板上', 120);
    ok(/state-running/.test(row.cls), 'rollout 活动中 App 行显示为 running（本缺陷核心断言）', row.cls);
    ok(/Codex App/.test(row.txt), '行上是 App 品牌名（form=app 渲染链路通着）', row.txt);

    // ---- 持续性：活动仍在（touch 还在跑），行保持 running、不被翻回已结束 ----
    await sleep(6000);
    const still = await evalIn(panel, `
      const el = document.querySelector('.row[data-session-id="${CID}"]');
      return el ? el.className : null;`);
    ok(still != null && /state-running/.test(String(still)),
      '活动持续期间行保持 running（心跳刷新防 stale 兜底误伤）', String(still));

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (toucher) clearInterval(toucher);
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const dir of [userData, stateDir, codexHome]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理尽力 */ } }
  }
  console.log(`\napp-running-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
