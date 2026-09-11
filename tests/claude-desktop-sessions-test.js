'use strict';
// Claude Desktop App 会话适配器验收（lib/claude-desktop-sessions.js）。
// 需求（fixtures/claude-desktop-facts.md §5）：
//   ① App 会话标题反查：claude-code-sessions/<acct>/<org>/local_*.json 的
//      cliSessionId → title（AI 标题落盘，与 CLI「标题不落盘」相反）；
//   ② tty:null 跳转兜底：能证明是 App 会话的行才给「激活 Claude App」入口——无假入口。
// 全离线：appSupportDir 一律 mkdtemp 注入，绝不读真实 ~/Library/Application Support/Claude。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  createClaudeDesktopSessions, pickAppNavigator, activateClaudeApp, CLAUDE_BUNDLE_ID
} = require(path.join(ROOT, 'lib', 'claude-desktop-sessions.js'));

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-ccd-'));
  tmpDirs.push(d);
  return d;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const CLI_ID = 'aaaa1111-7d0b-4aee-85ee-1a3d02f527c2';   // hooks 收到的 CLI 会话 uuid
const CLI_ID2 = 'bbbb2222-b23a-4335-b4d9-c30b0e315be8';

// 夹具形态照抄实录结构（facts §2）：claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json
function writeMeta(dir, name, obj) {
  const orgDir = path.join(dir, 'claude-code-sessions', 'acct-f0cf3203', 'org-bea1408f');
  fs.mkdirSync(orgDir, { recursive: true });
  fs.writeFileSync(path.join(orgDir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

// ---- ① 标题反查 ----

test('cliSessionId → title：实录形态的元数据能查到 AI 标题', () => {
  const dir = tmp();
  writeMeta(dir, 'local_a.json', {
    sessionId: 'local_a', cliSessionId: CLI_ID,
    cwd: '/tmp/x', title: 'Initialize Claude project setup', titleSource: 'auto',
    createdAt: 1, lastActivityAt: 2
  });
  const s = createClaudeDesktopSessions({ appSupportDir: dir, now: () => 0 });
  assert.strictEqual(s.lookupTitle(CLI_ID), 'Initialize Claude project setup');
  assert.strictEqual(s.lookupTitle('cccc3333-0000-4000-8000-000000000000'), null, '查不到返回 null，不造假标题');
});

test('目录不存在 / 元数据损坏 / title 空 / 无 cliSessionId：全部静默降级为查不到', () => {
  const none = createClaudeDesktopSessions({ appSupportDir: path.join(tmp(), '不存在'), now: () => 0 });
  assert.strictEqual(none.lookupTitle(CLI_ID), null, '缺目录不该抛');

  const dir = tmp();
  writeMeta(dir, 'local_bad.json', '{ 这不是 JSON');
  writeMeta(dir, 'local_empty.json', { sessionId: 'local_e', cliSessionId: CLI_ID, title: '' });
  // 实录（facts §2）：较新的 local_3f92a198 压根没有 cliSessionId 字段——这类会话映射不出来，
  // 诚实降级（无标题、无跳转入口），绝不按 cwd 之类的模糊线索乱配
  writeMeta(dir, 'local_nocli.json', { sessionId: 'local_n', title: '有标题但没有 cliSessionId' });
  const s = createClaudeDesktopSessions({ appSupportDir: dir, now: () => 0 });
  assert.strictEqual(s.lookupTitle(CLI_ID), null, '空 title 不算标题');
  assert.strictEqual(s.has(CLI_ID), false);
});

test('TTL 缓存：窗口内不重扫目录，过窗才看到新写入的元数据', () => {
  const dir = tmp();
  let clock = 0;
  const s = createClaudeDesktopSessions({ appSupportDir: dir, now: () => clock, ttlMs: 1000 });
  assert.strictEqual(s.lookupTitle(CLI_ID), null);
  writeMeta(dir, 'local_a.json', { sessionId: 'local_a', cliSessionId: CLI_ID, title: '新会话名' });
  clock = 500;
  assert.strictEqual(s.lookupTitle(CLI_ID), null, 'TTL 内不该重扫');
  clock = 1500;
  assert.strictEqual(s.lookupTitle(CLI_ID), '新会话名', '过 TTL 该刷新');
});

test('多份元数据各自映射；同一 cliSessionId 取 lastActivityAt 较新的一份', () => {
  const dir = tmp();
  writeMeta(dir, 'local_a.json', { sessionId: 'local_a', cliSessionId: CLI_ID, title: '旧名', lastActivityAt: 100 });
  writeMeta(dir, 'local_b.json', { sessionId: 'local_b', cliSessionId: CLI_ID, title: '新名', lastActivityAt: 200 });
  writeMeta(dir, 'local_c.json', { sessionId: 'local_c', cliSessionId: CLI_ID2, title: '另一条' });
  const s = createClaudeDesktopSessions({ appSupportDir: dir, now: () => 0 });
  assert.strictEqual(s.lookupTitle(CLI_ID), '新名');
  assert.strictEqual(s.lookupTitle(CLI_ID2), '另一条');
});

// ---- ② tty:null 跳转兜底（无假入口）----

test('pickAppNavigator：claude-code + 无 tty + App 归属成立 才给入口', () => {
  const has = (id) => id === CLI_ID;
  const row = { agent: 'claude-code', sessionId: CLI_ID, tty: null };
  const nav = pickAppNavigator(row, has);
  assert.ok(nav && nav.kind === 'claude-app', 'App 会话该给激活入口');
  // 反例逐条：有 tty（终端会话走既有 tty 链路）/ 归属不成立 / 不是 claude-code / 空行
  assert.strictEqual(pickAppNavigator({ agent: 'claude-code', sessionId: CLI_ID, tty: '/dev/ttys004' }, has), null);
  assert.strictEqual(pickAppNavigator({ agent: 'claude-code', sessionId: 'other', tty: null }, has), null,
    '证明不了是 App 会话就不给入口——假入口点了没反应');
  assert.strictEqual(pickAppNavigator({ agent: 'codex', sessionId: CLI_ID, tty: null }, has), null,
    'codex 行有自己的深链接路，不走这条');
  assert.strictEqual(pickAppNavigator(null, has), null);
  // has 抛错不外泄（判定读外部存储，什么都可能发生）
  assert.strictEqual(pickAppNavigator(row, () => { throw new Error('boom'); }), null);
});

test('activateClaudeApp：按 bundle id 激活（不按 App 名，防重名 App 误中）；失败不 throw', () => {
  const calls = [];
  const r = activateClaudeApp((cmd, args) => calls.push([cmd, args]));
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(CLAUDE_BUNDLE_ID, 'com.anthropic.claudefordesktop');
  assert.deepStrictEqual(calls, [['open', ['-b', CLAUDE_BUNDLE_ID]]]);
  const bad = activateClaudeApp(() => { throw new Error('kLSApplicationNotFoundErr'); });
  assert.deepStrictEqual(bad, { ok: false, reason: 'failed' });
});

// ---- 路径覆盖（测试隔离约定，同 PET_AS_CLAUDE_SETTINGS 精神）----

test('PET_AS_CLAUDE_APP_SUPPORT 覆盖默认目录（E2E/测试隔离用）', () => {
  const dir = tmp();
  writeMeta(dir, 'local_a.json', { sessionId: 'local_a', cliSessionId: CLI_ID, title: '覆盖目录里的名字' });
  const old = process.env.PET_AS_CLAUDE_APP_SUPPORT;
  process.env.PET_AS_CLAUDE_APP_SUPPORT = dir;
  try {
    const s = createClaudeDesktopSessions({ now: () => 0 });
    assert.strictEqual(s.lookupTitle(CLI_ID), '覆盖目录里的名字');
  } finally {
    if (old == null) delete process.env.PET_AS_CLAUDE_APP_SUPPORT;
    else process.env.PET_AS_CLAUDE_APP_SUPPORT = old;
  }
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nclaude-desktop-sessions-test: ${passed} passed`);
