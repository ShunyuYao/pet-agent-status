'use strict';
// 子进程 agent 会话识别（lib/nested-session.js）。
//
// 需求（2026-09-12 用户）：别人起的 agent 子进程会话不该进面板——既跳不过去
// （它没有自己的终端，tty 是从父会话继承来的），也不是用户在跟的任务。
//
// 判据来自真机实录（fixtures/nested-session-facts.md）：**祖先链上除了自己这个
// claude 进程之外还有第二个 claude** = 它是别的 agent 起的子进程。
// 夹具全部照抄实录 ps 输出，不手搓想象中的进程树。

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { isNestedByPs, parsePs, CLAUDE_COMM } = require(path.join(ROOT, 'lib', 'nested-session.js'));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// ---- 实录夹具 ----

// ① 嵌套：本会话（99593）的 Bash 工具里跑 `claude -p`（2026-09-12 实测）
const NESTED = `
74691 74690 ?? claude
74690 74682 ?? timeout
74682 99593 ?? /bin/zsh
99593  9762 ttys018 claude
 9762  9760 ttys018 -zsh
 9760  9758 ttys018 /usr/bin/login
 9758     1 ?? /Users/shunyu/Library/Application Support/iTerm2/iTermServer-3.6.11
    1     0 ?? /sbin/launchd
`;
const NESTED_HOOK_PPID = 74691;   // hook 的父进程 = 那个嵌套的 claude

// ② 交互式终端会话（同一份实录的上半截）
const INTERACTIVE = NESTED;
const INTERACTIVE_HOOK_PPID = 99593;

// ③ Claude Desktop App 会话——**假阳性守卫**。
// App 主进程 comm 是 `/Applications/Claude.app/Contents/MacOS/Claude`（大写 C），
// 内嵌 CLI 是 `.../claude-code/<ver>/claude.app/Contents/MacOS/claude`（小写）。
// 大小写不敏感的匹配会把 App 主进程当成"第二个 claude"，于是刚做完的 App 会话
// 支持会被整个判成嵌套、一条都不显示。
const APP = `
36703  4672 ?? /Users/shunyu/Library/Application Support/Claude/claude-code/2.1.205/claude.app/Contents/MacOS/claude
 4672  4660 ?? /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper
 4660     1 ?? /Applications/Claude.app/Contents/MacOS/Claude
    1     0 ?? /sbin/launchd
`;
const APP_HOOK_PPID = 36703;

test('嵌套：祖先链上有第二个 claude → 判为子进程会话', () => {
  assert.strictEqual(isNestedByPs(NESTED_HOOK_PPID, NESTED), true);
});

test('交互式终端会话：链上只有自己一个 claude → 不是子进程会话', () => {
  assert.strictEqual(isNestedByPs(INTERACTIVE_HOOK_PPID, INTERACTIVE), false);
});

test('Claude Desktop App 会话不得被误判为嵌套（大小写敏感的假阳性守卫）', () => {
  assert.strictEqual(isNestedByPs(APP_HOOK_PPID, APP), false,
    'App 主进程 comm 是大写 Claude，绝不能算作第二个 claude');
  // 反向证明这条守卫不是靠"链太短"侥幸通过：把大小写敏感去掉就会红
  const rows = parsePs(APP);
  const lowered = rows.filter((r) => r.comm.toLowerCase().endsWith('/claude') || r.comm.toLowerCase() === 'claude');
  assert.ok(lowered.length >= 2, '夹具本身必须含有会被大小写不敏感匹配误命中的祖先');
});

test('拿不到进程表 / 链断了 / 非 claude 安装形态：一律当作不是嵌套（fail-open）', () => {
  // 漏掉一条子进程会话只是噪音；错删一条用户真在跟的会话是丢失信息，所以方向性保守
  assert.strictEqual(isNestedByPs(74691, ''), false, 'ps 读不出来不该判嵌套');
  assert.strictEqual(isNestedByPs(999999, NESTED), false, '链上找不到自己不该判嵌套');
  // npm 安装形态：agent 进程 comm 是 node，链上一个 claude 都匹配不到
  const NPM = `
5001 5000 ?? node
5000 4999 ?? /bin/zsh
4999    1 ttys003 -zsh
`;
  assert.strictEqual(isNestedByPs(5001, NPM), false, '匹配不到 claude 时保持显示');
});

test('ppid 成环不会把 hook 挂死', () => {
  const CYCLE = `
100 200 ?? claude
200 100 ?? claude
`;
  // 成环时既要终止，也要给出答案（这里确实有两个 claude）
  assert.strictEqual(isNestedByPs(100, CYCLE), true);
});

test('parsePs：comm 含空格（App 路径里就有）时只切前三列', () => {
  const rows = parsePs(APP);
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[1].comm,
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper');
  assert.strictEqual(CLAUDE_COMM, 'claude');
});

console.log(`\nnested-session-test: ${passed} passed`);
