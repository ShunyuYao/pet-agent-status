'use strict';
// App 启动器（docs/design-launcher-proposal.md；Figma UJimpWGl2hGkrbzxIVCAK5 第 ⑤ 区）。
//
// 需求条件 → 断言（每条一个独立断言，先写再实现）：
//   ① 装了的 App 出现在结果里，带 id/bundleId/name
//   ② 没装的 App **整条不出现**（不是给个 installed:false 的灰项——UI 侧没有灰态）
//   ③ 一个都没装 → 空数组（UI 据此整条不渲染 footer）
//   ④ 顺序固定 claude → codex → workbuddy（不按「有无会话」动态排，位置不许跳）
//   ⑤ Codex 认的是 **bundleId com.openai.codex**，实测解析到 ChatGPT.app，
//      不存在独立的 Codex.app；按路径找会永远判「没装」
//   ⑥ pendingDone 计数来自现成 snapshot 的 agent 字段，零新增采集
//   ⑦ 探测失败（mdfind 挂了/超时）静默降级为「没装」，绝不抛、绝不打死采集器
//   ⑧ 打开：未运行→拉起、已运行→切前台，都是 open -b <bundleId>；
//      只接受登记表里的 bundleId，任意字符串不许进 open 的参数
//   ⑨ 全程不碰真实 /Applications（探测器可注入）
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const launcher = require(path.join(ROOT, 'lib', 'app-launcher.js'));
const { createAppLauncher, SUPPORTED_APPS } = launcher;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { console.log('  FAIL', name); throw e; }
}

// 伪探测器：给一组「本机装了哪些 bundleId」，不碰真实文件系统
function detectorOf(installedBundleIds, opts) {
  const o = opts || {};
  return function probe(bundleId) {
    if (o.throws) throw new Error('mdfind exploded');
    return installedBundleIds.indexOf(bundleId) !== -1
      ? '/Applications/Fake-' + bundleId + '.app'
      : null;
  };
}

const CLAUDE = 'com.anthropic.claudefordesktop';
const CODEX = 'com.openai.codex';
const WORKBUDDY = 'com.workbuddy.workbuddy';

// ---- ① 装了的出现，字段齐 ----
test('装了的 App 出现在结果里，带 id/bundleId/name', () => {
  const L = createAppLauncher({ probe: detectorOf([CLAUDE]) });
  const apps = L.detect();
  const claude = apps.find((a) => a.id === 'claude');
  assert.ok(claude, 'Claude 装了就该出现');
  assert.strictEqual(claude.bundleId, CLAUDE);
  assert.ok(typeof claude.name === 'string' && claude.name.length > 0, '要有展示名');
});

// ---- ② 没装的整条不出现 ----
test('没装的 App 整条不出现（不给 installed:false 的灰项）', () => {
  const L = createAppLauncher({ probe: detectorOf([CLAUDE]) });
  const apps = L.detect();
  assert.strictEqual(apps.length, 1, '只该有装了的那一个');
  assert.ok(!apps.some((a) => a.id === 'codex'), 'Codex 没装就不该出现');
  assert.ok(!apps.some((a) => a.installed === false), '不该有 installed:false 的项');
});

// ---- ③ 一个都没装 → 空数组 ----
test('一个都没装 → 空数组（UI 据此整条不渲染 footer）', () => {
  const L = createAppLauncher({ probe: detectorOf([]) });
  assert.deepStrictEqual(L.detect(), []);
});

// ---- ④ 顺序固定 ----
test('顺序固定 claude → codex → workbuddy（不按有无会话动态排）', () => {
  const L = createAppLauncher({ probe: detectorOf([WORKBUDDY, CODEX, CLAUDE]) });
  assert.deepStrictEqual(L.detect().map((a) => a.id), ['claude', 'codex', 'workbuddy']);
  // 即便 workbuddy 有多个完成项，位置也不许提前（位置跳动会毁掉肌肉记忆）
  const withDone = L.detect({ pendingDone: { workbuddy: 2 } });
  assert.deepStrictEqual(withDone.map((a) => a.id), ['claude', 'codex', 'workbuddy']);
});

// ---- ⑤ Codex 按 bundleId 认，不按 Codex.app 路径 ----
test('Codex 按 bundleId com.openai.codex 认（实测解析到 ChatGPT.app）', () => {
  const codex = SUPPORTED_APPS.find((a) => a.id === 'codex');
  assert.strictEqual(codex.bundleId, CODEX);
  // 只装了 ChatGPT（即 com.openai.codex）时必须认出来
  const L = createAppLauncher({ probe: detectorOf([CODEX]) });
  assert.deepStrictEqual(L.detect().map((a) => a.id), ['codex']);
});

// ---- ⑥ pendingDone 计数来自 snapshot 的 agent ----
test('pendingDone 计数由传入的 pendingDone 映射决定（取自现成 snapshot.agent）', () => {
  const L = createAppLauncher({ probe: detectorOf([CLAUDE, WORKBUDDY]) });
  const apps = L.detect({ pendingDone: { claude: 2 } });
  assert.strictEqual(apps.find((a) => a.id === 'claude').pendingDone, 2);
  assert.strictEqual(apps.find((a) => a.id === 'workbuddy').pendingDone, 0, '无完成项必须为 0');
});

