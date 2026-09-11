'use strict';
// 真宿主 E2E：闲置提醒不再被误报成「等待你批准」（0.8.2）。
//
// 用户现象（2026-09-11）：compact 结束后会话闲着没动，面板把它标成「等待你批准」。
// 根因与取证见 fixtures/waiting-accuracy-facts.md。
//
// 为什么这条必须进真宿主，而不是只靠 tests/claude-hook-test.js：
// 离线单测断言的是「hook 写进状态文件的 state 字段」，而用户看到的是**面板上那行字**。
// 中间还隔着 tool 采集 → aggregate 推导 → 面板渲染三层，任一层把 running 又显示成
// 等待批准，离线全绿而用户依然见到 bug。本用例断言的是真宿主面板里的 DOM。
//
// 输入是**真实动作的等价物**：spawn 真正的 hooks/claude-status-hook.js，
// 把 Claude Code 的真实事件 JSON 喂进它的 stdin，让它自己去写状态文件。
// 绝不手写状态文件——手写等于绕过被修的那段代码，测了个寂寞。
//
// 隔离两要素（AGENTS.md 硬规矩，缺一不可）：
//   · PET_USERDATA_DIR 指临时目录 —— 绝不碰日常共享 profile
//   · 独立 --remote-debugging-port 9337 —— 9222 是宿主仓主实例与其它并发会话的
// 禁止模拟鼠标点像素：交互一律经 CDP 在 renderer console 执行 JS。
//
// 跑法：node tests/e2e/waiting-accuracy-e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
const CDP = Number(process.env.E2E_CDP_PORT || 9337);
const PLUGIN_DIR = path.join(__dirname, '..', '..');
const HOOK = path.join(PLUGIN_DIR, 'hooks', 'claude-status-hook.js');

let passed = 0; let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.log('  ✗', label, detail ? `— ${detail}` : ''); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP}/json/list`);
    return await res.json();
  } catch (_) { return []; }
}
async function findTarget(sub) {
  const list = await cdpTargets();
  return list.find((t) => String(t.url).includes(sub)) || null;
}

// 在目标 renderer 里执行 JS（CDP over WebSocket）。
async function evalIn(target, expr) {
  const WebSocket = globalThis.WebSocket;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
      params: { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true },
    }));
  });
  ws.close();
  return out;
}

async function waitFor(fn, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 还没就绪 */ }
    await sleep(500);
  }
  throw new Error(`等待超时：${label}`);
}

// 真实动作等价物：把事件 JSON 喂给真正的 hook 脚本的 stdin。
function fireHook(event, stateDir) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PET_AGENT_STATUS_DIR: stateDir }),
  });
  if (res.status !== 0) throw new Error(`hook 退出码 ${res.status}: ${res.stderr}`);
  return res;
}

// 读面板上某行的状态 class + 副行文案（用户可观测结果）
async function rowOf(panel, sid) {
  const r = await evalIn(panel, `
    const el = document.querySelector('.row[data-session-id="${sid}"]');
    if (!el) return null;
    const sub = el.querySelector('.subline');
    return JSON.stringify({ cls: el.className, sub: sub ? sub.textContent.trim() : '' });`);
  return r ? JSON.parse(String(r)) : null;
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-ud-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-e2e-state-'));
  let app = null;
  try {
    // 预置权限授予：PET_E2E_HIDDEN 下授权确认窗不可交互，必然落「拒绝」分支导致插件
    // 永远激活不了。预置 grants 等价于用户点了「同意并启用」，走宿主自己的 savedSet 短路。
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

    await evalIn(settings, "await window.settings.pluginsTogglePanel('pet-agent-status'); return 1;");
    const panel = await waitFor(() => findTarget('pet-agent-status/panel/panel.html'), '插件面板打开');

    const tty = process.env.E2E_TTY || '/dev/ttys001';
    const mkEvent = (sid, extra) => Object.assign({
      session_id: sid, cwd: '/tmp/e2e-proj', transcript_path: '/tmp/t.jsonl',
    }, extra);

    // ---- 1. 用户路径重放：真批准 → 面板显示「等待你批准」 ----
    const sidPerm = `pet-as-test-perm-${Date.now()}`;
    fireHook(mkEvent(sidPerm, {
      hook_event_name: 'Notification',
      matcher: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    }), stateDir);

    const permRow = await waitFor(() => rowOf(panel, sidPerm), '权限请求行出现在面板上');
    ok(/state-waiting/.test(permRow.cls),
      '权限请求仍然显示为「等待你批准」（本插件的存在理由，不许误伤）', permRow.cls);

    // ---- 2. 本轮缺陷复现点：闲置提醒不该是「等待你批准」 ----
    // 实录依据：803bf299 在 SessionStart:compact 之后整 60s 收到 idle_prompt。
    const sidIdle = `pet-as-test-idle-${Date.now()}`;
    fireHook(mkEvent(sidIdle, { hook_event_name: 'SessionStart', source: 'compact' }), stateDir);
    fireHook(mkEvent(sidIdle, {
      hook_event_name: 'Notification',
      matcher: 'idle_prompt',
      message: 'Claude is waiting for your input',
    }), stateDir);

    const idleRow = await waitFor(() => rowOf(panel, sidIdle), '闲置会话行出现在面板上');
    ok(!/state-waiting/.test(idleRow.cls),
      '闲置提醒不再被显示成「等待你批准」（本轮修复的核心断言）', `${idleRow.cls} / ${idleRow.sub}`);
    ok(!/批准|approv/i.test(idleRow.sub),
      '该行副行文案里没有「批准」字样', idleRow.sub);

    // ---- 3. 陈旧 waiting 会被 compact 恢复清位 ----
    const sidStale = `pet-as-test-stale-${Date.now()}`;
    fireHook(mkEvent(sidStale, {
      hook_event_name: 'Notification',
      matcher: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    }), stateDir);
    await waitFor(async () => {
      const r = await rowOf(panel, sidStale);
      return r && /state-waiting/.test(r.cls) ? r : null;
    }, '前置条件：该会话先处于等待批准');

    fireHook(mkEvent(sidStale, { hook_event_name: 'SessionStart', source: 'compact' }), stateDir);
    const cleared = await waitFor(async () => {
      const r = await rowOf(panel, sidStale);
      return r && !/state-waiting/.test(r.cls) ? r : null;
    }, 'compact 恢复后清掉陈旧 waiting').catch(() => null);
    ok(cleared !== null, 'compact 恢复把陈旧的「等待你批准」清掉',
      cleared ? cleared.cls : '（仍停在 waiting）');

    // ---- 4. 汇总胶囊不再把闲置会话计进「等待批准」----
    const summary = await evalIn(panel, `
      const el = document.querySelector('.summary-part.is-waiting');
      return el ? el.textContent.trim() : '';`);
    ok(!/[2-9]\\d*/.test(String(summary)),
      '汇总里等待批准只剩那 1 条真的（闲置与已清位的都不计入）', `summary="${summary}"`);

    ok(!/TypeError|Uncaught|Unhandled/.test(log), '宿主日志无未处理异常', String(log).slice(-400));
  } catch (e) {
    failed++;
    console.log('  ✗ E2E 异常:', (e && e.stack) || e);
  } finally {
    if (app && app.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { try { app.kill('SIGKILL'); } catch (_) { /* 已死 */ } } }
    for (const d of [userData, stateDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理尽力 */ } }
  }
  console.log(`\nwaiting-accuracy-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
