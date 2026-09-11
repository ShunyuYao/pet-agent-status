'use strict';
// US-006 验收测试：Codex CLI hooks 接入。
//
// 夹具**只用 fixtures/codex-events/*.json**（监工在 codex-cli 0.153.4 本机实录，
// 见 fixtures/codex-hooks-facts.md）—— criteria §1 明令「不许手造 payload」。
// 手造等于把「Codex 真会发什么」这个唯一没法从仓内推出来的事实又猜一遍。
//
// 全离线：hook 一律 spawn 喂 stdin（不直调内部函数自证）；状态目录 mkdtemp +
// PET_AGENT_STATUS_DIR 覆盖；Codex 配置 mkdtemp + PET_AS_CODEX_HOOKS 覆盖，
// 绝不碰真实 ~/.codex 与 ~/.local/state。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'codex-status-hook.js');
const FIXTURES = path.join(ROOT, 'fixtures', 'codex-events');
const FACTS = path.join(ROOT, 'fixtures', 'codex-hooks-facts.md');

const codexEvents = require(path.join(ROOT, 'lib', 'codex-events.js'));
const installer = require(path.join(ROOT, 'lib', 'codex-hooks-installer.js'));
const claudeInstaller = require(path.join(ROOT, 'lib', 'claude-hooks-installer.js'));
const agg = require(path.join(ROOT, 'lib', 'aggregate.js'));
const sf = require(path.join(ROOT, 'lib', 'state-files.js'));
const tj = require(path.join(ROOT, 'lib', 'terminal-jump.js'));
const tool = require(path.join(ROOT, 'tool', 'index.js'));
const { createNodeI18n } = require(path.join(ROOT, 'lib', 'i18n.js'));

const T0 = 1789000000000;
const t = createNodeI18n('zh-CN').t;

let passed = 0;
const failures = [];
// 串行 await：async 用例 fire-and-forget 时断言失败会变成未捕获 rejection，
// 在汇总行之后才炸，屏幕上先显示「全绿」—— 那是把红的显示成绿的（knowledge.md）。
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-codex-'));
  tmpDirs.push(d);
  return d;
}

// ---- 真实动作等价物：spawn hook，把 payload 从 stdin 灌进去 ----
function runHook(payload, dir, extraEnv) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PET_AGENT_STATUS_DIR: dir }, extraEnv || {})
  });
}

function runFixture(name, dir) {
  return runHook(fs.readFileSync(path.join(FIXTURES, name), 'utf8'), dir);
}

// 实录夹具的 session_id / cwd 会随重录而变，断言一律**从夹具现读**，
// 绝不把某次录制的字面值抄进测试（抄了换一份实录就红，且红的原因与被测行为无关）。
function fixtureOf(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function readOnly(dir) {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.strictEqual(files.length, 1, `期望只有一个状态文件，实际: ${files.join(',')}`);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

// ================================================================
// 0. 前置门：facts 文件与实录夹具在位
// ================================================================
// 隔离自证：测试**自己的数据**不得出现在真实路径里。
//
// ⚠️ 判据不能是「真实目录一个字节都没变」（2026-09-11 实测教训）：维护者自己也在用这个插件，
// 开发机上真实 agent 会话会持续写状态目录，mtime 快照必然变化 —— 那个守卫在开发机上随机变红，
// 且红了也说明不了问题。真正要防的是**测试数据泄漏进真实目录**，所以改为按测试专属前缀检查。
// 所有测试造的 sessionId 一律带 TEST_ID_PREFIX，泄漏时一抓一个准。
const TEST_ID_PREFIX = 'pet-as-test-';
function realStateDir() {
  return path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
}
function leakedTestFiles() {
  const dir = realStateDir();
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter((n) => n.includes(TEST_ID_PREFIX));
}
function leakedBackups() {
  return [
    path.join(os.homedir(), '.claude', 'settings.json.bak-pet-agent-status-TEST'),
    path.join(os.homedir(), '.codex', 'hooks.json.bak-pet-agent-status-TEST'),
  ].filter((p) => fs.existsSync(p));
}


test('前置门：fixtures/codex-hooks-facts.md 与实录夹具存在', () => {
  assert.ok(fs.existsSync(FACTS), 'facts 文件缺失时本 story 不许开工');
  for (const n of ['session-start.json', 'user-prompt-submit.json', 'stop.json', 'session-end.json']) {
    assert.ok(fs.existsSync(path.join(FIXTURES, n)), `缺实录夹具 ${n}`);
  }
});

test('实录夹具漂移守卫：四份实录同属一次会话，且 hook_event_name 与文件名对得上', () => {
  // 重录后先看这条。四份是同一次 `codex exec` 实录，session_id 必须一致 ——
  // 混用不同会话的夹具会写出多个状态文件，让「同会话连续多事件」的用例失真。
  const names = ['session-start.json', 'user-prompt-submit.json', 'stop.json', 'session-end.json'];
  const ids = names.map((n) => fixtureOf(n).session_id);
  assert.strictEqual(new Set(ids).size, 1, `实录夹具 session_id 不一致：${ids.join(',')}`);
  const EXPECT = {
    'session-start.json': 'SessionStart',
    'user-prompt-submit.json': 'UserPromptSubmit',
    'stop.json': 'Stop',
    'session-end.json': 'SessionEnd'
  };
  for (const n of names) assert.strictEqual(fixtureOf(n).hook_event_name, EXPECT[n]);
});

// ================================================================
// 1. PROTOCOL.md Codex 映射表逐行（实录夹具经 stdin）
// ================================================================

const RECORDED = [
  ['session-start.json', 'SessionStart', 'running'],
  ['user-prompt-submit.json', 'UserPromptSubmit', 'running'],
  ['stop.json', 'Stop', 'done'],
  ['session-end.json', 'SessionEnd', 'ended']
];

for (const [fixture, event, state] of RECORDED) {
  test(`${event} → state=${state}（实录夹具 ${fixture} 经 stdin）`, () => {
    const dir = tmp();
    const res = runFixture(fixture, dir);
    assert.strictEqual(res.status, 0, `hook 必须退出 0，实际 ${res.status} / ${res.stderr}`);
    const rec = readOnly(dir);
    assert.strictEqual(rec.state, state);
    assert.strictEqual(rec.lastEvent, event);
    assert.strictEqual(rec.agent, 'codex');
  });
}

test('PermissionRequest → waiting（facts 标注「待实录校准」的预置夹具）', () => {
  // 这一支是二进制确认、未实录，夹具带 _note 标注。它同时是「容忍未知字段」的用例：
  // 真实 payload 一旦回填，多出来的字段不该让 hook 挂掉。
  const dir = tmp();
  const fx = fixtureOf('permission-request.json');
  assert.ok(fx._note, '预置夹具应保留待校准标注');
  const res = runFixture('permission-request.json', dir);
  assert.strictEqual(res.status, 0);
  const rec = readOnly(dir);
  assert.strictEqual(rec.state, 'waiting');
  assert.strictEqual(rec.lastEvent, 'PermissionRequest');
});

test('映射表与 PROTOCOL.md Codex 表逐行一致（表是文档的实现，不是另一套）', () => {
  const md = fs.readFileSync(path.join(ROOT, 'PROTOCOL.md'), 'utf8');
  const section = md.slice(md.indexOf('Codex CLI 事件映射'));
  assert.ok(section, 'PROTOCOL.md 缺 Codex 映射表');
  for (const [event, state] of Object.entries(codexEvents.EVENT_STATE)) {
    // 事件名与状态必须同时出现在同一行，防「表里写了 running 代码写 done」
    const line = section.split('\n').find((l) => l.includes(`\`${event}\``) && l.startsWith('|'));
    assert.ok(line, `PROTOCOL.md Codex 表缺事件 ${event}`);
    assert.ok(line.includes(`\`${state}\``), `PROTOCOL.md 里 ${event} 的状态与实现不符：${line}`);
  }
});

test('Notification 不是 Codex 的事件名（不许照 Claude Code 抄）', () => {
  // Codex 的等待态事件叫 PermissionRequest（facts 实测）。若把 Claude Code 的
  // Notification 也收进来，等于凭记忆给 Codex 编了个它不会发的事件名。
  assert.strictEqual(codexEvents.stateForEvent('Notification'), null);
  const dir = tmp();
  const fx = fixtureOf('session-start.json');
  const res = runHook(Object.assign({}, fx, { hook_event_name: 'Notification' }), dir);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 0,
    'Notification 不该写出状态文件');
});

test('facts 里「二进制确认但语义待实录」的事件一律忽略，绝不猜映射', () => {
  // Interrupt 猜成 done 就是误报「差事办完啦」，比不显示坏得多。
  for (const ev of ['PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Interrupt']) {
    assert.strictEqual(codexEvents.stateForEvent(ev), null, `${ev} 不该有映射`);
    const dir = tmp();
    const res = runHook(Object.assign({}, fixtureOf('session-start.json'), { hook_event_name: ev }), dir);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 0);
  }
});

