'use strict';
// US-002 验收测试（安装器侧）：安装 → 再安装（幂等）→ 卸载（用户条目逐字节原样保留）。
// 全离线：settings.json 一律 mkdtemp + PET_AS_CLAUDE_SETTINGS 覆盖，绝不碰真实 ~/.claude。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const installer = require(path.join(ROOT, 'lib', 'claude-hooks-installer.js'));
const { HOOKED_EVENTS } = require(path.join(ROOT, 'lib', 'claude-events.js'));

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-inst-'));
  tmpDirs.push(d);
  return d;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// 用户原有配置：既有自己的 hooks，也有和本插件无关的顶层设置
const USER_SETTINGS = {
  model: 'opus',
  env: { FOO: 'bar' },
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    // 与本插件挂同一个事件的用户条目 —— 最容易被粗暴覆盖的情况
    Stop: [
      { matcher: '', hooks: [{ type: 'command', command: '/Users/u/bin/my-notify.sh' }] }
    ],
    // 本插件完全不碰的事件
    SubagentStop: [
      { hooks: [{ type: 'command', command: '/Users/u/bin/other.sh' }] }
    ]
  }
};

function seed(content) {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  return file;
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const FAKE_CMD = '/opt/node /plugins/pet-agent-status/hooks/claude-status-hook.js';
const opts = (file) => ({ settingsFile: file, command: FAKE_CMD });

// ---- 1. 安装：挂全事件、保留用户条目、写备份 ----
test('install 为映射表里每个事件挂上本插件条目', () => {
  const file = seed(USER_SETTINGS);
  installer.install(opts(file));
  const s = read(file);
  for (const event of HOOKED_EVENTS) {
    const list = s.hooks[event];
    assert.ok(Array.isArray(list), `事件 ${event} 未挂钩`);
    assert.ok(
      list.some((e) => (e.hooks || []).some((h) => h.command === FAKE_CMD)),
      `事件 ${event} 里找不到本插件条目`
    );
  }
  // 挂钩事件集合必须与 PROTOCOL.md 映射表一致
  assert.deepStrictEqual(
    HOOKED_EVENTS.slice().sort(),
    ['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']
  );
});

test('install 保留用户已有 hooks 与其它顶层设置', () => {
  const file = seed(USER_SETTINGS);
  installer.install(opts(file));
  const s = read(file);

  assert.strictEqual(s.model, 'opus');
  assert.deepStrictEqual(s.env, { FOO: 'bar' });
  assert.deepStrictEqual(s.permissions, { allow: ['Bash(ls:*)'] });

  // 同事件下用户条目原样还在，且没被挪到别的事件
  assert.deepStrictEqual(
    s.hooks.Stop.find((e) => !e['pet-agent-status']),
    USER_SETTINGS.hooks.Stop[0],
    'Stop 下的用户条目必须逐字段原样保留'
  );
  // 本插件不碰的事件完全不动
  assert.deepStrictEqual(s.hooks.SubagentStop, USER_SETTINGS.hooks.SubagentStop);
});

test('install 写前备份到 .bak-pet-agent-status，内容是改动前原文', () => {
  const file = seed(USER_SETTINGS);
  const original = fs.readFileSync(file, 'utf8');
  const res = installer.install(opts(file));
  assert.strictEqual(res.backupFile, file + '.bak-pet-agent-status');
  assert.strictEqual(fs.readFileSync(res.backupFile, 'utf8'), original, '备份必须是改动前的原文');
});

test('settings.json 不存在时 install 创建它（连同父目录）', () => {
  const dir = tmp();
  const file = path.join(dir, 'nested', '.claude', 'settings.json');
  const res = installer.install(opts(file));
  assert.strictEqual(res.backupFile, null, '原文件不存在就没有备份');
  const s = read(file);
  assert.ok(s.hooks.SessionStart, '新建的配置里应有挂钩');
});

// ---- 2. 幂等 ----
test('重复 install 不产生重复条目（幂等）', () => {
  const file = seed(USER_SETTINGS);
  installer.install(opts(file));
  const after1 = fs.readFileSync(file, 'utf8');
  installer.install(opts(file));
  installer.install(opts(file));
  const after3 = fs.readFileSync(file, 'utf8');

  assert.strictEqual(after3, after1, '第 2/3 次安装后文件应逐字节不变');
  const s = read(file);
  for (const event of HOOKED_EVENTS) {
    const ours = s.hooks[event].filter((e) => (e.hooks || []).some((h) => h.command === FAKE_CMD));
    assert.strictEqual(ours.length, 1, `事件 ${event} 下本插件条目重复了 ${ours.length} 次`);
  }
});

test('isInstalled 在安装前后正确反映状态（面板据此显示「已接入 ✓」）', () => {
  const file = seed(USER_SETTINGS);
  assert.strictEqual(installer.isInstalled(opts(file)), false);
  installer.install(opts(file));
  assert.strictEqual(installer.isInstalled(opts(file)), true);
  installer.uninstall(opts(file));
  assert.strictEqual(installer.isInstalled(opts(file)), false);
});

// ---- 3. 卸载：只摘自己，用户配置逐字节还原 ----
test('uninstall 后 settings.json 与安装前逐字节相同', () => {
  const file = seed(USER_SETTINGS);
  const original = fs.readFileSync(file, 'utf8');
  installer.install(opts(file));
  installer.uninstall(opts(file));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original, '卸载必须干净还原用户配置');
});

