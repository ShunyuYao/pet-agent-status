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

// 播种夹具。`indent` 可传 4 / '\t' / 0 等，用来造出**与 writeSettings 输出不同源**的排版
// —— 默认用 2 空格会恰好命中 writeSettings 唯一会输出的那种风格，断言恒真（US-001
// 「夹具形态现实中不存在」教训的同型复发，criteria/US-002.md §3 已明令封死）。
function seed(content, indent = 2, trailingNewline = true) {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) {
    const body = JSON.stringify(content, null, indent);
    fs.writeFileSync(file, trailingNewline ? `${body}\n` : body, 'utf8');
  }
  return file;
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// criteria §3 的「语义等价 + 键序保持」判据。递归比对 key 顺序，
// 因为 deepStrictEqual 对 {a,b} 与 {b,a} 是相等的，键序得单独查。
function keyOrder(value) {
  if (Array.isArray(value)) return value.map(keyOrder);
  if (value && typeof value === 'object') {
    return Object.keys(value).map((k) => [k, keyOrder(value[k])]);
  }
  return null;
}

function assertSemanticRestore(file, originalText, label) {
  const before = JSON.parse(originalText);
  const after = read(file);
  assert.deepStrictEqual(after, before, `${label}：语义必须等价`);
  assert.deepStrictEqual(keyOrder(after), keyOrder(before), `${label}：键序必须保持`);
}

const FAKE_CMD = '/opt/node /plugins/pet-agent-status/hooks/claude-status-hook.js';

// 闭环用例喂的是实录夹具，落盘文件名由夹具的 session_id 决定，会随重录而变。
// 从夹具现读，别把某次录制的字面值抄进断言。
const SESSION_START_FIXTURE = path.join(ROOT, 'fixtures', 'claude-code-events', 'session-start.json');
const EXPECTED_STATE_FILE =
  `${JSON.parse(fs.readFileSync(SESSION_START_FIXTURE, 'utf8')).session_id}.json`;
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

test('重复 install 不覆盖首份备份（备份恒为接入前原文）', () => {
  const file = seed(USER_SETTINGS);
  const original = fs.readFileSync(file, 'utf8');
  const res = installer.install(opts(file));
  installer.install(opts(file)); // 用户再点一次「一键接入」
  assert.strictEqual(
    fs.readFileSync(res.backupFile, 'utf8'), original,
    '第二次安装把备份刷成了「已含本插件钩子」的版本，回滚将失效'
  );
  // 备份的唯一用途：cp 回去后必须回到「未接入」
  fs.copyFileSync(res.backupFile, file);
  assert.strictEqual(installer.isInstalled(opts(file)), false, '用备份回滚后应回到未接入状态');
});

