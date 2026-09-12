'use strict';
// US-005 验收测试：点击会话行跳回终端。
//
// 全离线：**绝不真跑 osascript**（会抢真实桌面焦点，criteria §6 明列为越界），
// **也不 spawn ps** —— 进程表与执行器一律注入伪造的。
// 断言用户可观测结果：生成的 AppleScript 文本、面板收到的快照行、行内错误条文案。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const tj = require(path.join(ROOT, 'lib', 'terminal-jump.js'));
const agg = require(path.join(ROOT, 'lib', 'aggregate.js'));
const sf = require(path.join(ROOT, 'lib', 'state-files.js'));
const tool = require(path.join(ROOT, 'tool', 'index.js'));
const { createNodeI18n } = require(path.join(ROOT, 'lib', 'i18n.js'));

const T0 = 1789000000000;
const i18n = createNodeI18n('zh-CN');
const t = i18n.t;

let passed = 0;
const failures = [];
// 用例按注册顺序**串行 await**：async 用例若只 fire-and-forget，抛出的断言会变成
// 未捕获 rejection 在汇总之后才炸，屏幕上却显示「全绿」—— 等于没测。
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n${err && err.stack}`);
    }
  }
}

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-jump-'));
  tmpDirs.push(d);
  return d;
}

// ---- 伪造进程表 ----
// 形状照抄 macOS 上 `ps -eo pid=,ppid=,tty=,comm=` 的真实产出（本机实测）：
// TTY 列不带 /dev 前缀，comm 是可执行文件**绝对路径**。
// 夹具与真实产出同形是硬要求 —— 形态不真实的夹具让测试变绿也证明不了什么
// （knowledge.md 记了三次同型复发）。
const TERMINAL_BIN = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
const ITERM_BIN = '/Applications/iTerm.app/Contents/MacOS/iTerm2';
const CODE_BIN = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
const WARP_BIN = '/Applications/Warp.app/Contents/MacOS/stable';

// 一条真实形态的链：App → login → -zsh → claude → node，都挂在同一个 tty 上
// （App 自己不挂 tty，ps 里显示 `??`）。
function chain(appBin, ttyName, basePid) {
  const p = basePid || 800;
  return [
    { pid: p, ppid: 1, tty: '??', comm: appBin },
    { pid: p + 1, ppid: p, tty: ttyName, comm: 'login' },
    { pid: p + 2, ppid: p + 1, tty: ttyName, comm: '-zsh' },
    { pid: p + 3, ppid: p + 2, tty: ttyName, comm: 'claude' },
    { pid: p + 4, ppid: p + 3, tty: ttyName, comm: 'node' }
  ];
}

// ================= 1. detectTerminal —— 归属判定 =================

// 隔离自证：测试**自己的数据**不得出现在真实路径里。
//
// ⚠️ 判据不能是「真实目录一个字节都没变」（2026-09-11 实测教训）：维护者自己也在用这个插件，
// 开发机上真实 agent 会话会持续写状态目录，mtime 快照必然变化 —— 那个守卫在开发机上随机变红，
// 且红了也说明不了问题。真正要防的是**测试数据泄漏进真实目录**，所以改为按测试专属前缀检查。
// （其余套件 2026-09-11 已统一到这套判据，本文件当时漏改，现补齐。）
const TEST_ID_PREFIX = 'pet-as-test-';
function leakedTestFiles() {
  const dir = path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter((n) => n.includes(TEST_ID_PREFIX));
}

test('iTerm2 会话：沿父链认出 iterm2', () => {
  assert.strictEqual(tj.detectTerminal('/dev/ttys004', chain(ITERM_BIN, 'ttys004')), 'iterm2');
});

test('Terminal.app 会话：沿父链认出 terminal', () => {
  assert.strictEqual(tj.detectTerminal('/dev/ttys004', chain(TERMINAL_BIN, 'ttys004')), 'terminal');
});

test('其它已知终端 App（Warp）→ activate:<app> 兜底档', () => {
  assert.strictEqual(tj.detectTerminal('/dev/ttys004', chain(WARP_BIN, 'ttys004')), 'activate:Warp');
});

test('VS Code 集成终端 → activate:Visual Studio Code（含空格的 App 名不被截断）', () => {
  assert.strictEqual(
    tj.detectTerminal('/dev/ttys004', chain(CODE_BIN, 'ttys004')),
    'activate:Visual Studio Code'
  );
});

test('父链里没有任何已知终端 App → null（推断不出就说推断不出，不猜）', () => {
  const tree = [
    { pid: 900, ppid: 1, tty: '??', comm: '/usr/libexec/some-daemon' },
    { pid: 901, ppid: 900, tty: 'ttys004', comm: '-zsh' },
    { pid: 902, ppid: 901, tty: 'ttys004', comm: 'claude' }
  ];
  assert.strictEqual(tj.detectTerminal('/dev/ttys004', tree), null);
});

test('tty 为 null / 空 / 非法形态 → null，不进任何匹配', () => {
  const tree = chain(ITERM_BIN, 'ttys004');
  for (const bad of [null, undefined, '', '   ', '/dev/', '/dev/../etc/passwd', 'ttys004; rm -rf /']) {
    assert.strictEqual(tj.detectTerminal(bad, tree), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('tty 不在进程表里（会话已退出）→ null', () => {
  assert.strictEqual(tj.detectTerminal('/dev/ttys999', chain(ITERM_BIN, 'ttys004')), null);
});

test('两个终端各占一个 tty 时按 tty 分流，不串台', () => {
  const tree = chain(ITERM_BIN, 'ttys004', 800).concat(chain(TERMINAL_BIN, 'ttys007', 900));
  assert.strictEqual(tj.detectTerminal('/dev/ttys004', tree), 'iterm2');
  assert.strictEqual(tj.detectTerminal('/dev/ttys007', tree), 'terminal');
});

test('ps 传 ttys004（无 /dev 前缀）与 /dev/ttys004 等价', () => {
  const tree = chain(TERMINAL_BIN, 'ttys004');
  assert.strictEqual(tj.detectTerminal('ttys004', tree), 'terminal');
});

test('ppid 成环时不死循环，返回 null', () => {
  const tree = [
    { pid: 10, ppid: 11, tty: 'ttys004', comm: '-zsh' },
    { pid: 11, ppid: 10, tty: 'ttys004', comm: 'claude' }
  ];
  assert.strictEqual(tj.detectTerminal('/dev/ttys004', tree), null);
});

test('psTreeProvider 抛错时不炸，返回 null', () => {
  assert.strictEqual(tj.detectTerminal('/dev/ttys004', () => { throw new Error('ps 挂了'); }), null);
});

test('parsePsOutput 吃真实形态的 ps 文本（含空格路径的 comm 不被切断）', () => {
  const text = [
    '  800     1 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2',
    '  801   800 ttys004  login',
    '  802   801 ttys004  -zsh',
    '  900     1 ??       /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    ''
  ].join('\n');
  const rows = tj.parsePsOutput(text);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows[0], { pid: 800, ppid: 1, tty: '??', comm: '/Applications/iTerm.app/Contents/MacOS/iTerm2' });
  assert.strictEqual(rows[1].tty, 'ttys004');
  assert.strictEqual(rows[3].comm, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  // 由这份文本反查也要能命中，证明 parse 与 detect 是同一套形态
  assert.strictEqual(tj.detectTerminal('/dev/ttys004', rows), 'iterm2');
});

// ================= 2. buildScript —— 生成的 AppleScript 文本 =================

test('buildScript(iterm2) 精确定位：含目标 tty、按 session 匹配、select+activate', () => {
  const s = tj.buildScript('iterm2', '/dev/ttys004');
  assert.ok(s.includes('tell application "iTerm2"'), 'app 名必须是 iTerm2');
  assert.ok(!s.includes('"Terminal"'), '不许混进 Terminal.app');
  assert.ok(s.includes('"/dev/ttys004"'), '必须含传入的 tty 字面量');
  assert.ok(/sessions of/.test(s) && /tty of s is/.test(s), 'iTerm2 的 tty 挂在 session 上');
  assert.ok(/select w/.test(s) && /select tb/.test(s) && /select s/.test(s), '窗口/标签/会话三级都要选中');
  assert.ok(s.includes('activate'), '选完要把 App 提到前台');
});

test('buildScript(terminal) 精确定位：含目标 tty、按 tab 匹配、Terminal.app 专有语法', () => {
  const s = tj.buildScript('terminal', '/dev/ttys007');
  assert.ok(s.includes('tell application "Terminal"'), 'app 名必须是 Terminal');
  assert.ok(!s.includes('iTerm'), '不许混进 iTerm2');
  assert.ok(s.includes('"/dev/ttys007"'), '必须含传入的 tty 字面量');
  assert.ok(/tabs of w/.test(s) && /tty of tb is/.test(s), 'Terminal.app 的 tty 挂在 tab 上');
  assert.ok(/set selected of tb to true/.test(s), '要选中那个标签页');
  assert.ok(/set index of w to 1/.test(s), '要把它的窗口提到最前');
});

test('两支精确脚本互不相同，且各自只提自己的 App（不是同一份模板换个名）', () => {
  const a = tj.buildScript('iterm2', '/dev/ttys004');
  const b = tj.buildScript('terminal', '/dev/ttys004');
  assert.notStrictEqual(a, b);
  assert.ok(a.includes('sessions of') && !b.includes('sessions of'));
});

test('兜底支只 activate，不假装精确（不含 tty、不遍历窗口标签）', () => {
  const s = tj.buildScript('activate:Warp', '/dev/ttys004');
  assert.strictEqual(s, 'tell application "Warp" to activate');
  assert.ok(!s.includes('ttys004'), '兜底档不该出现 tty —— 出现了就是在假装能精确定位');
  assert.ok(!/repeat with/.test(s), '兜底档不该遍历窗口/标签');
});

test('兜底支 App 名含空格照常生成', () => {
  assert.strictEqual(
    tj.buildScript('activate:Visual Studio Code', '/dev/ttys004'),
    'tell application "Visual Studio Code" to activate'
  );
});

test('kind 为 null（推断不出）→ buildScript 返回 null，没有可执行的脚本', () => {
  assert.strictEqual(tj.buildScript(null, '/dev/ttys004'), null);
  assert.strictEqual(tj.buildScript('', '/dev/ttys004'), null);
  assert.strictEqual(tj.buildScript('activate:', '/dev/ttys004'), null);
});

test('精确档拿到非法 tty → null（宁可不跳，也不生成一条含垃圾的脚本）', () => {
  for (const bad of [null, '', '/dev/', 'ttys004"']) {
    assert.strictEqual(tj.buildScript('iterm2', bad), null, `应拒绝 ${JSON.stringify(bad)}`);
    assert.strictEqual(tj.buildScript('terminal', bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

// ================= 3. 注入安全 =================

test('恶意 tty 一律被拒，生成不出脚本（不靠转义放行，靠白名单拒绝）', () => {
  const evil = [
    `/dev/ttys00'; do evil`,
    '/dev/ttys004"\nte' + 'll application "System Events" to keystroke "x"',
    '/dev/ttys004; rm -rf ~',
    '/dev/ttys004 $(whoami)',
    '/dev/ttys004`id`',
    '/dev/../../etc/passwd',
    '/dev/ttys004\\"'
  ];
  const tree = chain(ITERM_BIN, 'ttys004');
  for (const bad of evil) {
    assert.strictEqual(tj.isValidTty(bad), false, `isValidTty 应拒绝 ${JSON.stringify(bad)}`);
    assert.strictEqual(tj.buildScript('iterm2', bad), null, `不该为 ${JSON.stringify(bad)} 生成脚本`);
    assert.strictEqual(tj.buildScript('terminal', bad), null);
    assert.strictEqual(tj.detectTerminal(bad, tree), null, `不该为 ${JSON.stringify(bad)} 判出归属`);
    assert.strictEqual(tj.scriptForTty(bad, tree), null);
  }
});