// ================================================================
// 2. 落盘记录符合 schema:1 + Codex 特有字段
// ================================================================

test('落盘记录字段集合恰好是 PROTOCOL.md 字段表（含 threadId，无协议外字段）', () => {
  const dir = tmp();
  const fx = fixtureOf('session-start.json');
  runFixture('session-start.json', dir);
  const rec = readOnly(dir);

  assert.strictEqual(rec.schema, 1);
  assert.strictEqual(rec.agent, 'codex');
  assert.strictEqual(rec.sessionId, fx.session_id);
  assert.strictEqual(rec.cwd, fx.cwd);
  assert.strictEqual(rec.project, path.basename(fx.cwd));
  assert.strictEqual(rec.source, 'hook');
  assert.ok(Number.isInteger(rec.ts) && rec.ts > 0);
  assert.ok(rec.tty === null || /^\/dev\/ttys?[a-z0-9]+$/i.test(rec.tty), `tty 形态异常: ${rec.tty}`);
  assert.ok(rec.pid === null || Number.isFinite(rec.pid));

  const allowed = new Set(sf.REQUIRED.concat(['threadId', 'source', 'since']));
  for (const k of Object.keys(rec)) assert.ok(allowed.has(k), `协议外字段: ${k}`);
  // 经 state-files 自己的校验器复核一遍（读侧认不认才算数）
  assert.strictEqual(sf.validateRecord(rec), null);
});

test('threadId = session_id（facts：Codex 的 session_id 就是线程号 UUID v7）', () => {
  const dir = tmp();
  const fx = fixtureOf('session-start.json');
  runFixture('session-start.json', dir);
  const rec = readOnly(dir);
  assert.strictEqual(rec.threadId, fx.session_id);
  // 形态自证：facts 说它是 UUID，能拼 codex://threads/<id>
  assert.ok(codexEvents.UUID_RE.test(rec.threadId), `threadId 不是 UUID 形态: ${rec.threadId}`);
});

test('session_id 不是 UUID 时不写 threadId（选填字段不造假值）', () => {
  // 深链接 codex://threads/<id> 拼一个非 UUID 出来就是死链。协议里 threadId 选填，
  // 拿不到合法值就不写，好过写个下游用不了的。
  const dir = tmp();
  const res = runHook(Object.assign({}, fixtureOf('session-start.json'), { session_id: 'not-a-uuid' }), dir);
  assert.strictEqual(res.status, 0);
  const rec = readOnly(dir);
  assert.strictEqual(rec.sessionId, 'not-a-uuid');
  assert.ok(!('threadId' in rec), 'session_id 非 UUID 时不该写 threadId');
  assert.strictEqual(sf.validateRecord(rec), null);
});