test('uninstall 也不覆盖首份备份', () => {
  const file = seed(USER_SETTINGS);
  const original = fs.readFileSync(file, 'utf8');
  const res = installer.install(opts(file));
  installer.uninstall(opts(file));
  assert.strictEqual(fs.readFileSync(res.backupFile, 'utf8'), original, '卸载不该刷新备份');
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

// ---- 3. 卸载：只摘自己，用户配置还原（判据见 criteria/US-002.md §3）----
test('uninstall 后逐字节还原（原文为 2 空格风格的保底要求）', () => {
  const file = seed(USER_SETTINGS, 2);
  const original = fs.readFileSync(file, 'utf8');
  installer.install(opts(file));
  installer.uninstall(opts(file));
  assert.strictEqual(
    fs.readFileSync(file, 'utf8'), original,
    '原文即 stringify(,,2)+\\n 风格时，往返必须逐字节相同'
  );
});

test('uninstall 后语义等价 + 键序保持（夹具用非 2 空格风格，防同源自证）', () => {
  // 这三种排版 writeSettings 都不会原样输出，所以断言不再恒真 ——
  // 它们真正考的是「有没有把用户内容改坏 / 把键序打乱」。
  for (const [label, indent, nl] of [['4 空格', 4, true], ['tab 缩进', '\t', true], ['紧凑单行', 0, false]]) {
    const file = seed(USER_SETTINGS, indent, nl);
    const original = fs.readFileSync(file, 'utf8');
    // 夹具确实与实现输出不同源，否则这条用例白测
    assert.notStrictEqual(
      original, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`,
      `${label}：夹具必须与 writeSettings 输出风格不同`
    );
    installer.install(opts(file));
    installer.uninstall(opts(file));
    assertSemanticRestore(file, original, label);
  }
});

test('install 不打乱用户原有的键序', () => {
  const file = seed(USER_SETTINGS, 4);
  installer.install(opts(file));
  const s = read(file);
  // 顶层：用户的四个 key 原序在前，本插件不插队到中间
  assert.deepStrictEqual(
    Object.keys(s).filter((k) => k in USER_SETTINGS),
    Object.keys(USER_SETTINGS),
    '顶层键序被打乱'
  );
  // Stop 事件下用户条目仍排在本插件条目之前
  const stopCmds = s.hooks.Stop.map((e) => (e.hooks || []).map((h) => h.command).join(','));
  assert.strictEqual(stopCmds[0], '/Users/u/bin/my-notify.sh', '用户条目必须仍在最前');
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

// ---- 3c. 删键粒度：只删本插件创建的键，用户原有的键（含空数组）一律保留 ----
// 上一版按「摘除后为空就删 key」判定，与「是谁创建的」无关 —— 用户原有的
// `PreCompact: []`（占位/临时注释掉钩子时很常见）会被静默删掉。空数组不是垃圾，
// 是用户的配置内容；本插件只有权收回自己创建的键。
test('用户原有的空事件键（PreCompact: []）装卸后仍在且仍为空数组', () => {
  const withEmptyKey = {
    model: 'opus',
    hooks: {
      PreCompact: [],                 // 用户原有的空数组键，本插件完全不碰
      Stop: [{ hooks: [{ type: 'command', command: '/Users/u/bin/my-notify.sh' }] }]
    }
  };
  const file = seed(withEmptyKey);
  const original = fs.readFileSync(file, 'utf8');
  installer.install(opts(file));
  installer.uninstall(opts(file));

  // 全对象等价：不只查 PreCompact 在不在，整份配置都必须还原
  assert.deepStrictEqual(read(file), withEmptyKey, '用户原有的空事件键被删掉了');
  assert.deepStrictEqual(read(file).hooks.PreCompact, [], 'PreCompact 应仍为空数组');
  assertSemanticRestore(file, original, '含用户空事件键');
});

test('本插件创建的事件键卸载后彻底消失（不留空壳）', () => {
  const file = seed(USER_SETTINGS);
  installer.install(opts(file));
  installer.uninstall(opts(file));
  const s = read(file);
  // SessionStart 等键在原文里不存在，是 install 创建的 —— 必须收回
  for (const event of HOOKED_EVENTS) {
    if (event in USER_SETTINGS.hooks) continue;
    assert.ok(!(event in s.hooks), `本插件创建的事件键 ${event} 卸载后仍残留`);
  }
  // 用户原有的键一个不少
  assert.deepStrictEqual(Object.keys(s.hooks), Object.keys(USER_SETTINGS.hooks));
});

test('用户原有的空 hooks 对象装卸后仍在（容器层同理，不是只有事件键要保）', () => {
  const withEmptyHooks = { model: 'opus', hooks: {} };
  const file = seed(withEmptyHooks);
  installer.install(opts(file));
  installer.uninstall(opts(file));
  assert.deepStrictEqual(read(file), withEmptyHooks, '用户原有的空 hooks 对象被删掉了');
});

test('用户原有的空事件键正是本插件要挂的事件时，卸载后该键仍在且为空数组', () => {
  // 边界：用户把 Stop 留成空数组占位，本插件恰好也要挂 Stop。
  // 键是用户的，本插件只是往里加了条目 —— 卸载后键必须还给用户，不能收回。
  const file = seed({ model: 'opus', hooks: { Stop: [] } });
  installer.install(opts(file));
  installer.uninstall(opts(file));
  assert.deepStrictEqual(read(file), { model: 'opus', hooks: { Stop: [] } });
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

// ---- 3b. 同一分组内共存：用户把自己的命令追加进本插件写出的那个分组 ----
// Claude Code 的 `hooks.<Event>[].hooks` 是数组，一组可挂多条命令，用户手改配置时
// 最顺手的就是往现成的那组里追加。身份判据是「分组内某条 command」，删除粒度就必须
// 也是那一条 command —— 按分组删会把用户那条连带抹掉且无任何提示（不可逆配置丢失）。
// 上一版实现正是按分组删，而原「不误伤」用例只造了**不同分组**的场景，漏掉同组共存。
test('uninstall 只摘本插件那条 command，同一分组内用户追加的命令保留', () => {
  const userCmd = '/Users/u/bin/user-notify.sh';
  const file = seed(USER_SETTINGS);
  installer.install(opts(file));

  // 用户往本插件的 Stop 分组里追加自己的命令
  const s0 = read(file);
  const ourStop = s0.hooks.Stop.find((e) => e['pet-agent-status']);
  ourStop.hooks.push({ type: 'command', command: userCmd });
  fs.writeFileSync(file, `${JSON.stringify(s0, null, 2)}\n`, 'utf8');

  const res = installer.uninstall(opts(file));
  const s = read(file);

  // 用户那条必须还在
  const stopCmds = (s.hooks.Stop || []).flatMap((e) => (e.hooks || []).map((h) => h.command));
  assert.ok(stopCmds.includes(userCmd), '同一分组内用户追加的命令被连带删除了');
  // 本插件那条必须摘干净
  assert.ok(!stopCmds.includes(FAKE_CMD), '本插件条目没摘干净');
  // 分组还剩用户的命令时不该丢弃整组，也不该留下 MARKER（这组已不属于本插件）
  const survivor = s.hooks.Stop.find((e) => (e.hooks || []).some((h) => h.command === userCmd));
  assert.ok(survivor, '保住用户命令的那个分组不见了');
  assert.ok(!(installer.MARKER in survivor), '分组已不属于本插件，不该继续挂着 marker');
  // 摘除计数按 command 粒度算，仍是每事件一条
  assert.strictEqual(res.removed, HOOKED_EVENTS.length);
  // 原先就独立存在的用户分组也不受影响
  assert.deepStrictEqual(s.hooks.SubagentStop, USER_SETTINGS.hooks.SubagentStop);
});

test('重复 install 不重复挂钩，也不吃掉同分组内用户追加的命令', () => {
  const userCmd = '/Users/u/bin/user-notify.sh';
  const file = seed(USER_SETTINGS);
  installer.install(opts(file));

  const s0 = read(file);
  s0.hooks.SessionStart.find((e) => e['pet-agent-status']).hooks
    .push({ type: 'command', command: userCmd });
  fs.writeFileSync(file, `${JSON.stringify(s0, null, 2)}\n`, 'utf8');

  installer.install(opts(file)); // 用户再点一次「一键接入」

  const cmds = read(file).hooks.SessionStart
    .flatMap((e) => (e.hooks || []).map((h) => h.command));
  assert.ok(cmds.includes(userCmd), '再次安装吃掉了同分组内用户的命令');
  assert.strictEqual(
    cmds.filter((c) => c === FAKE_CMD).length, 1,
    '本插件条目重复挂了'
  );
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
  // 两段都带单引号，取第二段并剥引号（引号内的 '\'' 转义在真实路径里不会出现）
  const scriptPath = cmd.slice(cmd.indexOf("' '") + 3, -1);
  assert.ok(fs.existsSync(scriptPath), `hook 脚本不存在: ${scriptPath}`);
  assert.strictEqual(path.basename(scriptPath), 'claude-status-hook.js');
});

// ---- 6. 端到端：装完的 command 真的能跑起来并写状态文件 ----
test('安装写入的 command 原样执行可产出状态文件（闭环自证）', () => {
  const file = seed(USER_SETTINGS);
  installer.install({ settingsFile: file });
  const entry = read(file).hooks.SessionStart.find((e) => e['pet-agent-status']);
  const cmd = entry.hooks[0].command;

  const stateDir = tmp();
  const payload = fs.readFileSync(path.join(ROOT, 'fixtures', 'claude-code-events', 'session-start.json'), 'utf8');
  // 像 Claude Code 那样整条丢给 shell，而不是自己按空格拆 —— 拆法会掩盖引号缺陷
  const res = spawnSync('/bin/sh', ['-c', cmd], {
    input: payload,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PET_AGENT_STATUS_DIR: stateDir })
  });
  assert.strictEqual(res.status, 0);
  const files = fs.readdirSync(stateDir).filter((n) => n.endsWith('.json'));
  assert.deepStrictEqual(files, [EXPECTED_STATE_FILE]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stateDir, files[0]), 'utf8')).state, 'running');
});

// ---- 6b. 引号安全：含空格的插件目录下，command 经 shell 执行必须 rc=0 ----
// 宿主插件落地在 `~/Library/Application Support/吐梨邦/plugins/` 之下（含空格），
// 裸拼路径会被 shell 切成两个参数 → MODULE_NOT_FOUND 堆栈吐到 stderr，打扰会话。
test('插件目录含空格时，安装写入的 command 经 shell 执行仍 rc=0 并写出状态文件', () => {
  // 把仓库真实拷进一个含空格（且含中文）的目录，再从那份副本取 installer
  const base = path.join(tmp(), 'Application Support', '吐梨邦 plugins', 'pet-agent-status');
  fs.mkdirSync(base, { recursive: true });
  for (const sub of ['lib', 'hooks', 'fixtures']) {
    fs.cpSync(path.join(ROOT, sub), path.join(base, sub), { recursive: true });
  }
  const copied = require(path.join(base, 'lib', 'claude-hooks-installer.js'));

  const file = seed(USER_SETTINGS);
  copied.install({ settingsFile: file });
  const entry = read(file).hooks.SessionStart.find((e) => e['pet-agent-status']);
  const cmd = entry.hooks[0].command;
  assert.ok(cmd.includes('吐梨邦 plugins'), '夹具没走到含空格路径，本用例白测');

  const stateDir = tmp();
  const payload = fs.readFileSync(path.join(ROOT, 'fixtures', 'claude-code-events', 'session-start.json'), 'utf8');
  // 关键：像 Claude Code 那样把整条 command 交给 shell，而不是自己拆参数
  const res = spawnSync('/bin/sh', ['-c', cmd], {
    input: payload,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PET_AGENT_STATUS_DIR: stateDir })
  });
  assert.strictEqual(res.status, 0, `含空格路径下 hook 退出码非 0：${res.stderr}`);
  assert.strictEqual(res.stderr, '', `hook 不该向 stderr 吐东西：${res.stderr}`);
  assert.deepStrictEqual(fs.readdirSync(stateDir).filter((n) => n.endsWith('.json')), [EXPECTED_STATE_FILE]);
});

test('hookCommand 生成的两段路径都被引号包裹', () => {
  const cmd = installer.hookCommand();
  assert.ok(/^'.*' '.*'$/s.test(cmd), `command 未加引号: ${cmd}`);
});

// ---- 7. 隔离自证 ----
test('测试期间未修改真实 ~/.claude/settings.json', () => {
  const real = path.join(os.homedir(), '.claude', 'settings.json');
  assert.ok(!fs.existsSync(real + '.bak-pet-agent-status'), '真实配置被动过（出现了备份文件）');
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nclaude-installer-test: ${passed} passed`);
