'use strict';
// US-9 增强验收：终端标签标题解析器（lib/terminal-titles.js）。
// 夹具字符串照抄 fixtures/terminal-titles-facts.md 的本机实录（iTerm2 / Terminal.app 真输出），
// 不手造形态。全离线：execFile 一律注入，绝不 spawn 真 osascript
// （会触发自动化授权弹窗、查询真实终端）。

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createTerminalTitles, cleanTitle, LIST_SCRIPT } = require(path.join(ROOT, 'lib', 'terminal-titles.js'));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// facts §1/§2 实录输出（原样，含 spinner 与厂牌后缀）
const RECORDED = [
  '/dev/ttys017 | ◑ Desktop pet 插件调研与评估 (claude)',
  '/dev/ttys023 | ✳ Agent session插件能力 (claude)',
  '/dev/ttys022 | 桌宠测试版 (codex)',
  '/dev/ttys002 | ✳ Desktop pet meetings notes',
  ''
].join('\n');

test('清洗：去 spinner 前缀与厂牌后缀，标题本体原样保留', () => {
  assert.strictEqual(cleanTitle('◑ Desktop pet 插件调研与评估 (claude)'), 'Desktop pet 插件调研与评估');
  assert.strictEqual(cleanTitle('✳ Agent session插件能力 (claude)'), 'Agent session插件能力');
  assert.strictEqual(cleanTitle('桌宠测试版 (codex)'), '桌宠测试版', '无 spinner 时只去后缀');
  assert.strictEqual(cleanTitle('✳ Desktop pet meetings notes'), 'Desktop pet meetings notes', 'Terminal.app 无后缀形态');
});

test('清洗边界：空/纯符号/非字符串 → null（不造假名）；正文里的括号不受伤', () => {
  assert.strictEqual(cleanTitle(''), null);
  assert.strictEqual(cleanTitle('✳ '), null);
  assert.strictEqual(cleanTitle(null), null);
  assert.strictEqual(cleanTitle('修 (claude) 的 bug'), '修 (claude) 的 bug', '只去**结尾**厂牌后缀');
});

test('实录输出 → 按 tty 查标题；查不到 null', () => {
  const calls = [];
  const titles = createTerminalTitles({ execFile: (cmd, args) => { calls.push([cmd, args]); return RECORDED; }, now: () => 0 });
  assert.strictEqual(titles.lookup('/dev/ttys017'), 'Desktop pet 插件调研与评估');
  assert.strictEqual(titles.lookup('/dev/ttys002'), 'Desktop pet meetings notes');
  assert.strictEqual(titles.lookup('/dev/ttys999'), null);
  assert.strictEqual(calls.length, 1, 'TTL 内多次 lookup 只 spawn 一次');
  assert.strictEqual(calls[0][0], 'osascript');
});

test('TTL：窗口内用缓存；过后重查拿到改名后的标题', () => {
  let out = '/dev/ttys001 | ✳ 旧标题 (claude)\n';
  let clock = 0;
  const titles = createTerminalTitles({ execFile: () => out, now: () => clock, ttlMs: 1000 });
  assert.strictEqual(titles.lookup('/dev/ttys001'), '旧标题');
  out = '/dev/ttys001 | ✳ 新标题 (claude)\n';
  clock = 500;
  assert.strictEqual(titles.lookup('/dev/ttys001'), '旧标题', 'TTL 内不重 spawn');
  clock = 1500;
  assert.strictEqual(titles.lookup('/dev/ttys001'), '新标题');
});

test('osascript 挂了（未授权/超时/缺失）：空表不抛，TTL 后重试成功可恢复', () => {
  let fail = true;
  let clock = 0;
  const titles = createTerminalTitles({
    execFile: () => { if (fail) throw new Error('not authorized'); return '/dev/ttys001 | ✳ 恢复了 (claude)\n'; },
    now: () => clock, ttlMs: 1000
  });
  assert.strictEqual(titles.lookup('/dev/ttys001'), null, '失败静默为查不到');
  fail = false;
  clock = 500;
  assert.strictEqual(titles.lookup('/dev/ttys001'), null, 'TTL 内不重试（不反复 spawn 打扰系统）');
  clock = 1500;
  assert.strictEqual(titles.lookup('/dev/ttys001'), '恢复了');
});

test('垃圾输出行照单跳过；非法入参 null', () => {
  const titles = createTerminalTitles({
    execFile: () => 'garbage no separator\nttys001 | 不是 /dev 开头\n/dev/ttys009 | ✳ 好行 (claude)\n',
    now: () => 0
  });
  assert.strictEqual(titles.lookup('/dev/ttys009'), '好行');
  assert.strictEqual(titles.lookup('ttys001'), null);
  assert.strictEqual(titles.lookup(null), null);
  assert.strictEqual(titles.lookup(''), null);
});

test('AppleScript 守卫在位：is running 判定 + 两家各自 try（facts §3 两个坑）', () => {
  // 「tell 会拉起没在跑的 App」「不存在的 application 直接抛错」都只能靠脚本文本守住，
  // 这里锚定脚本里必须有守卫结构（改脚本时先想清楚这两个坑）。
  assert.ok(/if application "iTerm2" is running then/.test(LIST_SCRIPT), 'iTerm2 缺 is running 守卫');
  assert.ok(/if application "Terminal" is running then/.test(LIST_SCRIPT), 'Terminal 缺 is running 守卫');
  assert.ok((LIST_SCRIPT.match(/\btry\b/g) || []).length >= 2, '两家查询块必须各自 try 包裹');
});

console.log(`\nterminal-titles-test: ${passed} passed`);