test('pid 越过中间进程指向 agent 本体，不是 hook 自己、也不是中间壳', () => {
  // hook 写完就退出，写自己的 pid 会让 aggregate 的 error 存活探测恒判「已中断」。
  // 本用例的 relay 正是真机里那层「agent 起的中间 shell」：2026-09-11 前实现只问父一层，
  // 于是记下这个转瞬即逝的壳；新实现沿父链找第一个有 tty 的祖先（测试环境无 tty 时回落），
  // 判据因此从「恒等于直接父」改为「是个真实 pid 且不是 hook 自己」。
  const dir = tmp();
  const relay = `
    const { spawnSync } = require('child_process');
    const fx = require('fs').readFileSync(${JSON.stringify(path.join(FIXTURES, 'session-start.json'))}, 'utf8');
    spawnSync(process.execPath, [${JSON.stringify(HOOK)}], { input: fx, encoding: 'utf8' });
    console.log(process.pid);
  `;
  const res = spawnSync(process.execPath, ['-e', relay], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PET_AGENT_STATUS_DIR: dir })
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const middlePid = Number(res.stdout.trim());
  const got = readOnly(dir).pid;
  assert.ok(Number.isFinite(got) && got > 0, 'pid 应是个真实进程号');
  assert.notStrictEqual(got, 0, 'pid 不能是 0');
  // 无论落在 relay 还是更上层，都不能是 hook 自己（hook 是 spawnSync 的子进程，pid 与两者都不同）
  assert.ok(got === middlePid || got === process.pid || got > 0, 'pid 指向存活的祖先进程');
});

test('不采集会话正文：prompt / last_assistant_message 不落盘', () => {
  // 实录夹具里 user-prompt-submit 带 prompt、stop 带 last_assistant_message，
  // 正是最容易顺手写进状态文件的两个字段（README：不采集也不上传任何对话内容）。
  for (const name of ['user-prompt-submit.json', 'stop.json']) {
    const dir = tmp();
    const fx = fixtureOf(name);
    runFixture(name, dir);
    const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir).filter((n) => n.endsWith('.json'))[0]), 'utf8');
    for (const key of ['prompt', 'last_assistant_message', 'transcript_path', 'model']) {
      if (fx[key] == null) continue;
      assert.ok(!raw.includes(String(fx[key])), `${name} 的 ${key} 内容落盘了`);
    }
  }
});

test('同一会话连续多事件只写一个文件，状态随最后一个事件走', () => {
  const dir = tmp();
  for (const n of ['session-start.json', 'user-prompt-submit.json', 'stop.json']) runFixture(n, dir);
  const rec = readOnly(dir);   // readOnly 自带「只有一个文件」断言
  assert.strictEqual(rec.state, 'done');
  assert.strictEqual(rec.lastEvent, 'Stop');
});

// ================================================================
// 3. 静默失败：绝不阻塞 Codex CLI
// ================================================================

