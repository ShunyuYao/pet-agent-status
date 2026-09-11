'use strict';
// ============================================================================
// 端到端：「可能已中断」点一下让它消失（2026-09-11 用户需求二）
//
// 用户截图场景：server-management 会话「可能已中断」（进程已死、终端窗口早关了），
// 原实现该行连点击都不绑（canJump=false）——点了毫无反应，只能等 20 分钟自然淡出。
// 修复后 error 属可收起态：行可点，点击即收起（找不到终端也收起——没有可确认的对象）。
//
// 驱动：真宿主隔离实例 + 真插件旁加载 + 真状态文件（error 由「进程已死 + 60s 无心跳」
// 在插件内真实推导，不是喂展示态）。断言：面板 DOM 行的可点态与消失。
//
// 环境纪律（AGENTS.md / 两会话并发教训）：CDP 端口按 pid 随机避免并发串线；
// 预置 config.json plugins.grants 绕过原生授权卡；userData/状态目录均临时。
//
// 运行：node tests/e2e/dismiss-error-e2e.js（可用 PET_HOST_REPO 指宿主仓库）
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..', '..');
const HOST_REPO = process.env.PET_HOST_REPO || '/Users/shunyu/projects/desktop_pet/桌宠测试版';
if (!fs.existsSync(path.join(HOST_REPO, 'tests', 'e2e-helpers.js'))) {
  console.error(`找不到宿主仓库（${HOST_REPO}）。请设置 PET_HOST_REPO。`);
  process.exit(2);
}
const H = require(path.join(HOST_REPO, 'tests', 'e2e-helpers.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'manifest.json'), 'utf8'));

const CDP = 9400 + (process.pid % 400);           // 并发会话各跑各的端口，不串线
const PLUGIN_ID = manifest.id;
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-dismiss-err-ud-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-dismiss-err-state-'));
const PANEL_URL_MARK = `${PLUGIN_ID}/panel/panel.html`;

let electron;
let passed = 0;
let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.log('  ✗', label, detail); }
}
async function waitFor(check, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const v = await check(); if (v) return v; } catch {}
    await H.sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

/** 一个确定已死的 pid：起个瞬退子进程拿它的 pid（不 grep 不猜数）。 */
function deadPid() {
  const r = spawnSync('true');
  return r.pid || 99999;
}

(async () => {
  try {
    H.requireNode22();
    const dest = path.join(USERDATA, 'plugins', PLUGIN_ID);
    fs.cpSync(PLUGIN_ROOT, dest, {
      recursive: true,
      filter: (src) => !/\/(node_modules|\.git|tests|docs|scripts|fixtures)(\/|$)/.test(src)
    });
    fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      me: { petId: 'pet_dismiss_err_e2e', nickname: '中断收起联调' },
      petName: '奇奇', character: 'qiqi',
      plugins: { grants: { [PLUGIN_ID]: { granted: manifest.permissions, version: manifest.version, at: Date.now() } } }
    }, null, 2));

    // 状态文件在启动前就位：running 落盘 + 90s 无心跳 + pid 已死 → 插件推导出 error。
    // tty 指向一个不存在的终端（ttys250 没人用）——正是「终端窗口也关了」的用户场景。
    const now = Date.now();
    const gone = deadPid();
    fs.writeFileSync(path.join(STATE_DIR, 'pet-as-test-err.json'), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: 'pet-as-test-err', cwd: '/tmp/server-management',
      project: 'server-management', tty: '/dev/ttys250', pid: gone,
      state: 'running', lastEvent: 'UserPromptSubmit', ts: now - 90 * 1000
    }));
    fs.writeFileSync(path.join(STATE_DIR, 'pet-as-test-run.json'), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: 'pet-as-test-run', cwd: '/tmp/alive',
      project: 'alive', tty: '/dev/ttys251', pid: process.pid,
      state: 'running', lastEvent: 'UserPromptSubmit', ts: now - 5 * 1000
    }));

    electron = H.launch({ userData: USERDATA, cdpPort: CDP, env: { PET_E2E_TEST: '1', PET_AGENT_STATUS_DIR: STATE_DIR } });
    const petPage = await H.findTarget(CDP, '/index.html');
    await waitFor(() => H.evalIn(petPage, 'Boolean(window.petAPI)'), '内核就绪');
    await H.evalIn(petPage, `window.petAPI.togglePluginPanel(${JSON.stringify(PLUGIN_ID)})`);
    const panel = await H.findReadyTarget(CDP, PANEL_URL_MARK);

    console.log('\n── 1. error 行渲染且是可点态（修复前 canJump=false 连 handler 都不绑）');
    const errRow = await waitFor(() => H.evalIn(panel, `(() => {
      const el = document.querySelector('.row[data-session-id="pet-as-test-err"]');
      if (!el) return null;
      return { state: el.dataset.state, canDismiss: el.classList.contains('can-dismiss'),
               cursor: getComputedStyle(el).cursor };
    })()`), 'error 行出现');
    ok(errRow.state === 'error', '该行推导为「可能已中断」', JSON.stringify(errRow));
    ok(errRow.canDismiss === true, '带 can-dismiss 可点态 class');
    ok(/pointer/.test(errRow.cursor), '显示手型（真入口，不是摆设）', errRow.cursor);

    console.log('\n── 2. 点击 → 行消失（终端找不到也收起）；running 行不受影响');
    await H.evalIn(panel, `(() => {
      document.querySelector('.row[data-session-id="pet-as-test-err"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    const goneRow = await waitFor(async () =>
      (await H.evalIn(panel, `document.querySelectorAll('.row[data-session-id="pet-as-test-err"]').length`)) === 0
        ? 'gone' : null, '点击后 error 行消失');
    ok(goneRow === 'gone', '「可能已中断」点一下即消失');
    ok(await H.evalIn(panel, `document.querySelectorAll('.jump-error').length`) === 0,
      '不留行内错误条（行都没了错误条无处安放）');
    ok(await H.evalIn(panel, `document.querySelectorAll('.row[data-session-id="pet-as-test-run"]').length`) === 1,
      'running 行仍在（收起只作用于被点的那行）');

    console.log('\n── 3. 同会话有新动静 → 自动复现（已读不是删除）');
    fs.writeFileSync(path.join(STATE_DIR, 'pet-as-test-err.json'), JSON.stringify({
      schema: 1, agent: 'claude-code', sessionId: 'pet-as-test-err', cwd: '/tmp/server-management',
      project: 'server-management', tty: '/dev/ttys250', pid: process.pid,
      state: 'running', lastEvent: 'UserPromptSubmit', ts: Date.now()
    }));
    const revived = await waitFor(() => H.evalIn(panel, `(() => {
      const el = document.querySelector('.row[data-session-id="pet-as-test-err"]');
      return el ? el.dataset.state : null;
    })()`), '新动静后该行复现');
    ok(revived === 'running', '复现且回到运行中', String(revived));

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    console.error('\n✗ 用例异常：', err && err.stack || err);
    if (electron) console.error('--- electron 日志尾部 ---\n' + String(electron.log || '').slice(-3000));
    process.exitCode = 1;
  } finally {
    if (electron) H.kill(electron);
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
  }
})();