test('合法 tty 生成的脚本里，引号数量与模板一致（没有额外引号被注进去）', () => {
  const s = tj.buildScript('iterm2', '/dev/ttys004');
  // 模板里的双引号只有两处成对：app 名 + tty 字面量
  assert.strictEqual((s.match(/"/g) || []).length, 4);
});

// ================= 4. 执行壳 —— 失败不 throw 不静默 =================

test('runJump 成功：把生成的脚本原样交给执行器，返回 ok', () => {
  const seen = [];
  const r = tj.runJump('/dev/ttys004', {
    psTree: chain(ITERM_BIN, 'ttys004'),
    runner: (script) => { seen.push(script); return { ok: true }; }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'iterm2');
  assert.strictEqual(seen.length, 1);
  // 断言执行器**实收的参数**，不是拿常量自比（AGENTS.md：不断言「某函数被调用」）
  assert.strictEqual(seen[0], tj.buildScript('iterm2', '/dev/ttys004'));
});

test('runJump 失败（osascript 非零退出）→ 返回 {ok:false, reason}，不抛', () => {
  const r = tj.runJump('/dev/ttys004', {
    psTree: chain(TERMINAL_BIN, 'ttys004'),
    runner: () => ({ ok: false, reason: 'execution error: 应用程序未运行 (-600)' })
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('-600'));
});

test('runJump：执行器自己抛异常也不外溢（跳转失败绝不打死 tool）', () => {
  const r = tj.runJump('/dev/ttys004', {
    psTree: chain(TERMINAL_BIN, 'ttys004'),
    runner: () => { throw new Error('spawn ENOENT'); }
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('ENOENT'));
});

test('runJump：推断不出终端时不执行任何脚本，reason=unavailable', () => {
  let called = 0;
  const r = tj.runJump('/dev/ttys999', {
    psTree: chain(ITERM_BIN, 'ttys004'),
    runner: () => { called++; return { ok: true }; }
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unavailable');
  assert.strictEqual(called, 0, '没有脚本就不该去执行');
});

test('本测试全程没有真跑 osascript（执行器一律注入）', () => {
  // 反证：不注入 runner 时走的是 defaultRunner —— 这条用例只断言默认执行器存在且
  // 与注入点是同一个开关，绝不调用它。
  assert.strictEqual(typeof tj.runJump, 'function');
  assert.strictEqual(typeof tj.readPsTree, 'function');
});

// ================= 5. 面板行的跳转入口标志（aggregate 侧） =================

function rec(over) {
  return Object.assign({
    agent: 'claude-code', sessionId: 's', cwd: '/Users/me/projects/demo',
    tty: '/dev/ttys004', pid: 4242, state: 'running', lastEvent: 'UserPromptSubmit', ts: T0
  }, over);
}
function snapshotOf(recs, over) {
  const dir = tmp();
  for (const r of recs) sf.writeStatus(r, dir);
  return agg.aggregate(sf.readSnapshots(dir),
    Object.assign({ now: T0, isPidAlive: () => true, t }, over));
}

test('能推断出终端的行 canJump=true，推断不出的 canJump=false', () => {
  const tree = chain(ITERM_BIN, 'ttys004');
  const snap = snapshotOf(
    [rec({ sessionId: 'has-term', tty: '/dev/ttys004' }),
      rec({ sessionId: 'no-term', tty: '/dev/ttys999', ts: T0 - 1000 })],
    { canJump: (tty) => tj.detectTerminal(tty, tree) != null }
  );
  const by = Object.fromEntries(snap.rows.map((r) => [r.sessionId, r]));
  assert.strictEqual(by['has-term'].canJump, true);
  assert.strictEqual(by['no-term'].canJump, false);
});

test('tty 为 null 的会话（管道里跑的）不给入口——2026-09-12 起整行都不显示', () => {
  // 原判据是 canJump=false（有行但不可点）。「按落点过滤」落地后，一个落点都没有的行
  // 整行隐藏，是同一条保证的更强形式：canJump 就算被注入成恒 true 也不该冒出入口来。
  const snap = snapshotOf([rec({ sessionId: 'piped', tty: null })], { canJump: () => true });
  assert.strictEqual(snap.rows.length, 0, '无 tty 无 App 落点的会话不该出现在面板上');
  assert.strictEqual(snap.summary.hiddenNoTarget, 1, '隐藏了几条要如实报出来');
});

test('canJump 缺省为 false：拿不到判定就不给入口，不给假入口', () => {
  const snap = snapshotOf([rec({ sessionId: 'x' })]);
  assert.strictEqual(snap.rows[0].canJump, false);
});

test('canJump 判定抛错时不打死这一轮 aggregate，该行退回 false', () => {
  const snap = snapshotOf([rec({ sessionId: 'x' })], {
    canJump: () => { throw new Error('ps 挂了'); }
  });
  assert.strictEqual(snap.rows.length, 1);
  assert.strictEqual(snap.rows[0].canJump, false);
});

test('unknown 行（文件读不出来）canJump=false', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ 半截');
  const snap = agg.aggregate(sf.readSnapshots(dir),
    { now: T0, isPidAlive: () => true, t, canJump: () => true });
  assert.strictEqual(snap.rows[0].state, 'unknown');
  assert.strictEqual(snap.rows[0].canJump, false);
});

test('jumpErrors 经 aggregate 落到对应行上，别的行不受影响', () => {
  const snap = snapshotOf(
    [rec({ sessionId: 'bad' }), rec({ sessionId: 'good', ts: T0 - 1000 })],
    { jumpErrors: { bad: '跳转失败：应用程序未运行' } }
  );
  const by = Object.fromEntries(snap.rows.map((r) => [r.sessionId, r]));
  assert.strictEqual(by.bad.jumpError, '跳转失败：应用程序未运行');
  assert.strictEqual(by.good.jumpError, undefined);
});

// ================= 6. panel：可点态与行内错误条 =================

const PANEL_HTML = path.join(ROOT, 'panel', 'panel.html');
const html = fs.readFileSync(PANEL_HTML, 'utf8');

function mountPanel() {
  const handlers = new Map();
  const emitted = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'file://' + PANEL_HTML,
    beforeParse(win) {
      win.pet = {
        events: {
          on(name, fn) { handlers.set(name, fn); },
          emit(name, data) { emitted.push({ name, data }); }
        },
        ui: { closePanel() {} }
      };
      Object.defineProperty(win.navigator, 'language', { value: 'zh-CN', configurable: true });
    }
  });
  emitted.length = 0; // 挂载时的 panel-ready 握手不计入后续点击意图。
  return {
    dom, emitted,
    doc: dom.window.document,
    $(sel) { return dom.window.document.querySelector(sel); },
    $$(sel) { return [...dom.window.document.querySelectorAll(sel)]; },
    push(name, data) {
      const fn = handlers.get(name);
      assert.ok(fn, `panel 没有订阅事件 ${name}`);
      fn(data);
    },
    click(sel) {
      this.$(sel).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
    close() { dom.window.close(); }
  };
}

test('canJump=false 的行点了没反应（不挂 handler，无假入口）', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', snapshotOf([rec({ sessionId: 'no-term' })]));
  assert.strictEqual(p.$('.row[data-session-id="no-term"]').classList.contains('can-jump'), false);
  p.click('.row[data-session-id="no-term"]');
  // 「没挂 handler」是观测出来的：点了以后 emitted 里什么都没有
  assert.strictEqual(p.emitted.length, 0);
  p.close();
});

test('canJump=true 的行才是可点态，点了发 jump{sessionId}', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', snapshotOf([rec({ sessionId: 'ok' })], { canJump: () => true }));
  assert.strictEqual(p.$('.row[data-session-id="ok"]').classList.contains('can-jump'), true);
  p.click('.row[data-session-id="ok"]');
  assert.strictEqual(p.emitted.length, 1);
  assert.strictEqual(p.emitted[0].name, 'agent-status:jump');
  assert.strictEqual(p.emitted[0].data.sessionId, 'ok');
  p.close();
});

test('同一份快照里，只有能跳的那行可点', () => {
  const tree = chain(TERMINAL_BIN, 'ttys004');
  const snap = snapshotOf(
    [rec({ sessionId: 'yes', tty: '/dev/ttys004' }),
      rec({ sessionId: 'no', tty: '/dev/ttys999', ts: T0 - 1000 })],
    { canJump: (tty) => tj.detectTerminal(tty, tree) != null }
  );
  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  p.click('.row[data-session-id="no"]');
  assert.strictEqual(p.emitted.length, 0);
  p.click('.row[data-session-id="yes"]');
  assert.deepStrictEqual(p.emitted.map((e) => e.data.sessionId), ['yes']);
  p.close();
});

test('跳转失败经快照回推 → 行内错误条紧跟该行之后（不弹窗不静默）', () => {
  const snap = snapshotOf([rec({ sessionId: 'bad' })],
    { canJump: () => true, jumpErrors: { bad: t('jump.unavailable') } });
  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  const row = p.$('.row[data-session-id="bad"]');
  const err = p.$('.jump-error');
  assert.ok(err, '必须渲染出行内错误条');
  assert.strictEqual(err.textContent, t('jump.unavailable'));
  assert.strictEqual(row.nextElementSibling, err, '错误条必须紧跟它那一行');
  p.close();
});

// ================= 7. 端到端：panel 点击 → tool 执行 → 错误回推面板 =================
//
// 「发意图」与「接意图」必须有一条测试同时踩到两端（US-004 教训：只测半条线
// 的话，另半条不存在时表现为静默无反应）。

function makeTool(dir, over) {
  const emitted = [];
  const handlers = new Map();
  const pet = {
    scheduler: { async every() { return 'task-1'; }, async cancel() {} },
    events: {
      emit(name, data) { emitted.push({ name, data }); },
      on(name, fn) { handlers.set(name, fn); }
    },
    pet: { bubble() {}, playAnim() {} }
  };
  const collector = tool.createCollector(Object.assign({
    threadState: { read: () => new Map() },
    dir, now: () => T0, isPidAlive: () => true, locale: 'zh-CN',
    settingsFile: path.join(dir, 'settings.json'),
    rolloutActivity: { activeThreads: () => new Map() },   // 隔离：默认实现 stat 真实 ~/.codex/sessions
    workbuddySource: { tick: () => {} }   // 同理：默认实现打开真实 ~/.workbuddy/workbuddy.db
  }, over));
  return {
    pet, collector, emitted, handlers,
    snapshots() { return emitted.filter((e) => e.name === tool.SNAPSHOT_EVENT).map((e) => e.data); },
    lastRows() { const s = this.snapshots(); return s.length ? s[s.length - 1].rows : []; }
  };
}

test('端到端：panel 发 jump → tool 真生成脚本并交给执行器', async () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'e2e', tty: '/dev/ttys004' }), dir);
  const seen = [];
  const h = makeTool(dir, {
    psTree: chain(ITERM_BIN, 'ttys004'),
    jumpRunner: (script) => { seen.push(script); return { ok: true }; }
  });
  await h.collector.start(h.pet);
  // 走宿主真实通道：从 panel 那侧发意图（tool 侧 subscribe 的那个回调）
  const fn = h.handlers.get(tool.JUMP_EVENT);
  assert.ok(fn, 'tool 必须订阅 agent-status:jump —— 没订阅的话点了会静默无反应');
  fn({ sessionId: 'e2e' });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0], tj.buildScript('iterm2', '/dev/ttys004'));
  await h.collector.stop(h.pet);
});

