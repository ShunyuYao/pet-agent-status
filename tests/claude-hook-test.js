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

// 夹具是监工用真实会话实录回填的，session_id / cwd 会随重录而变。
// 断言必须从夹具现读，不能把某次录制的字面值抄进测试 —— 抄了就等于把测试
// 绑死在一份录制上，换一份实录就红，而红的原因与被测行为无关。
function fixtureOf(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
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
// 隔离自证：测试**自己的数据**不得出现在真实路径里。
// 判据不是「真实目录没变过」——维护者自己也在用这个插件，开发机上真实会话会持续写状态目录，
// 那种守卫随机变红且说明不了问题（2026-09-11 实测）。按测试专属前缀查泄漏才抓得准。
const TEST_ID_PREFIX = 'pet-as-test-';
function leakedTestFiles() {
  const dir = path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
  if (!fs.existsSync(dir)) return [];
  try { return fs.readdirSync(dir).filter((n) => n.includes(TEST_ID_PREFIX)); } catch (_) { return []; }
}

test('落盘记录字段齐全且符合 PROTOCOL.md schema:1', () => {
  const dir = tmp();
  const before = Date.now();
  const fx = fixtureOf('user-prompt-submit.json');
  runFixture('user-prompt-submit.json', dir);
  const rec = readOnly(dir);

  assert.strictEqual(rec.schema, 1);
  assert.strictEqual(rec.agent, 'claude-code');
  assert.strictEqual(rec.sessionId, fx.session_id);
  assert.strictEqual(rec.cwd, fx.cwd);
  assert.strictEqual(rec.project, path.basename(fx.cwd), 'project = basename(cwd)');
  assert.ok(rec.tty === null || typeof rec.tty === 'string', 'tty 必须是 string|null');
  assert.ok(rec.pid === null || Number.isFinite(rec.pid), 'pid 必须是 number|null');
  assert.strictEqual(rec.source, 'hook');
  assert.ok(Number.isInteger(rec.ts) && rec.ts >= before && rec.ts <= Date.now(), 'ts 是 Unix 毫秒');

  // 协议必填项一个都不许少
  for (const key of ['schema', 'agent', 'sessionId', 'cwd', 'project', 'tty', 'pid', 'state', 'lastEvent', 'ts']) {
    assert.ok(key in rec, `缺必填字段 ${key}`);
  }
  // 未在协议里的字段不许乱写（会话正文除 title 让步边界外不许采集）
  const extra = Object.keys(rec).filter((k) => ![
    'schema', 'agent', 'sessionId', 'cwd', 'project', 'tty', 'pid', 'state', 'lastEvent', 'ts', 'threadId', 'source', 'title', 'since'
  ].includes(k));
  assert.deepStrictEqual(extra, [], `写入了协议外字段: ${extra.join(',')}`);
  // US-9 显式反转了「零 prompt 内容」：标题 = prompt 首行（64 码点截断）是唯一让步，
  // 完整正文仍不许落盘（多行/超长部分的断言见下面「标题让步边界」组）。
  assert.strictEqual(typeof rec.title, 'string', 'UserPromptSubmit 应写入标题兜底');
  assert.ok(rec.title.length > 0 && Array.from(rec.title).length <= 65, '标题必须截断（64 码点 + 省略号）');
});

// ---- US-9 标题：让步边界与首见定名（用户动作驱动：真实 stdin 喂 hook）----

test('标题 = prompt 首个非空行；第二行起（正文）绝不落盘', () => {
  const dir = tmp();
  const base = fixtureOf('user-prompt-submit.json');
  const secret = 'SECRET-BODY-LINE-不许出现在状态文件里';
  runHook(Object.assign({}, base, { prompt: `修一下登录页的报错\n${secret}\n第三行` }), dir);
  const rec = readOnly(dir);
  assert.strictEqual(rec.title, '修一下登录页的报错');
  assert.ok(!JSON.stringify(rec).includes(secret), '完整正文（第二行起）不许落盘');
});

test('超长 prompt 按码点截断成 64+…，剩余部分不落盘', () => {
  const dir = tmp();
  const base = fixtureOf('user-prompt-submit.json');
  const long = '长'.repeat(200);
  runHook(Object.assign({}, base, { prompt: long }), dir);
  const rec = readOnly(dir);
  assert.strictEqual(rec.title, `${'长'.repeat(64)}…`);
  assert.ok(!JSON.stringify(rec).includes('长'.repeat(65)), '截断之外的正文不许落盘');
});

test('首见定名：后续 prompt 与 Stop 都不改标题', () => {
  const dir = tmp();
  const base = fixtureOf('user-prompt-submit.json');
  runHook(Object.assign({}, base, { prompt: '第一条任务' }), dir);
  runHook(Object.assign({}, base, { prompt: '第二条完全不同的任务' }), dir);
  assert.strictEqual(readOnly(dir).title, '第一条任务', '标题是会话的名字，不随后续 prompt 改');
  runHook(Object.assign({}, base, { hook_event_name: 'Stop' }), dir);
  const rec = readOnly(dir);
  assert.strictEqual(rec.state, 'done');
  assert.strictEqual(rec.title, '第一条任务', '无 prompt 的事件覆盖写不许冲掉标题');
});

test('SessionStart（无 prompt）不造标题；空白 prompt 不造空标题', () => {
  const dir = tmp();
  runFixture('session-start.json', dir);
  assert.ok(!('title' in readOnly(dir)), 'SessionStart 没有 prompt，不该有标题');
  const dir2 = tmp();
  const base = fixtureOf('user-prompt-submit.json');
  runHook(Object.assign({}, base, { prompt: '   \n  \n' }), dir2);
  assert.ok(!('title' in readOnly(dir2)), '全空白 prompt 不许写空标题');
});

test('pid 写的是 Claude Code 进程（父进程），不是 hook 自己', () => {
  const dir = tmp();
  const res = runFixture('stop.json', dir);
  const rec = readOnly(dir);
  // hook 自己的 pid 退出后就没了，拿来做存活探测毫无意义；被观测对象是 agent 进程。
  // 2026-09-11 起不再恒等于直接父进程：hook 的父常是 agent 起的中间 shell（写完即退，
  // 拿它做存活探测会把活着的会话误判成 error），故取父链上第一个有 tty 的祖先＝agent 本体；
  // 测试环境里本进程没有控制终端（`ps` 返回 `??`），上溯找不到就回落父进程 —— 两者皆可，
  // 唯独不能是 hook 自己。
  assert.notStrictEqual(rec.pid, res.pid, 'pid 不该是 hook 自身的 pid');
  assert.ok(Number.isFinite(rec.pid) && rec.pid > 0, 'pid 应是个真实进程号');
});

// ---- 3. 同会话多事件覆盖写同一个文件 ----
test('同一 session 连续事件覆盖同一个文件（不堆积）', () => {
  const dir = tmp();
  // 必须真的是同一个 session_id 才在测「覆盖」。夹具里只有 6 份是同一次实录，
  // notification-permission.json 仍是早期合成样例（那次冒烟没触发权限提示），
  // 会话不同 —— 直接混用会写出两个文件，红的原因与被测行为无关。
  // 这里从实录夹具取会话，把中间那步的事件名换成 Notification，保持同会话。
  const base = fixtureOf('session-start.json');
  const waiting = Object.assign({}, base, {
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash'
  });
  runFixture('session-start.json', dir);
  runHook(waiting, dir);
  runFixture('stop.json', dir);

  // 三个事件同属一个 session，所以只该有一个文件（readOnly 内断言只有一个 .json）
  const rec = readOnly(dir);
  assert.strictEqual(rec.sessionId, base.session_id);
  assert.strictEqual(rec.state, 'done', '最后一个事件生效');
  assert.strictEqual(rec.lastEvent, 'Stop');
});

// 夹具漂移守卫：上面这条用例依赖「session-start / stop 属同一次实录」。
// 将来监工重录夹具时若只换其中一份，这条会先红并直说原因，而不是让上面那条
// 报一个「文件数 2 != 1」的哑谜。
test('实录夹具的 session_id 一致（换录制时先看这条）', () => {
  const recorded = ['session-start.json', 'user-prompt-submit.json', 'pre-tool-use.json',
    'post-tool-use.json', 'stop.json', 'session-end.json'];
  const ids = new Set(recorded.map((n) => fixtureOf(n).session_id));
  assert.strictEqual(ids.size, 1, `实录夹具应同属一个会话，实际有 ${ids.size} 个: ${[...ids].join(', ')}`);
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

// ---- 5.5 缺陷回归（2026-09-11 用户实测「计时突然归零」）：since 只在活跃段起点定一次 ----
// 根因：每个 hook 事件都整文件重写、ts 取写入时刻，面板 mm:ss 用 now-ts 计时，
// 于是每次工具调用（PreToolUse）都把计时打回 00:00。修法：协议加选填 since（活跃段起点），
// 同处活跃组（running/waiting）的后续事件继承之，离开活跃组再回来才重置。
test('工具调用/权限等待/批准恢复都不重置 since；新一轮任务才重置', () => {
  const dir = tmp();
  const base = fixtureOf('user-prompt-submit.json');
  const ev = (name) => Object.assign({}, base, { hook_event_name: name, session_id: 'since-seq' });
  const pause = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms); };

  runHook(ev('UserPromptSubmit'), dir);
  const first = readOnly(dir);
  assert.strictEqual(first.since, first.ts, '活跃段第一笔：since 从本次 ts 起算');

  pause(15); runHook(ev('PreToolUse'), dir);
  const afterTool = readOnly(dir);
  assert.ok(afterTool.ts > first.ts, '心跳 ts 应随事件刷新');
  assert.strictEqual(afterTool.since, first.since, '工具调用不得重置计时起点（本缺陷主症状）');

  pause(15); runHook(ev('Notification'), dir);
  assert.strictEqual(readOnly(dir).since, first.since, 'running→waiting 继承 since');

  pause(15); runHook(ev('PostToolUse'), dir);
  assert.strictEqual(readOnly(dir).since, first.since, '批准后恢复 running 继承 since');

  pause(15); runHook(ev('Stop'), dir);
  const doneRec = readOnly(dir);
  assert.ok(!('since' in doneRec), '离开活跃组（done）不写 since');

  pause(15); runHook(ev('UserPromptSubmit'), dir);
  const next = readOnly(dir);
  assert.strictEqual(next.since, next.ts, '新一轮任务：since 重置为新起点');
  assert.ok(next.since > first.since, '新起点晚于上一段');
});

// ---- 6. 真机缺陷回归（2026-09-11，v0.8.2）：闲置提醒被误报成「等待你批准」----
//
// 用户实测：compact 结束后会话闲着没动，面板把它标成「等待你批准」。
// 实录根因（fixtures/waiting-accuracy-facts.md）：`Notification` 是通用通知事件，
// 至少含 permission_prompt（真在等批准）与 idle_prompt（闲置 60s，等你说话）两类，
// 旧实现一律映射 waiting。803bf299 实录 `SessionStart:compact` @21:40:47 →
// `Notification` @21:41:47（整 60s，idle 计时器），全程无任何权限请求。
//
// 输入是 Claude Code 真实事件 JSON 经 stdin（不直调 stateForEvent）。

test('闲置提醒 Notification（matcher=idle_prompt）→ 不再是 waiting', () => {
  const dir = tmp();
  const base = fixtureOf('session-start.json');
  const res = runHook(Object.assign({}, base, {
    hook_event_name: 'Notification',
    matcher: 'idle_prompt',
    message: 'Claude is waiting for your input'
  }), dir);
  assert.strictEqual(res.status, 0);
  const rec = readOnly(dir);
  assert.notStrictEqual(rec.state, 'waiting', '闲置提醒不该显示成「等待你批准」');
  assert.strictEqual(rec.state, 'running', '会话还活着、只是在等用户说话');
});

test('闲置提醒：没有 matcher 时靠 message 文本兜底', () => {
  const dir = tmp();
  const base = fixtureOf('session-start.json');
  runHook(Object.assign({}, base, {
    hook_event_name: 'Notification',
    message: 'Claude is waiting for your input'
  }), dir);
  assert.strictEqual(readOnly(dir).state, 'running');
});

test('权限请求 Notification 仍然是 waiting（本插件的存在理由，不许误伤）', () => {
  const dir = tmp();
  const base = fixtureOf('session-start.json');
  runHook(Object.assign({}, base, {
    hook_event_name: 'Notification',
    matcher: 'permission_prompt',
    message: 'Claude needs your permission to use Bash'
  }), dir);
  assert.strictEqual(readOnly(dir).state, 'waiting');
});

test('方向性保守：message/matcher 都缺席的 Notification 仍按 waiting', () => {
  // 宁可多报一次等待，也不能把真在等批准的会话说成在跑——那会让用户错过批准。
  const dir = tmp();
  const base = fixtureOf('session-start.json');
  runHook(Object.assign({}, base, { hook_event_name: 'Notification' }), dir);
  assert.strictEqual(readOnly(dir).state, 'waiting', '拿不准必须保守报 waiting');
});

test('陌生措辞的 Notification 也按 waiting（不做反向猜测）', () => {
  const dir = tmp();
  const base = fixtureOf('session-start.json');
  runHook(Object.assign({}, base, {
    hook_event_name: 'Notification',
    message: 'Some future notification wording we have never seen'
  }), dir);
  assert.strictEqual(readOnly(dir).state, 'waiting');
});

test('compact 恢复（SessionStart source=compact）把陈旧 waiting 清回 running', () => {
  // 用户那条路径的完整重放：先真批准（waiting），再 compact 恢复。
  const dir = tmp();
  const base = fixtureOf('session-start.json');
  runHook(Object.assign({}, base, {
    hook_event_name: 'Notification',
    matcher: 'permission_prompt',
    message: 'Claude needs your permission to use Bash'
  }), dir);
  assert.strictEqual(readOnly(dir).state, 'waiting', '前置条件：先处于真实等待批准');

  const res = runFixture('session-start-compact.json', dir);
  assert.strictEqual(res.status, 0);
  const rec = readOnly(dir);
  assert.strictEqual(rec.state, 'running', 'compact 恢复后不该还挂着「等待你批准」');
  assert.strictEqual(rec.lastEvent, 'SessionStart');
});

// ---- 真机缺陷回归（2026-09-12）：Claude Desktop App 的空会话不许报「已完成」----
//
// 实录（fixtures/claude-desktop-facts.md §6，本机 poll 抓到）：每开一个 App 会话窗口，
// App 都会甩出一个**不到 1 秒的空会话**——只有 SessionStart→SessionEnd，没有任何提问、
// 没有工具调用。旧实现照常落一条 ended，面板把它显示成绿色「已完成」、计进汇总胶囊与
// 徽标，宠物还会为它喊一声「刚办完」。这是**误报完成**（PROTOCOL.md 红线），
// 与 Codex App「已读帧把刚开跑的任务翻成 ended」同一类：状态必须有证据支撑。
//
// 判据（方向性保守，同 Notification 那条）：只有**能证明它什么都没干**才清除——
// 已有记录且 lastEvent 仍停在 SessionStart。拿不到前一条记录（hook 中途才装、
// 目录被清过）时不做推断，照旧写 ended。

test('SessionStart→SessionEnd 的空会话：不留「已完成」行，状态文件被清除', () => {
  const dir = tmp();
  const start = fixtureOf('session-start.json');
  runFixture('session-start.json', dir);
  assert.strictEqual(readOnly(dir).state, 'running', '前置：SessionStart 该先落 running');
  const end = Object.assign({}, fixtureOf('session-end.json'), {
    session_id: start.session_id, cwd: start.cwd
  });
  const res = runHook(end, dir);
  assert.strictEqual(res.status, 0, 'hook 铁律：任何情况都退 0');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.json')), [],
    '空会话该被清除，绝不留一条绿色「已完成」（误报完成）');
});

