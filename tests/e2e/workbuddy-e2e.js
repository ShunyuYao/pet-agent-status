'use strict';
// 真宿主 E2E：WorkBuddy 会话状态接入（PROTOCOL.md「WorkBuddy 来源」）。
//
// 喂的输入是**系统真实产物的等价物**：假 PET_AS_WORKBUDDY_HOME 里一个真 SQLite 库
// （schema 取自真机 workbuddy.db 的 sessions 表，fixtures/workbuddy-facts.md §3.1），
// 测试进程像 WorkBuddy 主进程一样写它（WAL 并发读写走真实路径），驱动完整生命周期：
//   working（运行中，updated_at 周期刷新）→ pending+活动（等输入）→ completed（完成）。
// 顺带在宿主 utilityProcess 里实证 node:sqlite 可用（宿主 Electron 的 Node ≥22.13）。
//
// 断言全是用户可观测结果（面板 DOM），不断言中间函数：
//   ① 运行中的 WorkBuddy 会话 = state-running 行（含项目名、持续保持不掉）
//   ② 启动时库里的历史 completed 会话不出现（不报旧闻）
//   ③ working → pending(有活动) = 行翻 waiting
//   ④ pending → completed = 行翻 done
//   ⑤ 宿主日志无未处理异常
// 跳转不真点：真宿主里 handleJump 会真的 `open workbuddy://…` 拉起用户的 WorkBuddy，
// 该链路由 workbuddy-source-test + tool-lifecycle-test（注入 execFile）守。
//
// 隔离（AGENTS.md 硬规矩）：PET_USERDATA_DIR/PET_AGENT_STATUS_DIR/PET_AS_WORKBUDDY_HOME/
// CODEX_HOME 全指临时目录，CDP 9338（9336=dismiss、9337=app-running、9222=宿主仓主实例）。
// 禁点像素，交互经 CDP。
//
// 跑法：node tests/e2e/workbuddy-e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
const CDP = Number(process.env.E2E_CDP_PORT || 9338);
const PLUGIN_DIR = path.join(__dirname, '..', '..');
const WID = '3dc39631-091f-4b36-9e02-2ccfef2171c2';    // 活跃会话（活体验证实录形态）
const OLD = '781c829f-4a77-4c2f-b6eb-2a0beaa42519';    // 库里的历史 completed（旧闻）

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
if (!sqlite) { console.log('workbuddy-e2e: SKIP（本机 Node 无 node:sqlite）'); process.exit(0); }

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
  const wbHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-wb-'));
  const dbPath = path.join(wbHome, 'workbuddy.db');
  let app = null;
  let ticker = null;
  // 像 WorkBuddy 主进程一样改库（每次开新连接写完就关，别占着写锁）
  function dbRun(fn) {
    const db = new sqlite.DatabaseSync(dbPath);
    try { fn(db); } finally { db.close(); }
  }
  try {
    // 预置授权（隐藏窗答不了真实授权弹窗，预置=走宿主 savedSet 短路）
    const manifest = require(path.join(PLUGIN_DIR, 'manifest.json'));
    const grants = {};
    grants[manifest.id] = { granted: manifest.permissions.slice(), version: manifest.version, at: Date.now() };
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ plugins: { grants } }, null, 2));

    // 建库：schema 与真机一致的子集 + WAL（真机 journal_mode=wal，facts §3.1）
    dbRun((db) => {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT,
        custom_title TEXT, status TEXT NOT NULL DEFAULT 'Pending',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        deleted_at INTEGER, last_activity_at INTEGER)`);
      const t = Date.now();
      // 历史旧闻：两个月前 completed（真机启动时的库就长这样）
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)')
        .run(OLD, '/Users/x/old-proj', '旧任务', null, 'completed', t - 60 * 86400000, t - 60 * 86400000, null, t - 60 * 86400000);
      // 活跃会话：working，updated_at 新鲜
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)')
        .run(WID, '/Users/x/wb-proj', '写周报', null, 'working', t - 5000, t - 1000, null, t - 1000);
    });
    // serve 心跳文件（waiting 阶段的「App 活着」判据）+ 周期刷新 updated_at（运行期真实行为）
    fs.mkdirSync(path.join(wbHome, 'sessions'), { recursive: true });
    const beat = () => {
      try {
        fs.writeFileSync(path.join(wbHome, 'sessions', '47254.json'),
          JSON.stringify({ pid: '47254', lastHeartbeat: String(Date.now()) }));
      } catch (_) { /* 尽力 */ }
    };
    beat();
    let phase = 'working';
    ticker = setInterval(() => {
      beat();
      if (phase === 'working') {
        try { dbRun((db) => db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), WID)); } catch (_) { /* 锁上就下轮 */ }
      }
    }, 3000);

    console.log('起隔离宿主实例（CDP', CDP, '/ userData', userData, ')');
    app = spawn('npx', ['--no-install', 'electron', '.', `--remote-debugging-port=${CDP}`], {
      cwd: path.join(HOST, 'demo'),
      env: Object.assign({}, process.env, {
        PET_USERDATA_DIR: userData,
        PET_AGENT_STATUS_DIR: stateDir,
        CODEX_HOME: codexHome,                 // 隔离：别让插件摸真 ~/.codex
        PET_AS_WORKBUDDY_HOME: wbHome,         // 本用例主角
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

    const rowOf = async (id) => {
      const r = await evalIn(panel, `
        const el = document.querySelector('.row[data-session-id="${id}"]');
        return el ? JSON.stringify({ cls: el.className, txt: el.textContent.trim().slice(0, 80) }) : null;`);
      return r ? JSON.parse(r) : null;
    };

    // ---- ① 运行中 = running 行（utilityProcess 里 node:sqlite 真实可用的实证）----
    const row = await waitFor(async () => {
      const v = await rowOf(WID);
      return v && /state-running/.test(v.cls) ? v : null;
    }, 'WorkBuddy 运行中会话以 running 出现在面板上', 120);
    ok(/state-running/.test(row.cls), 'working 会话显示为 running（核心断言）', row.cls);
    // 行主标签按 US-9 优先级显示 DB 里的 AI 标题（title > project）——顺带钉住标题链路
    ok(/写周报/.test(row.txt), '行主标签是 DB 的 AI 标题（title 链路通着）', row.txt);

    // ---- ② 不报旧闻：历史 completed 不出现 ----
    ok((await rowOf(OLD)) == null, '库里的历史 completed 会话没被当成新完成报出来（不报旧闻）');

    // ---- 持续性：updated_at 周期刷新中，行保持 running ----
    await sleep(6000);
    const still = await rowOf(WID);
    ok(still != null && /state-running/.test(still.cls),
      '运行持续期间行保持 running（心跳刷新防 stale 兜底误伤）', still && still.cls);

    // ---- ③ working → pending(有活动) = waiting ----
    phase = 'pending';
    dbRun((db) => db.prepare('UPDATE sessions SET status=?, updated_at=?, last_activity_at=? WHERE id=?')
      .run('pending', Date.now(), Date.now(), WID));
    const waiting = await waitFor(async () => {
      const v = await rowOf(WID);
      return v && /state-waiting/.test(v.cls) ? v : null;
    }, '行翻 waiting（agent 等用户答复）', 60);
    ok(/state-waiting/.test(waiting.cls), 'pending+有活动 → waiting', waiting.cls);

    // ---- ④ completed = done ----
    phase = 'done';
    dbRun((db) => db.prepare('UPDATE sessions SET status=?, updated_at=? WHERE id=?')
      .run('completed', Date.now(), WID));
    const done = await waitFor(async () => {
      const v = await rowOf(WID);
      return v && /state-done/.test(v.cls) ? v : null;
    }, '行翻 done（任务完成）', 60);
    ok(/state-done/.test(done.cls), 'completed → done', done.cls);

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (ticker) clearInterval(ticker);
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const dir of [userData, stateDir, codexHome, wbHome]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理尽力 */ } }
  }
  console.log(`\nworkbuddy-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