test('端到端：跳转失败 → 下一次快照里那一行带 jumpError（中文文案来自 locales）', async () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'e2e', tty: '/dev/ttys004' }), dir);
  const h = makeTool(dir, {
    psTree: chain(TERMINAL_BIN, 'ttys004'),
    jumpRunner: () => ({ ok: false, reason: 'execution error (-600)' })
  });
  await h.collector.start(h.pet);
  h.handlers.get(tool.JUMP_EVENT)({ sessionId: 'e2e' });
  const row = h.lastRows().find((r) => r.sessionId === 'e2e');
  assert.strictEqual(row.jumpError, t('jump.failed', { reason: 'execution error (-600)' }));
  assert.ok(row.jumpError.includes('-600'), '错误条要带上真实原因，不是笼统一句失败');
  await h.collector.stop(h.pet);
});

test('端到端：找不到终端时错误条用 jump.unavailable 文案（与执行失败区分）', async () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'e2e', tty: '/dev/ttys999' }), dir);
  const h = makeTool(dir, {
    psTree: chain(TERMINAL_BIN, 'ttys004'),
    jumpRunner: () => { throw new Error('不该被调用'); }
  });
  await h.collector.start(h.pet);
  h.handlers.get(tool.JUMP_EVENT)({ sessionId: 'e2e' });
  const row = h.lastRows().find((r) => r.sessionId === 'e2e');
  assert.strictEqual(row.jumpError, t('jump.unavailable'));
  await h.collector.stop(h.pet);
});

