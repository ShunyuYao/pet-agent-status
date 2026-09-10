'use strict';
// US-002 验收测试（hook 侧）：用 fixtures/claude-code-events/*.json 真实喂 stdin，
// 断言落盘状态文件的内容。**不直调脚本内部函数**（AGENTS.md 质量门禁）。
// 全离线：状态目录一律 mkdtemp + PET_AGENT_STATUS_DIR 覆盖，绝不碰真实 ~/.local/state。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'claude-status-hook.js');
const FIXTURES = path.join(ROOT, 'fixtures', 'claude-code-events');

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-hook-'));
  tmpDirs.push(d);
  return d;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// 真实动作等价物：spawn hook 脚本，把 payload 从 stdin 灌进去，等它退出。
function runHook(payload, dir, extraEnv) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PET_AGENT_STATUS_DIR: dir }, extraEnv || {})
  });
  return res;
}

function runFixture(name, dir) {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return runHook(raw, dir);
}

function readOnly(dir) {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.strictEqual(files.length, 1, `期望状态目录里只有一个状态文件，实际: ${files.join(',')}`);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

// ---- 1. PROTOCOL.md 映射表逐行 ----
const MAPPING = [
  ['session-start.json', 'SessionStart', 'running'],
  ['user-prompt-submit.json', 'UserPromptSubmit', 'running'],
  ['pre-tool-use.json', 'PreToolUse', 'running'],
  ['post-tool-use.json', 'PostToolUse', 'running'],
  ['notification-permission.json', 'Notification', 'waiting'],
  ['stop.json', 'Stop', 'done'],
  ['session-end.json', 'SessionEnd', 'ended']
];

for (const [fixture, event, state] of MAPPING) {
  test(`${event} → state=${state}（夹具 ${fixture} 经 stdin）`, () => {
    const dir = tmp();
    const res = runFixture(fixture, dir);
    assert.strictEqual(res.status, 0, `hook 必须退出 0，实际 ${res.status} / ${res.stderr}`);
    const rec = readOnly(dir);
    assert.strictEqual(rec.state, state);
    assert.strictEqual(rec.lastEvent, event);
  });
}

// ---- 2. 落盘记录符合 schema:1 ----
test('落盘记录字段齐全且符合 PROTOCOL.md schema:1', () => {
  const dir = tmp();
  const before = Date.now();
  runFixture('user-prompt-submit.json', dir);
  const rec = readOnly(dir);

  assert.strictEqual(rec.schema, 1);
  assert.strictEqual(rec.agent, 'claude-code');
  assert.strictEqual(rec.sessionId, 'fx-sess-001');
  assert.strictEqual(rec.cwd, '/Users/u/projects/demo');
  assert.strictEqual(rec.project, 'demo', 'project = basename(cwd)');
  assert.ok(rec.tty === null || typeof rec.tty === 'string', 'tty 必须是 string|null');
  assert.ok(rec.pid === null || Number.isFinite(rec.pid), 'pid 必须是 number|null');
  assert.strictEqual(rec.source, 'hook');
  assert.ok(Number.isInteger(rec.ts) && rec.ts >= before && rec.ts <= Date.now(), 'ts 是 Unix 毫秒');

  // 协议必填项一个都不许少
  for (const key of ['schema', 'agent', 'sessionId', 'cwd', 'project', 'tty', 'pid', 'state', 'lastEvent', 'ts']) {
    assert.ok(key in rec, `缺必填字段 ${key}`);
  }
  // 未在协议里的字段不许乱写（会话正文尤其不许采集）
  const extra = Object.keys(rec).filter((k) => ![
    'schema', 'agent', 'sessionId', 'cwd', 'project', 'tty', 'pid', 'state', 'lastEvent', 'ts', 'threadId', 'source'
  ].includes(k));
  assert.deepStrictEqual(extra, [], `写入了协议外字段: ${extra.join(',')}`);
  assert.ok(!JSON.stringify(rec).includes('修个 bug'), '绝不采集会话正文（prompt 内容）');
});

test('pid 写的是 Claude Code 进程（父进程），不是 hook 自己', () => {
  const dir = tmp();
  const res = runFixture('stop.json', dir);
  const rec = readOnly(dir);
  // hook 自己的 pid 退出后就没了，拿来做存活探测毫无意义；父进程才是被观测对象。
  assert.notStrictEqual(rec.pid, res.pid, 'pid 不该是 hook 自身的 pid');
  assert.strictEqual(rec.pid, process.pid, '父进程即本测试进程');
});

// ---- 3. 同会话多事件覆盖写同一个文件 ----
test('同一 session 连续事件覆盖同一个文件（不堆积）', () => {
  const dir = tmp();
  runFixture('session-start.json', dir);
  runFixture('notification-permission.json', dir);
  runFixture('stop.json', dir);
  const rec = readOnly(dir); // readOnly 内断言只有一个 .json
  assert.strictEqual(rec.state, 'done', '最后一个事件生效');
  assert.strictEqual(rec.lastEvent, 'Stop');
});

// ---- 4. 绝不阻塞 Claude Code：坏输入一律退出 0 且不写坏文件 ----
const BAD_INPUTS = [
  ['空 stdin', ''],
  ['非 JSON', 'not json at all'],
  ['JSON 但不是对象', '"a string"'],
  ['null', 'null'],
  ['缺 session_id', JSON.stringify({ cwd: '/tmp/x', hook_event_name: 'Stop' })],
  ['缺 cwd', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' })],
  ['未知事件名', JSON.stringify({ session_id: 's1', cwd: '/tmp/x', hook_event_name: 'SomeFutureEvent' })],
  ['事件名缺失', JSON.stringify({ session_id: 's1', cwd: '/tmp/x' })]
];

for (const [label, input] of BAD_INPUTS) {
  test(`坏输入「${label}」退出 0 且不产生状态文件`, () => {
    const dir = tmp();
    const res = runHook(input, dir);
    assert.strictEqual(res.status, 0, `必须退出 0（绝不阻塞 Claude Code），实际 ${res.status}`);
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    assert.deepStrictEqual(files, [], `不该写出状态文件，实际: ${files.join(',')}`);
  });
}

test('状态目录不可写时仍退出 0（磁盘/权限故障不许打扰会话）', () => {
  const dir = tmp();
  // 用一个「父路径是文件」的目录，mkdirSync 必失败
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');
  const res = runHook(fs.readFileSync(path.join(FIXTURES, 'stop.json'), 'utf8'), path.join(blocker, 'sub'));
  assert.strictEqual(res.status, 0, `必须退出 0，实际 ${res.status} / ${res.stderr}`);
});

// ---- 5. sessionId 清洗（防路径穿越）----
test('恶意 session_id 被清洗，不穿越出状态目录', () => {
  const dir = tmp();
  runHook({
    session_id: '../../etc/passwd',
    cwd: '/Users/u/projects/demo',
    hook_event_name: 'SessionStart'
  }, dir);
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.strictEqual(files.length, 1);
  assert.ok(/^[A-Za-z0-9._-]+\.json$/.test(files[0]), `文件名未清洗: ${files[0]}`);
  assert.ok(!fs.existsSync('/etc/passwd.json'), '绝不许写到目录外');
});

// ---- 6. 隔离自证：全程没碰真实状态目录 ----
test('测试期间未写入真实 ~/.local/state/pet-agent-status', () => {
  const real = path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
  assert.ok(!fs.existsSync(real), `真实状态目录被污染: ${real}`);
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nclaude-hook-test: ${passed} passed`);