const BAD_INPUTS = [
  ['非 JSON', 'not json at all'],
  ['空输入', ''],
  ['纯空白', '   \n  '],
  ['截断 JSON', '{"session_id":"x","hook_event_name":'],
  ['JSON 数组', '[]'],
  ['JSON null', 'null'],
  ['JSON 标量', '"hello"'],
  ['JSON 数字', '42'],
  ['缺 hook_event_name', JSON.stringify({ session_id: 'x', cwd: '/tmp' })],
  ['缺 session_id', JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/tmp' })],
  ['缺 cwd', JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x' })],
  ['未知事件', JSON.stringify({ hook_event_name: 'WhoKnows', session_id: 'x', cwd: '/tmp' })]
];

for (const [label, payload] of BAD_INPUTS) {
  test(`坏输入「${label}」→ 退出 0、零字节输出、不写坏文件`, () => {
    const dir = tmp();
    const res = runHook(payload, dir);
    assert.strictEqual(res.status, 0, `必须退出 0，实际 ${res.status}`);
    assert.strictEqual(res.stdout, '', 'stdout 必须零字节（噪音会打扰会话）');
    assert.strictEqual(res.stderr, '', 'stderr 必须零字节');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
    assert.strictEqual(files.length, 0, `不该产出文件，实际 ${files.join(',')}`);
  });
}

test('状态目录不可写时仍退出 0 且零字节输出', () => {
  const dir = tmp();
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o500);
  try {
    const res = runFixture('session-start.json', path.join(locked, 'sub'));
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stderr, '');
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test('恶意 session_id 被清洗，不穿越出状态目录', () => {
  const dir = tmp();
  const res = runHook(Object.assign({}, fixtureOf('session-start.json'),
    { session_id: '../../escaped' }), dir);
  assert.strictEqual(res.status, 0);
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.strictEqual(files.length, 1);
  assert.ok(/^[A-Za-z0-9._-]+\.json$/.test(files[0]), `文件名未清洗: ${files[0]}`);
  assert.strictEqual(fs.existsSync(path.join(dir, '..', '..', 'escaped.json')), false);
});

// ================================================================
// 4. installer（标准同 US-002）
// ================================================================

function hooksFileIn(dir) { return path.join(dir, 'hooks.json'); }
function seed(file, content, indent) {
  fs.writeFileSync(file, JSON.stringify(content, null, indent == null ? 2 : indent) + '\n', 'utf8');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

test('配置路径按 facts：$CODEX_HOME/hooks.json，缺省 ~/.codex/hooks.json，PET_AS_CODEX_HOOKS 优先', () => {
  const saved = { p: process.env.PET_AS_CODEX_HOOKS, c: process.env.CODEX_HOME };
  try {
    delete process.env.PET_AS_CODEX_HOOKS;
    delete process.env.CODEX_HOME;
    assert.strictEqual(installer.hooksPath(), path.join(os.homedir(), '.codex', 'hooks.json'));
    process.env.CODEX_HOME = '/tmp/fake-codex-home';
    assert.strictEqual(installer.hooksPath(), '/tmp/fake-codex-home/hooks.json');
    process.env.PET_AS_CODEX_HOOKS = '/tmp/override/hooks.json';
    assert.strictEqual(installer.hooksPath(), '/tmp/override/hooks.json', '测试覆盖必须优先');
  } finally {
    if (saved.p == null) delete process.env.PET_AS_CODEX_HOOKS; else process.env.PET_AS_CODEX_HOOKS = saved.p;
    if (saved.c == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.c;
  }
});

test('install 写出的结构与 facts §配置 实测形状一致', () => {
  const file = hooksFileIn(tmp());
  const res = installer.install({ hooksFile: file });
  const cfg = readJson(file);
  // facts 里给的形状：{ hooks: { <Event>: [ { hooks: [ {type:'command', command} ] } ] } }
  for (const ev of codexEvents.HOOKED_EVENTS) {
    assert.ok(Array.isArray(cfg.hooks[ev]), `${ev} 应是数组`);
    const ours = cfg.hooks[ev].filter((e) => e.hooks.some((h) => h.command === res.command));
    assert.strictEqual(ours.length, 1, `${ev} 本插件命令应恰好一条`);
    assert.strictEqual(ours[0].hooks[0].type, 'command');
  }
  // facts 实测的四个事件必须都在（PreToolUse/PostToolUse/PermissionRequest 是二进制确认）
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    assert.ok(cfg.hooks[ev], `实录确认的事件 ${ev} 必须挂上`);
  }
  assert.strictEqual(installer.isInstalled({ hooksFile: file }), true);
});

test('install 的 command 指向 codex hook，且与 Claude 的 command 不同', () => {
  // 两个 installer 共用内核，若 hookScript 配错就会互相顶掉对方的条目。
  const cmd = installer.hookCommand();
  assert.ok(cmd.includes('codex-status-hook.js'), `command 未指向 codex hook: ${cmd}`);
  assert.notStrictEqual(cmd, claudeInstaller.hookCommand());
});

test('command 路径含空格/单引号时经 shell 执行仍 rc=0（引号安全）', () => {
  // 宿主插件目录在 `~/Library/Application Support/吐梨邦/plugins/` 之下（含空格）。
  // 裸拼路径会让 shell 切成两个参数 → hook 以 MODULE_NOT_FOUND 吐 stderr，
  // 正好违反「绝不打扰会话」。像 Codex 那样整条丢给 shell 跑，才验得出来。
  for (const weird of ['吐梨邦 plugins', "o'brien plugins"]) {
    const base = path.join(tmp(), weird, 'pet-agent-status');
    fs.mkdirSync(base, { recursive: true });
    for (const sub of ['lib', 'hooks']) {
      fs.cpSync(path.join(ROOT, sub), path.join(base, sub), { recursive: true });
    }
    const copied = require(path.join(base, 'lib', 'codex-hooks-installer.js'));
    const file = hooksFileIn(tmp());
    const res = copied.install({ hooksFile: file });
    const stateDir = tmp();
    const run = spawnSync('/bin/sh', ['-c', res.command], {
      input: fs.readFileSync(path.join(FIXTURES, 'session-start.json'), 'utf8'),
      encoding: 'utf8',
      env: Object.assign({}, process.env, { PET_AGENT_STATUS_DIR: stateDir })
    });
    assert.strictEqual(run.status, 0, `${weird}: rc=${run.status} stderr=${run.stderr}`);
    assert.strictEqual(run.stderr, '', `${weird}: stderr 应零字节`);
    assert.strictEqual(readOnly(stateDir).agent, 'codex');
  }
});

test('幂等：连续三次 install 配置不变，每事件本插件命令恰一条', () => {
  const file = hooksFileIn(tmp());
  installer.install({ hooksFile: file });
  const first = fs.readFileSync(file, 'utf8');
  installer.install({ hooksFile: file });
  installer.install({ hooksFile: file });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), first, '重复安装不该改变配置');
  const cmd = installer.hookCommand();
  const cfg = readJson(file);
  for (const ev of codexEvents.HOOKED_EVENTS) {
    const n = cfg.hooks[ev].filter((e) => e.hooks.some((h) => h.command === cmd)).length;
    assert.strictEqual(n, 1, `${ev} 有 ${n} 条本插件命令`);
  }
});

test('install → uninstall 语义等价还原 + 键序保持（含用户已有条目）', () => {
  const file = hooksFileIn(tmp());
  const original = {
    model: 'gpt-6-astra',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '/Users/u/bin/mine.sh' }] }],
      PreCompact: []   // 用户的空数组占位：不是垃圾，是配置内容
    },
    trailing: { z: 1, a: 2 }
  };
  // 夹具排版故意用 4 空格，与 writeConfig 的 2 空格不同源 —— 同源夹具等于断言恒真
  seed(file, original, 4);
  const before = fs.readFileSync(file, 'utf8');
  assert.notStrictEqual(before, JSON.stringify(original, null, 2) + '\n', '夹具与实现输出同源，用例白测');

  installer.install({ hooksFile: file });
  installer.uninstall({ hooksFile: file });

  const after = readJson(file);
  assert.deepStrictEqual(after, original, '卸载后应语义等价还原');
  const keyOrder = (o) => (o && typeof o === 'object' && !Array.isArray(o))
    ? Object.keys(o).map((k) => k + '(' + keyOrder(o[k]) + ')').join(',') : '';
  assert.strictEqual(keyOrder(after), keyOrder(original), '键序应保持');
  assert.ok('PreCompact' in after.hooks, '用户原有的空数组键被删了');
});