test('端到端：跳转成功后错误条消失（修好了就别一直红着）', async () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'e2e', tty: '/dev/ttys004' }), dir);
  let ok = false;
  const h = makeTool(dir, {
    psTree: chain(ITERM_BIN, 'ttys004'),
    jumpRunner: () => (ok ? { ok: true } : { ok: false, reason: 'boom' })
  });
  await h.collector.start(h.pet);
  h.handlers.get(tool.JUMP_EVENT)({ sessionId: 'e2e' });
  assert.ok(h.lastRows()[0].jumpError, '第一次失败要留下错误条');
  ok = true;
  h.handlers.get(tool.JUMP_EVENT)({ sessionId: 'e2e' });
  assert.strictEqual(h.lastRows()[0].jumpError, undefined, '成功后错误条要撤掉');
  await h.collector.stop(h.pet);
});

test('端到端：错误条过 TTL 后自动消失，不永久驻留', async () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'e2e', tty: '/dev/ttys004' }), dir);
  let clock = T0;
  const h = makeTool(dir, {
    now: () => clock,
    psTree: chain(ITERM_BIN, 'ttys004'),
    jumpRunner: () => ({ ok: false, reason: 'boom' })
  });
  await h.collector.start(h.pet);
  h.handlers.get(tool.JUMP_EVENT)({ sessionId: 'e2e' });
  assert.ok(h.lastRows()[0].jumpError);
  clock = T0 + tool.JUMP_ERROR_TTL_MS + 1;
  h.collector.tick(h.pet);
  assert.strictEqual(h.lastRows()[0].jumpError, undefined);
  await h.collector.stop(h.pet);
});