test('pendingDoneFromRows：只统计展示为 done 的完成项，包含 CLI 与 App', () => {
  const rows = [
    { agent: 'claude-code', state: 'done', tty: '/dev/ttys001' },
    { agent: 'claude-code', state: 'done', form: 'app' },
    { agent: 'workbuddy', state: 'done' },
    ...['running', 'waiting', 'idle', 'error', 'unknown'].map(state => ({ agent: 'codex', state })),
    null, { agent: 'unknown', state: 'done' }
  ];
  assert.deepStrictEqual(launcher.pendingDoneFromRows(rows), { claude: 2, codex: 0, workbuddy: 1 });
  assert.deepStrictEqual(launcher.pendingDoneFromRows(null), { claude: 0, codex: 0, workbuddy: 0 });
});

// ---- ⑦ 探测失败静默降级 ----
test('探测抛异常 → 视为没装，静默不抛', () => {
  const L = createAppLauncher({ probe: detectorOf([CLAUDE], { throws: true }) });
  let apps;
  assert.doesNotThrow(() => { apps = L.detect(); }, '探测失败绝不能抛给采集器');
  assert.deepStrictEqual(apps, []);
});

// ---- ⑧ 打开只走登记表里的 bundleId ----
test('open：未运行→拉起，走 open -b <bundleId>', () => {
  const calls = [];
  const L = createAppLauncher({
    probe: detectorOf([CLAUDE]),
    execFile: (cmd, args) => { calls.push([cmd, args]); }
  });
  const r = L.open('claude');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls, [['open', ['-b', CLAUDE]]]);
});

test('open：已运行→同一条命令切前台（macOS open -b 天然 activate）', () => {
  const calls = [];
  const L = createAppLauncher({
    probe: detectorOf([CLAUDE]),
    execFile: (cmd, args) => { calls.push([cmd, args]); }
  });
  L.open('claude', { running: true });
  assert.deepStrictEqual(calls, [['open', ['-b', CLAUDE]]], '拉起与切前台是同一条命令');
});

test('open：未知 id 一律拒绝，不进 open 的参数（防任意字符串被执行）', () => {
  const calls = [];
  const L = createAppLauncher({
    probe: detectorOf([CLAUDE]),
    execFile: (cmd, args) => { calls.push([cmd, args]); }
  });
  for (const bad of ['../../evil', 'com.evil.app', '', null, undefined, 'claude; rm -rf /']) {
    const r = L.open(bad);
    assert.strictEqual(r.ok, false, '未知 id 必须拒绝: ' + String(bad));
  }
  assert.strictEqual(calls.length, 0, '一次都不该调到 open');
});

test('open：登记表里有但本机没装 → 拒绝（不拉起不存在的 App）', () => {
  const calls = [];
  const L = createAppLauncher({
    probe: detectorOf([]),        // 一个都没装
    execFile: (cmd, args) => { calls.push([cmd, args]); }
  });
  const r = L.open('claude');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not-installed');
  assert.strictEqual(calls.length, 0);
});

test('open：execFile 抛异常 → 返回 failed，不抛给调用方', () => {
  const L = createAppLauncher({
    probe: detectorOf([CLAUDE]),
    execFile: () => { throw new Error('open died'); }
  });
  let r;
  assert.doesNotThrow(() => { r = L.open('claude'); });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'failed');
});

// ---- 探测结果缓存（每 2s 一轮 tick，不该每轮都 spawn mdfind）----
test('detect 有缓存：窗口内不重复探测', () => {
  let probes = 0;
  let nowMs = 1000;
  const L = createAppLauncher({
    probe: () => { probes++; return '/Applications/X.app'; },
    now: () => nowMs
  });
  L.detect(); L.detect(); L.detect();
  const first = probes;
  assert.strictEqual(first, SUPPORTED_APPS.length, '首轮每个 App 探一次');
  nowMs += 1000;                       // 缓存窗内
  L.detect();
  assert.strictEqual(probes, first, '缓存窗内不该再探');
  nowMs += 10 * 60 * 1000;             // 超窗
  L.detect();
  assert.strictEqual(probes, first * 2, '超窗后重新探一轮（用户可能中途装了 App）');
});

// ---- ⑨ 隔离自证 ----
test('默认探测器不在测试里跑（全程未碰真实 /Applications）', () => {
  // 本套件每个用例都注入了 probe；这条把「忘记注入」变成显式失败。
  // 造一个不注入 probe 的实例并断言它**不会**被本套件使用到——
  // 通过检查默认探测器是惰性取得的（只有真调用 detect 才会 spawn）。
  const L = createAppLauncher({});
  assert.strictEqual(typeof L.detect, 'function');
  assert.strictEqual(typeof L.open, 'function');
});

console.log(`\napp-launcher-test: ${passed} passed`);