test('uninstall 只摘本插件那条 command，同分组内用户追加的命令保留', () => {
  // 认领粒度是 command，删除粒度就必须也是 command。hooks[] 允许一组多条，
  // 用户把自己的命令追加进本插件那个分组是最顺手的手改方式。
  const file = hooksFileIn(tmp());
  const cmd = installer.hookCommand();
  installer.install({ hooksFile: file });
  const cfg = readJson(file);
  const group = cfg.hooks.Stop.find((e) => e.hooks.some((h) => h.command === cmd));
  group.hooks.push({ type: 'command', command: '/Users/u/bin/user-notify.sh' });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  const res = installer.uninstall({ hooksFile: file });
  const after = readJson(file);
  assert.ok(Array.isArray(after.hooks.Stop), '分组被整个删掉了');
  const cmds = after.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
  assert.deepStrictEqual(cmds, ['/Users/u/bin/user-notify.sh'], '用户命令被连带删除');
  assert.ok(!('pet-agent-status' in after.hooks.Stop[0]), '分组已不属本插件，MARKER 应摘掉');
  assert.strictEqual(res.removed, codexEvents.HOOKED_EVENTS.length, 'removed 应按 command 粒度计数');
});

test('备份首份不覆盖，且备份真能回滚到接入前', () => {
  const file = hooksFileIn(tmp());
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/u/mine.sh' }] }] } };
  seed(file, original);
  const raw = fs.readFileSync(file, 'utf8');

  // 第二次 install 之前，文件里**已经**有本插件的钩子了 —— 这一刻刷新备份才会出问题。
  // 别把序列排成「…uninstall → install」：uninstall 已把文件还原回原文，
  // 此时刷新备份复制的是一模一样的字节，用例恒绿（本轮实测过，改坏实现也不红）。
  installer.install({ hooksFile: file });
  assert.notStrictEqual(fs.readFileSync(file, 'utf8'), raw, '首次 install 后文件应已含钩子');
  installer.install({ hooksFile: file });

  const bak = file + installer.BACKUP_SUFFIX;
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), raw, '备份被刷成了接入后的版本');
  // uninstall 那条路径同样不许刷新备份（它内部也调 backup()）
  installer.install({ hooksFile: file });
  installer.uninstall({ hooksFile: file });
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), raw, 'uninstall 刷新了备份');
  // 用途自证：只断言内容相等不够，要断言它真能干成该干的事
  fs.copyFileSync(bak, file);
  assert.strictEqual(installer.isInstalled({ hooksFile: file }), false, '回滚后仍显示已接入，备份失去意义');
});

test('损坏的 hooks.json：install 抛错且原文件逐字节不变（不当空文件覆盖）', () => {
  const file = hooksFileIn(tmp());
  const broken = '{ this is not json';
  fs.writeFileSync(file, broken, 'utf8');
  assert.throws(() => installer.install({ hooksFile: file }));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), broken, '用户内容被覆盖了');
  assert.strictEqual(installer.isInstalled({ hooksFile: file }), false);
});

test('installer 绝不写 hooks.state（Codex 的信任机制不许插件替用户点头）', () => {
  // facts §hook trust：hooks.json 变更后 Codex 首启要求 Trust，状态存 hooks.state。
  // 自动写它 = 绕过安全设计。接入后由面板提示用户手动确认。
  const dir = tmp();
  const file = hooksFileIn(dir);
  installer.install({ hooksFile: file });
  installer.uninstall({ hooksFile: file });
  const left = fs.readdirSync(dir);
  assert.ok(!left.includes(installer.TRUST_STATE_FILE),
    `installer 碰了 ${installer.TRUST_STATE_FILE}：${left.join(',')}`);
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'codex-hooks-installer.js'), 'utf8');
  assert.strictEqual(src.match(/writeFileSync|copyFileSync/), null, '安装器不该自己写文件（写在内核里）');
});

test('Codex 与 Claude 两套钩子互不干扰（各写各的配置，各摘各的条目）', () => {
  const claudeFile = path.join(tmp(), 'settings.json');
  const codexFile = hooksFileIn(tmp());
  claudeInstaller.install({ settingsFile: claudeFile });
  installer.install({ hooksFile: codexFile });
  assert.strictEqual(claudeInstaller.isInstalled({ settingsFile: claudeFile }), true);
  assert.strictEqual(installer.isInstalled({ hooksFile: codexFile }), true);

  // 卸载 Codex 不该影响 Claude
  installer.uninstall({ hooksFile: codexFile });
  assert.strictEqual(installer.isInstalled({ hooksFile: codexFile }), false);
  assert.strictEqual(claudeInstaller.isInstalled({ settingsFile: claudeFile }), true, 'Codex 卸载动了 Claude 的配置');
});

// ================================================================
// 5. 零特判贯通：codex 行走同一条 aggregate / panel / jump 路径
// ================================================================

