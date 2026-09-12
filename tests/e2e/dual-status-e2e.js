'use strict';
// ============================================================================
// 端到端：双状态同屏显示（2026-09-11 用户截图缺陷）
//
// 缺陷：徽标与面板汇总胶囊原来只映射 waiting/running，「2 运行中 + 2 已完成」时
// 第二个显示名额空着、已完成不见踪影。修复后按 waiting > running > done 优先级
// 取前两个非零状态填满两段（宿主 BADGE_MAX_SEGMENTS=2）。
//
// 驱动方式：真宿主（隐藏 Electron 隔离实例）+ 真插件（本仓库整包旁加载）+
// 真数据通道（状态文件写进 PET_AGENT_STATUS_DIR 隔离目录，走 hooks 同一条落盘协议）。
// 断言全部是用户可观测结果：浮层 DOM 里的徽标段、面板窗 DOM 里的胶囊段。
//
// 运行（需要桌宠宿主仓库，Node 22+，宿主 demo/ 已 npm install + react:build）：
//   PET_HOST_REPO=/path/to/桌宠仓库 node tests/e2e/dual-status-e2e.js
// 本机默认宿主路径见下方 fallback。
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..', '..');
const HOST_REPO = process.env.PET_HOST_REPO || '/Users/shunyu/projects/desktop_pet/桌宠测试版';
if (!fs.existsSync(path.join(HOST_REPO, 'tests', 'e2e-helpers.js'))) {
  console.error(`找不到宿主仓库（${HOST_REPO}）。请设置 PET_HOST_REPO 指向桌宠仓库根目录。`);
  process.exit(2);
}
const H = require(path.join(HOST_REPO, 'tests', 'e2e-helpers.js'));
const sf = require(path.join(PLUGIN_ROOT, 'lib', 'state-files.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'manifest.json'), 'utf8'));

const CDP = 9377;
const PLUGIN_ID = manifest.id;                       // pet-agent-status
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-dual-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-state-'));
const PANEL_URL_MARK = `${PLUGIN_ID}/panel/panel.html`;

let electron;
let passed = 0;
let failed = 0;

function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.log('  ✗', label, detail); }
}
function eq(label, actual, expected) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
async function waitFor(check, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const v = await check(); if (v) return v; } catch {}
    await H.sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

// 状态记录：pid 用本测试进程（活着，deriveState 不会误推 error）。
//
// ⚠️ tty 必须给（0.11.0「按落点过滤」起）：无 tty 又不属于任何 App 的会话点不进去，
// 整行不再显示，徽标会因此变成「常驻空段」——原注释说"tty 不给以避开终端归属探测的
// 不确定性"，那个理由在过滤落地后不再成立：不给 tty 会直接改变本用例的结果。
// 给一个形态合法但不存在的 tty 即可：行会显示（有 tty 就保留），
// 终端归属判不出来只影响可点态，与本用例要验的徽标分段无关。
function rec(over) {
  const out = Object.assign({
    agent: 'claude-code', cwd: path.join(os.homedir(), 'projects', 'demo'),
    pid: process.pid, lastEvent: 'UserPromptSubmit', ts: Date.now()
  }, over);
  // 每个会话各占一个终端窗口：同一个 tty 上的已结束会话会被 0.10.3 的同窗顶替收走
  // （实测：四条共用一个 tty 时 2 运行+2 完成 被压成 1+1）。
  if (!('tty' in (over || {}))) {
    const id = String((over && over.sessionId) || 's');
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 900;
    out.tty = `/dev/ttys${h + 100}`;
  }
  return out;
}

/** 浮层里的徽标段（tone/text）——与宿主 pet-badge E2E 同一判据。null=无徽标。 */
const badgeSegments = (overlayPage) => H.evalIn(overlayPage, `(() => {
  const n = document.getElementById('agent-badge');
  if (!n) return null;
  return [...n.querySelectorAll('.agent-badge__seg')].map((s) => ({
    tone: (s.className.match(/agent-badge__seg--(\\w+)/) || [])[1] || null,
    text: (s.querySelector('.agent-badge__text') || {}).textContent || '',
  }));
})()`);

/** 面板汇总胶囊各段（state class + 文案）。null=胶囊隐藏。 */
const summaryParts = (panelPage) => H.evalIn(panelPage, `(() => {
  const pill = document.getElementById('summary');
  if (!pill || pill.hidden) return null;
  return [...pill.querySelectorAll('.summary-part')].map((p) => ({
    state: (p.className.match(/is-(\\w+)/) || [])[1] || null,
    text: p.textContent.trim(),
  }));
})()`);

async function waitBadge(overlayPage, expected, label) {
  const got = await waitFor(async () => {
    const segs = await badgeSegments(overlayPage);
    return JSON.stringify(segs) === JSON.stringify(expected) ? (segs || 'null-ok') : null;
  }, label).catch(async () => await badgeSegments(overlayPage));
  eq(label, got === 'null-ok' ? null : got, expected);
}

async function waitPill(panelPage, expected, label) {
  const got = await waitFor(async () => {
    const parts = await summaryParts(panelPage);
    return JSON.stringify(parts) === JSON.stringify(expected) ? (parts || 'null-ok') : null;
  }, label).catch(async () => await summaryParts(panelPage));
  eq(label, got === 'null-ok' ? null : got, expected);
}