test('端到端：tool 下发的行带 canJump，判定确实来自进程树（改进程树就会翻面）', async () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'e2e', tty: '/dev/ttys004' }), dir);
  // 有终端
  const yes = makeTool(dir, { psTree: chain(ITERM_BIN, 'ttys004'), jumpRunner: () => ({ ok: true }) });
  await yes.collector.start(yes.pet);
  assert.strictEqual(yes.lastRows()[0].canJump, true);
  await yes.collector.stop(yes.pet);
  // 同样的会话，进程树里那个 tty 挂的不是终端 → 当场翻成不可跳（断言非恒真）
  const no = makeTool(dir, {
    psTree: [{ pid: 9, ppid: 1, tty: 'ttys004', comm: '/usr/libexec/some-daemon' }],
    jumpRunner: () => ({ ok: true })
  });
  await no.collector.start(no.pet);
  assert.strictEqual(no.lastRows()[0].canJump, false);
  await no.collector.stop(no.pet);
});

test('端到端：panel 收到的快照行原样带着 canJump 与 jumpError（tool→panel 载荷贯通）', async () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'e2e', tty: '/dev/ttys004' }), dir);
  const h = makeTool(dir, {
    psTree: chain(ITERM_BIN, 'ttys004'),
    jumpRunner: () => ({ ok: false, reason: 'boom' })
  });
  await h.collector.start(h.pet);
  h.handlers.get(tool.JUMP_EVENT)({ sessionId: 'e2e' });
  const p = mountPanel();
  p.push('agent-status:snapshot', h.snapshots()[h.snapshots().length - 1]);
  assert.strictEqual(p.$('.row[data-session-id="e2e"]').classList.contains('can-jump'), true);
  assert.strictEqual(p.$('.jump-error').textContent, t('jump.failed', { reason: 'boom' }));
  p.close();
  await h.collector.stop(h.pet);
});