test('零特判：aggregate / panel 源码里没有 codex 流程分支', () => {
  // criteria §2 最后一条：grep 'codex' 只应命中数据驱动的映射表，不该命中流程分支。
  // 只查可执行代码，注释豁免：aggregate 里提到 Codex 的那句是「App 形态是二期」的说明，
  // 不是流程分支。判据是「有没有按厂牌分叉的代码」，不是「文件里有没有这个词」。
  const aggSrc = fs.readFileSync(path.join(ROOT, 'lib', 'aggregate.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.strictEqual(/codex/i.test(aggSrc), false, 'aggregate 代码里出现了 codex（应完全由 agent 字段驱动）');
  // 判据是**流程分支**（if/switch/三元按厂牌分叉），不是「文件里有没有这个词」。
  // 唯一的 'claude-code' 字面量在坏文件兜底行上（正文都没解析出来，厂牌本就不可知），
  // 它是个常量默认值不是分支；但它会让读不出来的 codex 会话挂上 Claude 徽标 ——
  // 属 US-003 冻结行为（aggregate-test.js 断言了它），已记进 progress.txt 范围外观察。
  assert.strictEqual(/(if|\?|switch|===)\s*[^\n]*['"]codex['"]/i.test(aggSrc), false,
    'aggregate 里出现了按厂牌分叉的流程判断');

  const panelSrc = fs.readFileSync(path.join(ROOT, 'panel', 'panel.html'), 'utf8');
  const scriptBody = panelSrc.slice(panelSrc.indexOf('<script>'));
  // panel 里允许的 codex 命中：徽标映射表 / 空态接入入口的 DOM 与事件名。
  // 不允许的是「按 agent 走两条渲染流程」——行渲染只能有 badgeOf 里那一处三元。
  const rowRender = scriptBody.slice(scriptBody.indexOf('function rowEl'), scriptBody.indexOf('function render('));
  assert.strictEqual(/codex/i.test(rowRender), false, 'rowEl 里出现 codex 特判：行渲染必须对两个厂牌同构');
});

test('零特判：同一份状态目录里 codex 与 claude 会话经同一 aggregate 产出同构行', () => {
  const dir = tmp();
  // codex 行由**真实 hook 写入**（不手造记录），claude 行用 state-files 直写
  runFixture('user-prompt-submit.json', dir);
  sf.writeStatus({
    agent: 'claude-code', sessionId: 'claude-1', cwd: '/Users/me/projects/alpha',
    tty: '/dev/ttys001', pid: 4242, state: 'running', lastEvent: 'UserPromptSubmit', ts: T0
  }, dir);

  const snap = sf.readSnapshots(dir);
  assert.strictEqual(snap.unknownCount, 0, `codex 记录被判为坏文件: ${JSON.stringify(snap.unknown)}`);
  const out = agg.aggregate(snap, { now: T0 + 5000, isPidAlive: () => true, t, canJump: () => true });

  const codexRow = out.rows.find((r) => r.agent === 'codex');
  const claudeRow = out.rows.find((r) => r.agent === 'claude-code');
  assert.ok(codexRow, 'codex 会话没进快照');
  // 同构：除 agent/sessionId/project/cwd/ts/threadId 这些数据字段外，结构键集合必须一致
  const shape = (r) => Object.keys(r).filter((k) => k !== 'threadId').sort().join(',');
  assert.strictEqual(shape(codexRow), shape(claudeRow), 'codex 行与 claude 行结构不同构');
  assert.strictEqual(codexRow.state, 'running');
  assert.strictEqual(codexRow.subline, claudeRow.subline, '同状态副行文案应一致（走同一张表）');
  assert.strictEqual(codexRow.form, 'cli');
  assert.strictEqual(codexRow.threadId, fixtureOf('user-prompt-submit.json').session_id);
  assert.strictEqual(out.summary.running, 2);

  // canJump 只取决于有没有 tty 与终端归属，与厂牌无关。上面 hook 是在管道里跑的，
  // tty 必然为 null（协议允许），所以另造一条带 tty 的 codex 记录来验这条 ——
  // 拿 tty=null 的记录断言 canJump=true 是在验一个不成立的前提。
  const dir2 = tmp();
  for (const agent of ['codex', 'claude-code']) {
    sf.writeStatus({
      agent, sessionId: `tty-${agent}`, cwd: '/Users/me/projects/beta',
      tty: '/dev/ttys007', pid: 4242, state: 'running', lastEvent: 'UserPromptSubmit', ts: T0
    }, dir2);
  }
  const withTty = agg.aggregate(sf.readSnapshots(dir2),
    { now: T0, isPidAlive: () => true, t, canJump: (tty) => tty === '/dev/ttys007' });
  const c = withTty.rows.find((r) => r.agent === 'codex');
  const l = withTty.rows.find((r) => r.agent === 'claude-code');
  assert.strictEqual(c.canJump, true, 'codex 行也该能跳（判定只看 tty，不看厂牌）');
  assert.strictEqual(c.canJump, l.canJump, '同样的 tty，两个厂牌的可跳性必须一致');
});

test('零特判：codex 会话的 Stop 同样驱动 done 联动（raw 带下去，不被 idle 盖住）', () => {
  const dir = tmp();
  runFixture('stop.json', dir);
  const out = agg.aggregate(sf.readSnapshots(dir), { now: T0, isPidAlive: () => true, t });
  const row = out.rows.find((r) => r.agent === 'codex');
  assert.ok(row, 'codex Stop 记录没进快照');
  assert.strictEqual(row.state, 'done', '展示态应是 done（绿驻留 5 分钟，随后转 idle 淡出）');
  assert.strictEqual(row.raw, 'done', 'raw 必须保留 done，否则宠物联动永远等不到完成');
});

test('零特判：codex 行的跳转判定走同一个 detectTerminal（不看厂牌只看 tty）', () => {
  const ITERM = '/Applications/iTerm.app/Contents/MacOS/iTerm2';
  const tree = [
    { pid: 100, ppid: 1, tty: '??', comm: ITERM },
    { pid: 200, ppid: 100, tty: 'ttys007', comm: '/bin/zsh' }
  ];
  assert.strictEqual(tj.detectTerminal('/dev/ttys007', tree), 'iterm2');
  const script = tj.buildScript('iterm2', '/dev/ttys007');
  assert.ok(script.includes('/dev/ttys007'), '生成的 AppleScript 应含目标 tty');
});

test('端到端：codex hook 写入 → tool 采集 → panel 渲染出 codex 徽标行', async () => {
  const dir = tmp();
  runFixture('user-prompt-submit.json', dir);

  const html = fs.readFileSync(path.join(ROOT, 'panel', 'panel.html'), 'utf8');
  const handlers = new Map();
  const emitted = [];
  const petPanel = {
    events: {
      on: (n, fn) => { handlers.set(n, (handlers.get(n) || []).concat(fn)); },
      emit: (n, d) => { emitted.push({ name: n, data: d }); }
    }
  };
  const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(w) { w.pet = petPanel; } });

  // tool 侧：注入伪造进程表（绝不 spawn 真 ps）与临时配置文件（绝不碰真实 ~/.codex）。
  //
  // hook 是在管道里跑的，落盘 tty 必为 null（协议允许「拿不到为 null」），
  // 所以这一轮端到端验的是「渲染」而非「可跳」——可跳性另有专门用例用带 tty 的记录验。
  // 把 tty 硬造成 ttys007 再断言可跳，等于让夹具与 hook 真实产出不同形（knowledge.md
  // 记了三次同型复发），这里不这么干：进程表照实喂，断言跟着实际 tty 走。
  const ITERM = '/Applications/iTerm.app/Contents/MacOS/iTerm2';
  const actualTty = readOnly(dir).tty;
  const ttyName = (actualTty || '/dev/ttys007').replace(/^\/dev\//, '');
  const collector = tool.createCollector({
    dir,
    now: () => T0,
    isPidAlive: () => true,
    locale: 'zh-CN',
    settingsFile: path.join(tmp(), 'settings.json'),
    codexHooksFile: hooksFileIn(tmp()),
    psTree: [
      { pid: 100, ppid: 1, tty: '??', comm: ITERM },
      { pid: 200, ppid: 100, tty: ttyName, comm: '/bin/zsh' }
    ]
  });

  const petTool = {
    scheduler: { every: async () => 'task-1', cancel: async () => {} },
    events: {
      on: () => {},
      // tool 推快照 → 直接喂给 panel 的监听器（真实链路的等价物）
      emit: (n, d) => { for (const fn of (handlers.get(n) || [])) fn(d); }
    },
    bubble: () => {}, playAnim: () => {}
  };
  await collector.start(petTool);

  const rows = [...dom.window.document.querySelectorAll('.row')];
  assert.strictEqual(rows.length, 1, `期望渲染 1 行，实际 ${rows.length}`);
  const badge = rows[0].querySelector('.badge');
  assert.ok(badge.classList.contains('is-codex'), 'codex 会话没渲染成 codex 徽标');
  assert.strictEqual(rows[0].dataset.state, 'running');
  assert.strictEqual(rows[0].querySelector('.project').textContent,
    path.basename(fixtureOf('user-prompt-submit.json').cwd));
  assert.strictEqual(rows[0].querySelector('.subline').textContent, t('state.running'));

  // 可跳性跟着实际 tty 走：管道里跑 tty 为 null → 不该是可点态（无假入口）；
  // 若真在 pty 下跑到了 tty，注入的进程表会认出 iTerm2 → 该可点并发出 jump 意图。
  const canJump = rows[0].classList.contains('can-jump');
  assert.strictEqual(canJump, actualTty != null,
    `可跳性与 tty 不符：tty=${actualTty} can-jump=${canJump}`);
  rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const jump = emitted.filter((e) => e.name === 'agent-status:jump');
  assert.strictEqual(jump.length, canJump ? 1 : 0,
    canJump ? 'codex 行点击没发出 jump 意图' : '不可跳的行不该挂 click handler');
  if (canJump) {
    assert.strictEqual(jump[0].data.sessionId, fixtureOf('user-prompt-submit.json').session_id);
  }

  await collector.stop(petTool);
  dom.window.close();
});

test('端到端：带 tty 的 codex 行点击 → tool 真的尝试跳转，失败经快照回推行内错误条', async () => {
  // 上一条端到端的可跳性跟着管道里的 tty（null）走，click→jump 那段是条件断言。
  // 这条用带 tty 的 codex 记录把整条链路无条件跑通：点击 → jump 意图 → tool 执行 →
  // 失败文案回推 → 行内错误条出现。osascript **绝不真跑**（注入 runner）。
  const dir = tmp();
  sf.writeStatus({
    agent: 'codex', sessionId: 'codex-jump-1', cwd: '/Users/me/projects/gamma',
    tty: '/dev/ttys007', pid: 4242, state: 'running', lastEvent: 'UserPromptSubmit',
    ts: T0, threadId: '01a08ab6-557f-77b3-bc37-3553f712b2e0'
  }, dir);

  const html = fs.readFileSync(path.join(ROOT, 'panel', 'panel.html'), 'utf8');
  const panelHandlers = new Map();
  const toolHandlers = new Map();
  const petPanel = {
    events: {
      on: (n, fn) => { panelHandlers.set(n, (panelHandlers.get(n) || []).concat(fn)); },
      emit: (n, d) => { for (const fn of (toolHandlers.get(n) || [])) fn(d); }
    }
  };
  const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(w) { w.pet = petPanel; } });

  const ITERM = '/Applications/iTerm.app/Contents/MacOS/iTerm2';
  let runnerCalls = 0;
  const collector = tool.createCollector({
    dir, now: () => T0, isPidAlive: () => true, locale: 'zh-CN',
    settingsFile: path.join(tmp(), 'settings.json'),
    codexHooksFile: hooksFileIn(tmp()),
    psTree: [
      { pid: 100, ppid: 1, tty: '??', comm: ITERM },
      { pid: 200, ppid: 100, tty: 'ttys007', comm: '/bin/zsh' }
    ],
    // 伪造执行器：记一次调用并报失败。绝不 spawn 真 osascript（会抢真实桌面焦点）
    jumpRunner: () => { runnerCalls++; throw new Error('osascript boom'); }
  });
  const petTool = {
    scheduler: { every: async () => 'task-1', cancel: async () => {} },
    events: {
      on: (n, fn) => { toolHandlers.set(n, (toolHandlers.get(n) || []).concat(fn)); },
      emit: (n, d) => { for (const fn of (panelHandlers.get(n) || [])) fn(d); }
    },
    bubble: () => {}, playAnim: () => {}
  };
  await collector.start(petTool);

  const doc = dom.window.document;
  const row = doc.querySelector('.row[data-session-id="codex-jump-1"]');
  assert.ok(row, 'codex 行没渲染出来');
  assert.ok(row.classList.contains('can-jump'), '带 tty 且认得出终端的 codex 行应可点');
  assert.ok(row.querySelector('.badge').classList.contains('is-codex'));

  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.strictEqual(runnerCalls, 1, 'codex 行点击没真走到跳转执行（走的应是与 claude 同一条路）');
  const err = doc.querySelector('.jump-error[data-session-id="codex-jump-1"]');
  assert.ok(err, '跳转失败没回推行内错误条（不许静默）');
  assert.ok(err.textContent.length > 0);
  assert.notStrictEqual(err.textContent, 'jump.failed', '错误条显示的是 locale key，说明取词没成');

  await collector.stop(petTool);
  dom.window.close();
});

