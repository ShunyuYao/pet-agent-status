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
async function rowOf(panel, sid) {
  const r = await evalIn(panel, `
    const el = document.querySelector('.row[data-session-id="${sid}"]');
    if (!el) return null;
    const sub = el.querySelector('.subline');
    return JSON.stringify({ cls: el.className, sub: sub ? sub.textContent.trim() : '' });`);
  return r ? JSON.parse(String(r)) : null;
}

function fireHook(event) {
  const tty = event.session_id.includes('-idle-') ? '/dev/ttys902'
    : event.session_id.includes('-stale-') ? '/dev/ttys903' : '/dev/ttys901';
  return currentHost.fireHook(event, { tty });
}

(async () => {
  let host;
  try {
    host = currentHost = await start();
    const { settings, panel } = host;
    const stateDir = host.paths.state;
    const info = (await host.evaluate('window.settings.pluginsList()', settings)).find((plugin) => plugin.id === 'pet-agent-status');
    ok(info?.status === 'active', '插件旁加载安装成功且已激活');
    ok(info.version === require(path.join(PLUGIN_DIR, 'manifest.json')).version, '装上的是当前插件版本');
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
    ok(parseInt(String(summary), 10) === 1,
      '汇总里等待批准只剩那 1 条真的（闲置与已清位的都不计入）', `summary="${summary}"`);

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
waiting-accuracy-e2e: ${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