(async () => {
  try {
    H.requireNode22();

    // ---- 夹具：整包旁加载真插件（排除仓库脏物），预置授权绕过原生权限卡 ----
    const dest = path.join(USERDATA, 'plugins', PLUGIN_ID);
    fs.cpSync(PLUGIN_ROOT, dest, {
      recursive: true,
      filter: (src) => !/\/(node_modules|\.git|tests|docs|scripts|fixtures)(\/|$)/.test(src)
    });
    fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      me: { petId: 'pet_dual_status_e2e', nickname: '双态联调' },
      petName: '奇奇',
      character: 'qiqi',
      plugins: {
        grants: { [PLUGIN_ID]: { granted: manifest.permissions, version: manifest.version, at: Date.now() } }
      }
    }, null, 2));

    electron = H.launch({
      userData: USERDATA, cdpPort: CDP,
      env: {
        PET_E2E_TEST: '1', PET_AGENT_STATUS_DIR: STATE_DIR,
        // 隔离 Codex / WorkBuddy 两个数据源：不指临时目录的话，插件会去摸**真实**的
        // ~/.codex 与 ~/.workbuddy，把维护者机器上正在跑的真会话摄入到本用例的状态目录里
        // ——实测多出一条 running，四条夹具被数成五条（2026-09-12 发版门禁抓到）。
        CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-dual-codex-')),
        PET_AS_WORKBUDDY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-dual-wb-')),
        PET_AS_CLAUDE_APP_SUPPORT: fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-dual-ccd-'))
      }
    });
    const petPage = await H.findTarget(CDP, '/index.html');
    await waitFor(() => H.evalIn(petPage, 'Boolean(window.petAPI && window.applyPluginPet)'), '内核就绪');
    const overlayPage = await H.findTarget(CDP, '/pet-overlay.html');
    await waitFor(() => H.evalIn(overlayPage, 'Boolean(document.getElementById("react-overlay-root")?.childElementCount)'), 'React 浮层挂载');

    console.log('\n── 1. 截图场景复刻：2 运行中 + 2 已完成 → 徽标两段都在');
    const now = Date.now();
    sf.writeStatus(rec({ sessionId: 'e2e-r1', state: 'running', ts: now - 10 * 1000 }), STATE_DIR);
    sf.writeStatus(rec({ sessionId: 'e2e-r2', state: 'running', ts: now - 20 * 1000 }), STATE_DIR);
    sf.writeStatus(rec({ sessionId: 'e2e-d1', state: 'done', lastEvent: 'Stop', ts: now - 60 * 1000 }), STATE_DIR);
    sf.writeStatus(rec({ sessionId: 'e2e-d2', state: 'done', lastEvent: 'Stop', ts: now - 90 * 1000 }), STATE_DIR);
    await waitBadge(overlayPage,
      [{ tone: 'primary', text: '2' }, { tone: 'success', text: '2' }],
      '徽标 = [运行中 2 · 已完成 2]（done 占第二段，修复前此处只有一段）');

    console.log('\n── 2. 面板胶囊同一取舍规则：两段同屏');
    await H.evalIn(petPage, `window.petAPI.togglePluginPanel(${JSON.stringify(PLUGIN_ID)})`);
    const panelPage = await H.findReadyTarget(CDP, PANEL_URL_MARK);
    await waitPill(panelPage,
      [{ state: 'running', text: '2 运行中' }, { state: 'done', text: '2 已完成' }],
      '胶囊 = 「2 运行中 · 2 已完成」（修复前只显示运行中）');
    // 列表行本来就都在——胶囊/徽标才是缺陷面；顺带确认列表没有被改坏
    const rowStates = await H.evalIn(panelPage,
      `[...document.querySelectorAll('.row')].map((r) => (r.className.match(/state-(\\w+)/) || [])[1]).sort()`);
    eq('列表 4 行状态不受影响', rowStates, ['done', 'done', 'running', 'running']);

    console.log('\n── 3. 三态并存：宿主限死两段，waiting > running > done，done 让位');
    sf.writeStatus(rec({ sessionId: 'e2e-w1', state: 'waiting', lastEvent: 'Notification', ts: Date.now() }), STATE_DIR);
    await waitBadge(overlayPage,
      [{ tone: 'warning', text: '1' }, { tone: 'primary', text: '2' }],
      '徽标 = [等待 1 · 运行中 2]（done 让位，waiting 恒最左）');
    await waitPill(panelPage,
      [{ state: 'waiting', text: '1 等待批准' }, { state: 'running', text: '2 运行中' }],
      '胶囊与徽标取舍一致');

    console.log('\n── 4. 只剩已完成：绿段单独成立（修复前徽标直接消失）');
    for (const id of ['e2e-r1', 'e2e-r2', 'e2e-w1']) sf.removeStatus(id, STATE_DIR);
    await waitBadge(overlayPage, [{ tone: 'success', text: '2' }], '徽标 = [已完成 2]');
    await waitPill(panelPage, [{ state: 'done', text: '2 已完成' }], '胶囊 = 「2 已完成」');

    console.log('\n── 5. 全清 → 徽标转常驻空段、胶囊隐藏');
    for (const id of ['e2e-d1', 'e2e-d2']) sf.removeStatus(id, STATE_DIR);
    // 0.12.0「徽标常驻」起：无会话不再 clear 整个徽标，而是留 1 段 muted + 空文本——
    // 否则宠物脚下唯一的会话入口会消失（该改动的理由见 commit 07fed2c）。
    await waitBadge(overlayPage, [{ tone: 'muted', text: '' }], '无会话 → 徽标转常驻空段');
    await waitPill(panelPage, null, '无会话 → 胶囊隐藏');

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    console.error('\n✗ 用例异常：', err && err.stack || err);
    if (electron) console.error('--- electron 日志尾部 ---\n' + String(electron.log || '').slice(-4000));
    process.exitCode = 1;
  } finally {
    if (electron) H.kill(electron);
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
  }
})();