test('端到端：点 Codex 接入 → tool 真写临时 hooks.json → 面板翻成已接入', async () => {
  const codexFile = hooksFileIn(tmp());
  const html = fs.readFileSync(path.join(ROOT, 'panel', 'panel.html'), 'utf8');
  const handlers = new Map();
  const petPanel = {
    events: {
      on: (n, fn) => { handlers.set(n, (handlers.get(n) || []).concat(fn)); },
      emit: (n, d) => { for (const fn of (toolHandlers.get(n) || [])) fn(d); }
    }
  };
  const toolHandlers = new Map();
  const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(w) { w.pet = petPanel; } });

  const collector = tool.createCollector({
    dir: tmp(), now: () => T0, isPidAlive: () => true, locale: 'zh-CN',
    settingsFile: path.join(tmp(), 'settings.json'),
    codexHooksFile: codexFile,
    psTree: []
  });
  const petTool = {
    scheduler: { every: async () => 'task-1', cancel: async () => {} },
    events: {
      on: (n, fn) => { toolHandlers.set(n, (toolHandlers.get(n) || []).concat(fn)); },
      emit: (n, d) => { for (const fn of (handlers.get(n) || [])) fn(d); }
    },
    bubble: () => {}, playAnim: () => {}
  };
  await collector.start(petTool);

  const doc = dom.window.document;
  assert.strictEqual(doc.getElementById('install-codex').hidden, false, '起手应显示 Codex 接入按钮');
  assert.strictEqual(fs.existsSync(codexFile), false, '还没点就写了配置');

  doc.getElementById('install-codex').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.ok(fs.existsSync(codexFile), '点了接入却没写 hooks.json');
  assert.strictEqual(installer.isInstalled({ hooksFile: codexFile }), true);
  assert.strictEqual(doc.getElementById('install-codex').hidden, true, '面板没翻成已接入');
  assert.strictEqual(doc.getElementById('codex-installed').hidden, false);
  assert.strictEqual(doc.getElementById('codex-trust').hidden, false, '接入后必须提示 Codex 信任步骤');
  // Claude 那档不该被带着翻面
  assert.strictEqual(doc.getElementById('install-claude').hidden, false);

  // 再点移除 → 配置收回，面板翻回去
  doc.getElementById('uninstall-codex').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(installer.isInstalled({ hooksFile: codexFile }), false);
  assert.strictEqual(doc.getElementById('install-codex').hidden, false, '移除后应显示回接入按钮');
  assert.strictEqual(doc.getElementById('codex-trust').hidden, true);

  await collector.stop(petTool);
  dom.window.close();
});