test('uninstall 只摘本插件条目，用户在同事件下的条目保留', () => {
  const file = seed(USER_SETTINGS);
  installer.install(opts(file));
  const res = installer.uninstall(opts(file));
  assert.strictEqual(res.removed, HOOKED_EVENTS.length, '摘除条数应等于挂钩事件数');
  const s = read(file);
  assert.deepStrictEqual(s.hooks.Stop, USER_SETTINGS.hooks.Stop);
  assert.deepStrictEqual(s.hooks.SubagentStop, USER_SETTINGS.hooks.SubagentStop);
  // 本插件独占的事件在卸载后不留空壳
  assert.ok(!('SessionStart' in s.hooks), '空事件 key 应被删除');
});

test('用户完全没有 hooks 时，装了再卸能回到没有 hooks 键的状态', () => {
  const file = seed({ model: 'opus' });
  const original = fs.readFileSync(file, 'utf8');
  installer.install(opts(file));
  installer.uninstall(opts(file));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  assert.ok(!('hooks' in read(file)), 'hooks 整个空了就该删掉，不留空壳');
});

test('uninstall 不误伤别的插件挂在同事件的条目', () => {
  const otherCmd = '/opt/node /plugins/other-plugin/hook.js';
  const file = seed(USER_SETTINGS);
  installer.install(opts(file));
  installer.install({ settingsFile: file, command: otherCmd });
  installer.uninstall(opts(file));
  const s = read(file);
  for (const event of HOOKED_EVENTS) {
    const list = s.hooks[event] || [];
    assert.ok(
      list.some((e) => (e.hooks || []).some((h) => h.command === otherCmd)),
      `事件 ${event} 下别的插件条目被误删`
    );
    assert.ok(
      !list.some((e) => (e.hooks || []).some((h) => h.command === FAKE_CMD)),
      `事件 ${event} 下本插件条目没摘干净`
    );
  }
});

test('settings.json 不存在时 uninstall 不抛、不创建文件', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  const res = installer.uninstall(opts(file));
  assert.strictEqual(res.removed, 0);
  assert.ok(!fs.existsSync(file), '卸载不该凭空造出配置文件');
});

// ---- 4. 损坏配置不许被当空文件覆盖（不可逆数据丢失）----
test('settings.json 损坏时 install 抛错而不是覆盖用户内容', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  const broken = '{ "model": "opus", oops';
  fs.writeFileSync(file, broken, 'utf8');
  assert.throws(() => installer.install(opts(file)), '损坏配置必须报错让用户知情');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), broken, '用户原内容必须原封不动');
});

// ---- 5. 真实产出的 command 指向真实存在的 hook 脚本 ----
test('默认 hookCommand 指向仓内真实存在的 hook 脚本', () => {
  const cmd = installer.hookCommand();
  const scriptPath = cmd.slice(cmd.indexOf(' ') + 1);
  assert.ok(fs.existsSync(scriptPath), `hook 脚本不存在: ${scriptPath}`);
  assert.strictEqual(path.basename(scriptPath), 'claude-status-hook.js');
});

// ---- 6. 端到端：装完的 command 真的能跑起来并写状态文件 ----
test('安装写入的 command 原样执行可产出状态文件（闭环自证）', () => {
  const file = seed(USER_SETTINGS);
  installer.install({ settingsFile: file });
  const entry = read(file).hooks.SessionStart.find((e) => e['pet-agent-status']);
  const cmd = entry.hooks[0].command;
  const sep = cmd.indexOf(' ');
  const [bin, script] = [cmd.slice(0, sep), cmd.slice(sep + 1)];

  const stateDir = tmp();
  const payload = fs.readFileSync(path.join(ROOT, 'fixtures', 'claude-code-events', 'session-start.json'), 'utf8');
  const res = spawnSync(bin, [script], {
    input: payload,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PET_AGENT_STATUS_DIR: stateDir })
  });
  assert.strictEqual(res.status, 0);
  const files = fs.readdirSync(stateDir).filter((n) => n.endsWith('.json'));
  assert.deepStrictEqual(files, ['fx-sess-001.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stateDir, files[0]), 'utf8')).state, 'running');
});

// ---- 7. 隔离自证 ----
test('测试期间未修改真实 ~/.claude/settings.json', () => {
  const real = path.join(os.homedir(), '.claude', 'settings.json');
  assert.ok(!fs.existsSync(real + '.bak-pet-agent-status'), '真实配置被动过（出现了备份文件）');
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nclaude-installer-test: ${passed} passed`);