test('干过活的会话正常收尾：SessionEnd 照常落 ended（清除只针对空会话）', () => {
  const dir = tmp();
  const start = fixtureOf('session-start.json');
  runFixture('session-start.json', dir);
  const prompt = Object.assign({}, fixtureOf('user-prompt-submit.json'), {
    session_id: start.session_id, cwd: start.cwd
  });
  runHook(prompt, dir);
  const end = Object.assign({}, fixtureOf('session-end.json'), {
    session_id: start.session_id, cwd: start.cwd
  });
  runHook(end, dir);
  const rec = readOnly(dir);
  assert.strictEqual(rec.state, 'ended', '提过问的会话结束时必须留 ended 行');
  assert.strictEqual(rec.lastEvent, 'SessionEnd');
});

test('拿不到前一条记录时不做推断：孤立的 SessionEnd 照旧落 ended', () => {
  const dir = tmp();
  runFixture('session-end.json', dir);
  assert.strictEqual(readOnly(dir).state, 'ended',
    'hook 中途才装 / 目录被清过时，没有证据说明它是空会话——保守写 ended');
});

// ---- 7. 隔离自证：全程没碰真实状态目录 ----
test('测试期间未写入真实 ~/.local/state/pet-agent-status', () => {
  assert.deepStrictEqual(leakedTestFiles(), [], '测试数据泄漏进了真实状态目录');
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nclaude-hook-test: ${passed} passed`);

// ---- 真机缺陷回归（2026-09-10，v0.2.2）：fd 全是 pipe 时靠 ps 兜底拿 tty ----

test('detectTtyByPid：ps 给出 ttysNNN 时拼成 /dev 路径；?? 与垃圾一律 null', () => {
  const td = require(path.join(ROOT, 'lib', 'tty-detect.js'));
  assert.strictEqual(td.detectTtyByPid(4242, () => 'ttys026\n'), '/dev/ttys026');
  assert.strictEqual(td.detectTtyByPid(4242, () => '??'), null, '无控制终端应为 null');
  assert.strictEqual(td.detectTtyByPid(4242, () => '../../etc/passwd'), null, '垃圾不得拼进路径');
  assert.strictEqual(td.detectTtyByPid(4242, () => { throw new Error('ps gone'); }), null, 'ps 失败不抛');
  assert.strictEqual(td.detectTtyByPid(0, () => 'ttys001'), null, '非法 pid 不查');
});

test('resolveTty：fd 路不通（Claude Code 给 hook 的 stdin/stdout 都是 pipe）时走 ps 兜底', () => {
  const td = require(path.join(ROOT, 'lib', 'tty-detect.js'));
  // fds 传空数组模拟「一个 fd 都不是 tty」——这正是真机形态，旧实现在此恒返回 null
  assert.strictEqual(td.resolveTty(4242, { fds: [], execFileSync: () => 'ttys017' }), '/dev/ttys017');
});