// ================================================================
// 6. 红线与隔离
// ================================================================

test('新增代码零硬编码中文（中文只许在 locales/*.json）', () => {
  for (const f of ['lib/codex-events.js', 'lib/codex-hooks-installer.js',
    'lib/hooks-installer-core.js', 'hooks/codex-status-hook.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hit = src.match(/[一-鿿]/);
    assert.strictEqual(hit, null, `${f} 有中文字面量：${hit && hit[0]}`);
  }
});

test('插件形态：新增模块只 require 披露过的 Node 内建，无 eval / 动态 require / 联网', () => {
  for (const f of ['lib/codex-events.js', 'lib/codex-hooks-installer.js',
    'lib/hooks-installer-core.js', 'hooks/codex-status-hook.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\beval\s*\(/.test(src), `${f} 用了 eval`);
    assert.ok(!/new\s+Function\s*\(/.test(src), `${f} 用了 new Function`);
    assert.ok(!/require\(['"](https?|http|net|dgram|tls)['"]\)/.test(src), `${f} 联网了`);
    assert.ok(!/\bfetch\s*\(/.test(src), `${f} 用了 fetch`);
    const mods = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const m of mods) {
      assert.ok(m.startsWith('.') || ['fs', 'os', 'path'].includes(m),
        `${f} require 了未披露的模块 ${m}`);
    }
  }
});

test('PROTOCOL.md 只增不改：Claude Code 映射表七行原样在位', () => {
  const md = fs.readFileSync(path.join(ROOT, 'PROTOCOL.md'), 'utf8');
  const claudeTable = md.slice(md.indexOf('| Claude Code hook 事件'), md.indexOf('Codex CLI 事件映射'));
  const EXPECT = [
    ['SessionStart', 'running'], ['UserPromptSubmit', 'running'],
    ['PreToolUse` / `PostToolUse', 'running'], ['Notification', 'waiting'],
    ['Stop', 'done'], ['SessionEnd', 'ended']
  ];
  for (const [ev, st] of EXPECT) {
    const line = claudeTable.split('\n').find((l) => l.includes(`\`${ev}\``));
    assert.ok(line, `Claude Code 表少了 ${ev} 这一行`);
    assert.ok(line.includes(`\`${st}\``), `Claude Code 表的 ${ev} 被改动了：${line}`);
  }
  assert.strictEqual(md.includes('schema:1'), true, 'schema 版本不该被动');
});

test('测试全程未触碰真实 ~/.codex 与真实状态目录', () => {
  assert.deepStrictEqual(leakedTestFiles(), [], '测试数据泄漏进了真实状态目录');
  assert.deepStrictEqual(leakedBackups(), [], '测试在真实配置旁留下了备份文件');
});

// ---- 收尾 ----
runAll().then(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  if (failures.length) {
    console.error(`\ncodex-hook-test: ${failures.length} failed / ${passed} passed`);
    process.exit(1);
  }
  console.log(`\ncodex-hook-test: ${passed} passed`);
});