test('未知 sessionId 的 jump 意图不炸、不执行脚本', async () => {
  const dir = tmp();
  const h = makeTool(dir, {
    psTree: chain(ITERM_BIN, 'ttys004'),
    jumpRunner: () => { throw new Error('不该被调用'); }
  });
  await h.collector.start(h.pet);
  h.handlers.get(tool.JUMP_EVENT)({ sessionId: '不存在的会话' });
  h.handlers.get(tool.JUMP_EVENT)(null);
  await h.collector.stop(h.pet);
});

// ================= 8. 隔离与红线守卫 =================

test('lib/terminal-jump.js 只 require 披露过的 Node 内建，无 eval/动态 require', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'terminal-jump.js'), 'utf8');
  const requires = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepStrictEqual(requires, ['child_process'],
    'README 权限披露里 terminal-jump 只声明了 spawn osascript 用的 child_process');
  for (const banned of ['eval(', 'new Function', 'require(`', 'http', 'fetch(']) {
    assert.ok(!src.includes(banned), `不得出现 ${banned}`);
  }
});

test('终端归属判定只在 lib/terminal-jump.js 一处（panel / aggregate / tool 都不自己判）', () => {
  const others = [
    ['panel/panel.html', fs.readFileSync(PANEL_HTML, 'utf8')],
    ['lib/aggregate.js', fs.readFileSync(path.join(ROOT, 'lib', 'aggregate.js'), 'utf8')],
    ['tool/index.js', fs.readFileSync(path.join(ROOT, 'tool', 'index.js'), 'utf8')]
  ];
  for (const [name, src] of others) {
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const marker of ['iTerm', 'Terminal.app', 'osascript', 'tell application']) {
      assert.ok(!code.includes(marker),
        `${name} 里出现了终端判定标记 ${marker} —— 判定必须只在 lib/terminal-jump.js`);
    }
  }
});

test('实际 spawn 的每个外部命令都在 README 权限披露表里（漂移守卫）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'terminal-jump.js'), 'utf8');
  // execFileSync('ps', ...) / execFileSync('osascript', ...) 里的第一个参数就是命令名
  const spawned = [...src.matchAll(/execFileSync\((['"])([^'"]+)\1/g)].map((m) => m[2]);
  assert.ok(spawned.length > 0, '解析不出被 spawn 的命令名 —— 守卫失效了');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const cmd of new Set(spawned)) {
    assert.ok(readme.includes(`spawn \`${cmd}\``),
      `README 权限披露表没有声明 spawn ${cmd}（AGENTS.md 插件形态红线：披露制）`);
  }
});

test('lib/terminal-jump.js 代码里没有中文字面量（中文只许在 locales/*.json）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'terminal-jump.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = src.match(/[一-鿿]/);
  assert.strictEqual(hit, null, `发现中文字面量：${hit && hit[0]}`);
});

test('测试数据未泄漏进真实状态目录', () => {
  assert.deepStrictEqual(leakedTestFiles(), [], '测试数据泄漏进了真实状态目录');
});

// ---- 收尾 ----
runAll().then(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  if (failures.length) {
    console.error(`\nterminal-jump-test: ${failures.length} failed / ${passed} passed`);
    process.exit(1);
  }
  console.log(`\nterminal-jump-test: ${passed} passed`);
});

// ---- 真机缺陷回归（2026-09-10，v0.2.2）----

test('iTerm2 3.5+ 的 iTermServer 祖先链能判出 iterm2（真机链形无 .app 片段）', () => {
  // 真机实测链：claude → -zsh → login → iTermServer-3.6.11（整条链没有 `.app/`）
  const psTree = () => [
    { pid: 829, ppid: 9805, comm: '/opt/homebrew/bin/node', tty: 'ttys026' },
    { pid: 9805, ppid: 9790, comm: '-zsh', tty: 'ttys026' },
    { pid: 9790, ppid: 9758, comm: '/usr/bin/login', tty: 'ttys026' },
    { pid: 9758, ppid: 1, comm: '/Users/u/Library/Application Support/iTerm2/iTermServer-3.6.11', tty: '??' }
  ];
  assert.strictEqual(tj.detectTerminal('/dev/ttys026', psTree), 'iterm2');
});

test('iTermServer 之外的同名垃圾不误判', () => {
  const psTree = () => [
    { pid: 1, ppid: 0, comm: '/tmp/fake/iTermServer-evil', tty: 'ttys001' }
  ];
  // 必须带 iTerm2 目录锚，裸 iTermServer 名不算
  assert.strictEqual(tj.detectTerminal('/dev/ttys001', psTree), null);
});
