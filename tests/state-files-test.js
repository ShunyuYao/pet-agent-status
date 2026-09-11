'use strict';
// US-001 验收测试：状态文件协议库 + manifest 契约 + i18n。
// 全离线：只用 mkdtemp 临时目录，绝不碰真实 ~/.local/state。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sf = require(path.join(ROOT, 'lib', 'state-files.js'));
const i18n = require(path.join(ROOT, 'lib', 'i18n.js'));

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-test-'));
  tmpDirs.push(d);
  return d;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ---- 1. 写入产出的 JSON 逐字段符合 PROTOCOL.md schema:1 ----
test('writeStatus 落盘字段与 PROTOCOL.md 一致', () => {
  const dir = tmp();
  const before = Date.now();
  const { file } = sf.writeStatus({
    agent: 'claude-code',
    sessionId: 'abc-123',
    cwd: '/Users/me/projects/demo',
    tty: '/dev/ttys004',
    pid: 4242,
    state: 'running',
    lastEvent: 'UserPromptSubmit'
  }, dir);

  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(rec.schema, 1);
  assert.strictEqual(rec.agent, 'claude-code');
  assert.strictEqual(rec.sessionId, 'abc-123');
  assert.strictEqual(rec.cwd, '/Users/me/projects/demo');
  assert.strictEqual(rec.project, 'demo', 'project 应为 basename(cwd)');
  assert.strictEqual(rec.tty, '/dev/ttys004');
  assert.strictEqual(rec.pid, 4242);
  assert.strictEqual(rec.state, 'running');
  assert.strictEqual(rec.lastEvent, 'UserPromptSubmit');
  assert.strictEqual(rec.source, 'hook', 'hook 写入缺省 source=hook');
  assert.ok(Number.isInteger(rec.ts) && rec.ts >= before && rec.ts <= Date.now(), 'ts 必须是 Unix 毫秒');
  assert.strictEqual(path.basename(file), 'abc-123.json');
});

test('tty/pid 拿不到时写 null 而非缺字段', () => {
  const dir = tmp();
  const { record } = sf.writeStatus({
    agent: 'claude-code', sessionId: 's1', cwd: '/tmp/x', state: 'done', lastEvent: 'Stop'
  }, dir);
  assert.strictEqual(record.tty, null);
  assert.strictEqual(record.pid, null);
  assert.ok('tty' in record && 'pid' in record);
});

test('threadId 只在给了的时候出现（Codex 可选字段）', () => {
  const dir = tmp();
  const a = sf.writeStatus({ agent: 'claude-code', sessionId: 'no-thread', cwd: '/tmp/x', state: 'running', lastEvent: 'SessionStart' }, dir).record;
  assert.ok(!('threadId' in a));
  const b = sf.writeStatus({ agent: 'codex', sessionId: 'has-thread', cwd: '/tmp/x', state: 'running', lastEvent: 'SessionStart', threadId: 'uuid-1' }, dir).record;
  assert.strictEqual(b.threadId, 'uuid-1');
});

// ---- 2. 原子写：临时文件 + rename，且不留垃圾 ----
test('写入走 .tmp- 临时文件后 rename，结束后目录里没有残留 tmp', () => {
  const dir = tmp();
  sf.writeStatus({ agent: 'claude-code', sessionId: 's1', cwd: '/tmp/x', state: 'running', lastEvent: 'SessionStart' }, dir);
  const names = fs.readdirSync(dir);
  assert.deepStrictEqual(names, ['s1.json'], `不应有残留临时文件，实际：${names.join(',')}`);
});

test('并发覆盖写：读到的永远是完整 JSON（原子性可观测证据）', () => {
  const dir = tmp();
  for (let i = 0; i < 50; i++) {
    sf.writeStatus({ agent: 'claude-code', sessionId: 'race', cwd: '/tmp/x', state: 'running', lastEvent: `E${i}` }, dir);
    // 每次覆盖后立刻读，任何一次读到半截 JSON 都会在这里抛
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'race.json'), 'utf8'));
    assert.strictEqual(rec.lastEvent, `E${i}`);
  }
});

test('目录不存在时自动 mkdir -p', () => {
  const nested = path.join(tmp(), 'deep', 'deeper');
  sf.writeStatus({ agent: 'claude-code', sessionId: 's1', cwd: '/tmp/x', state: 'running', lastEvent: 'SessionStart' }, nested);
  assert.ok(fs.existsSync(path.join(nested, 's1.json')));
});

// ---- 3. sessionId 清洗 / 路径穿越 ----
test('sessionId 非法字符替换为 _，路径穿越输入不会逃出状态目录', () => {
  const dir = tmp();
  const { file } = sf.writeStatus({
    agent: 'claude-code', sessionId: '../../etc/passwd', cwd: '/tmp/x', state: 'running', lastEvent: 'SessionStart'
  }, dir);

  assert.strictEqual(path.dirname(file), dir, '落盘文件必须仍在状态目录内');
  assert.strictEqual(path.basename(file), '.._.._etc_passwd.json');
  assert.ok(!fs.existsSync('/etc/passwd.json'));
  assert.deepStrictEqual(fs.readdirSync(dir), ['.._.._etc_passwd.json']);
});

test('sanitizeSessionId 保留合法字符集、替换其余', () => {
  assert.strictEqual(sf.sanitizeSessionId('Abc-1._9'), 'Abc-1._9');
  assert.strictEqual(sf.sanitizeSessionId('a/b\\c d:e'), 'a_b_c_d_e');
  assert.strictEqual(sf.sanitizeSessionId('会话'), '__');
  assert.strictEqual(sf.sanitizeSessionId(''), '_', '空 id 也要有个安全文件名');
});

// ---- 4. 读快照：损坏容错，绝不抛 ----
test('readSnapshots 跳过损坏/缺字段/高 schema 文件并计入 unknown，不抛', () => {
  const dir = tmp();
  sf.writeStatus({ agent: 'claude-code', sessionId: 'good-1', cwd: '/tmp/a', state: 'running', lastEvent: 'SessionStart' }, dir);
  sf.writeStatus({ agent: 'codex', sessionId: 'good-2', cwd: '/tmp/b', state: 'waiting', lastEvent: 'Notification' }, dir);

  fs.writeFileSync(path.join(dir, 'broken.json'), '{ this is not json', 'utf8');
  fs.writeFileSync(path.join(dir, 'empty.json'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'array.json'), '[1,2,3]', 'utf8');
  // 缺必填 cwd
  fs.writeFileSync(path.join(dir, 'missing-field.json'), JSON.stringify({
    schema: 1, agent: 'claude-code', sessionId: 'x', project: 'x', tty: null, pid: null, state: 'running', lastEvent: 'Stop', ts: Date.now()
  }), 'utf8');
  // 未来 schema
  fs.writeFileSync(path.join(dir, 'future.json'), JSON.stringify({
    schema: 99, agent: 'claude-code', sessionId: 'f', cwd: '/tmp/f', project: 'f', tty: null, pid: null, state: 'running', lastEvent: 'Stop', ts: Date.now()
  }), 'utf8');
  // 非法 state
  fs.writeFileSync(path.join(dir, 'bad-state.json'), JSON.stringify({
    schema: 1, agent: 'claude-code', sessionId: 'b', cwd: '/tmp/b', project: 'b', tty: null, pid: null, state: 'exploded', lastEvent: 'Stop', ts: Date.now()
  }), 'utf8');
  // 非 .json 的杂物
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello', 'utf8');

  const snap = sf.readSnapshots(dir);
  const ids = snap.records.map((r) => r.sessionId).sort();
  assert.deepStrictEqual(ids, ['good-1', 'good-2'], '只有合法记录进快照');
  assert.strictEqual(snap.unknownCount, 6, `损坏文件应全部计入 unknown，实际 ${snap.unknownCount}`);
  const futureReason = snap.unknown.find((u) => u.file.endsWith('future.json')).reason;
  assert.strictEqual(futureReason, 'schema-too-new', '高 schema 要单独归类，绝不当 done');
});

test('未知字段读取时忽略、不影响记录可用', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify({
    schema: 1, agent: 'claude-code', sessionId: 'extra', cwd: '/tmp/e', project: 'e',
    tty: null, pid: null, state: 'running', lastEvent: 'SessionStart', ts: Date.now(),
    somethingFromTheFuture: { a: 1 }
  }), 'utf8');
  const snap = sf.readSnapshots(dir);
  assert.strictEqual(snap.records.length, 1);
  assert.strictEqual(snap.unknownCount, 0);
});

test('readSnapshots 对不存在的目录返回空快照而非抛', () => {
  const snap = sf.readSnapshots(path.join(tmp(), 'never-created'));
  assert.deepStrictEqual(snap.records, []);
  assert.strictEqual(snap.unknownCount, 0);
});

test('readSnapshots 忽略正在写入的临时文件（.tmp 后缀，非 .json）', () => {
  const dir = tmp();
  // 与 writeStatus 真实产出的临时文件同形：.tmp-<id>-<pid>-<rand>.tmp，半截 JSON
  fs.writeFileSync(path.join(dir, '.tmp-halfway-123-abcdef.tmp'), '{"schema":1,"agen', 'utf8');
  const snap = sf.readSnapshots(dir);
  assert.strictEqual(snap.records.length, 0);
  assert.strictEqual(snap.unknownCount, 0, '临时文件不该被当成损坏数据报警');
});

// 回归：sessionId 以 .tmp- 开头是协议允许的合法 ID（[A-Za-z0-9._-]），
// 读侧曾用 startsWith('.tmp-') 过滤临时文件，把这种真会话静默吃掉（records 0 且 unknownCount 0）。
test('sessionId 以 .tmp- 开头的合法会话能被写入并读回（不被当临时文件吞掉）', () => {
  const dir = tmp();
  const { file } = sf.writeStatus({
    agent: 'claude-code',
    sessionId: '.tmp-session',
    cwd: '/Users/me/projects/demo',
    tty: '/dev/ttys004',
    pid: 4242,
    state: 'running',
    lastEvent: 'SessionStart'
  }, dir);
  assert.strictEqual(path.basename(file), '.tmp-session.json', 'sanitizeSessionId 不该改写合法 ID');

  const snap = sf.readSnapshots(dir);
  assert.strictEqual(snap.records.length, 1, '合法会话必须出现在快照里');
  assert.strictEqual(snap.records[0].sessionId, '.tmp-session');
  assert.strictEqual(snap.records[0].state, 'running');
  assert.strictEqual(snap.unknownCount, 0);
  assert.strictEqual(sf.readStatus('.tmp-session', dir).lastEvent, 'SessionStart');
});

// 真临时文件与真会话共存时，前者被滤掉、后者被读到 —— 两条规则互不干扰。
test('临时文件与 .tmp- 开头的会话同目录共存时各归各位', () => {
  const dir = tmp();
  sf.writeStatus({ agent: 'codex', sessionId: '.tmp-real', cwd: '/tmp/x', state: 'waiting', lastEvent: 'Notification' }, dir);
  fs.writeFileSync(path.join(dir, '.tmp-real-999-zzzzzz.tmp'), '{"schema":1,"age', 'utf8');
  const snap = sf.readSnapshots(dir);
  assert.strictEqual(snap.records.length, 1);
  assert.strictEqual(snap.records[0].sessionId, '.tmp-real');
  assert.strictEqual(snap.unknownCount, 0);
});

test('readStatus / removeStatus 按清洗后的 id 命中', () => {
  const dir = tmp();
  sf.writeStatus({ agent: 'claude-code', sessionId: 'a/b', cwd: '/tmp/x', state: 'done', lastEvent: 'Stop' }, dir);
  assert.strictEqual(sf.readStatus('a/b', dir).state, 'done');
  assert.strictEqual(sf.readStatus('nope', dir), null);
  assert.strictEqual(sf.removeStatus('a/b', dir), true);
  assert.strictEqual(sf.readStatus('a/b', dir), null);
});

// ---- 5. 默认目录来自 PET_AGENT_STATUS_DIR（测试隔离约定本身是协议的一部分）----
test('stateDir 优先取 PET_AGENT_STATUS_DIR，缺省为 ~/.local/state/pet-agent-status', () => {
  const saved = process.env.PET_AGENT_STATUS_DIR;
  const dir = tmp();
  process.env.PET_AGENT_STATUS_DIR = dir;
  assert.strictEqual(sf.stateDir(), dir);
  // 不传 dir 时也必须落到覆盖目录（hook 就是这么用的）
  sf.writeStatus({ agent: 'claude-code', sessionId: 'env', cwd: '/tmp/x', state: 'running', lastEvent: 'SessionStart' });
  assert.ok(fs.existsSync(path.join(dir, 'env.json')));

  delete process.env.PET_AGENT_STATUS_DIR;
  assert.strictEqual(sf.stateDir(), path.join(os.homedir(), '.local', 'state', 'pet-agent-status'));
  if (saved === undefined) delete process.env.PET_AGENT_STATUS_DIR;
  else process.env.PET_AGENT_STATUS_DIR = saved;
});

// ---- 6. manifest 契约：用宿主校验器的规则逐字段核 ----
test('manifest.json 符合宿主 loadManifest 的校验规则', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  assert.ok(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(m.id) && !m.id.includes('..'), 'id 必须过宿主 ID_RE');
  assert.strictEqual(m.id, 'pet-agent-status');
  assert.ok(typeof m.name === 'string' && m.name.length > 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version), 'version 必须是 x.y.z');
  assert.ok(Number.isInteger(m.apiVersion) && m.apiVersion >= 1);
  assert.strictEqual(m.activation, 'opt-in', 'activation 只支持 opt-in');

  const KINDS = ['tool', 'panel', 'asset', 'skill', 'settings', 'service', 'dashboard-card'];
  assert.ok(Array.isArray(m.kind) && m.kind.length && m.kind.every((k) => KINDS.includes(k)));
  // settings kind 0.4.x 短暂用过（宿主设置页开关），0.5.0 撤下：开关唯一真相源改为
  // pet.storage + 面板设置视图 —— manifest 设置项只有宿主设置页能写，两处开关必漂
  assert.deepStrictEqual(m.kind, ['tool', 'panel']);

  assert.deepStrictEqual(m.permissions, ['storage', 'pet', 'ui', 'events', 'scheduler']);

  assert.strictEqual(m.entry.tool, 'tool/index.js', 'kind 含 tool 时 entry.tool 必填');
  assert.strictEqual(m.entry.panel.src, 'panel/panel.html', 'kind 含 panel 时 entry.panel.src 必填');
  assert.strictEqual(m.entry.panel.width, 320);
  assert.strictEqual(m.entry.panel.height, 420);
  assert.strictEqual(typeof m.entry.panel.title, 'string');
  assert.strictEqual(m.entry.panel.transparent, false, 'transparent 必须是 boolean');

  // 入口路径不许越界
  for (const p of [m.entry.tool, m.entry.panel.src]) {
    assert.ok(!path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'), `入口路径越界: ${p}`);
  }
  // kind 含 service / dashboard-card 才需要的字段，这里不该出现
  assert.ok(!m.provides, '未声明 service kind 就不该有 provides');
});

// ---- 7. i18n ----
test('i18n 按 locale 取词、缺词回落 zh-CN、占位符插值', () => {
  const catalogs = i18n.loadCatalogs(path.join(ROOT, 'locales'));
  assert.ok(catalogs['zh-CN'] && catalogs.en, 'zh-CN 与 en 词表都要存在');

  const en = i18n.createI18n(catalogs, 'en');
  assert.strictEqual(en.t('panel.title'), 'Agent Sessions');
  assert.strictEqual(en.t('panel.summary.running', { n: 3 }), '3 running');

  const zh = i18n.createI18n(catalogs, 'zh-CN');
  assert.strictEqual(zh.t('panel.summary.running', { n: 3 }), '3 运行中');
  assert.strictEqual(zh.t('bubble.done', { project: 'demo' }), '✅ demo 的差事办完啦～');

  // 未知 locale → 回落 zh-CN
  const unknown = i18n.createI18n(catalogs, 'ja');
  assert.strictEqual(unknown.locale, 'zh-CN');
  assert.strictEqual(unknown.t('panel.title'), 'Agent 会话');

  // 词表缺某个 key → 回落 zh-CN 的同 key
  const partial = i18n.createI18n({ 'zh-CN': catalogs['zh-CN'], en: { 'panel.title': 'Sessions' } }, 'en');
  assert.strictEqual(partial.t('panel.title'), 'Sessions');
  assert.strictEqual(partial.t('panel.footer.hint'), catalogs['zh-CN']['panel.footer.hint'], '缺词回落 zh-CN');

  // 全都没有 → 返回 key，不返回空串
  assert.strictEqual(zh.t('totally.missing.key'), 'totally.missing.key');
});

test('en 与 zh-CN 词表 key 集合一致（避免上线才发现漏翻）', () => {
  const catalogs = i18n.loadCatalogs(path.join(ROOT, 'locales'));
  const zhKeys = Object.keys(catalogs['zh-CN']).sort();
  const enKeys = Object.keys(catalogs.en).sort();
  assert.deepStrictEqual(enKeys, zhKeys);
});

// ---- 8. 零硬编码中文（AGENTS.md 文案双语规则）----
test('lib/ hooks/ 代码里没有中文字面量（中文只许在 locales/*.json）', () => {
  const cjk = /[一-鿿]/;
  const offenders = [];
  // 目录随 story 推进逐步出现（US-002 加 hooks/，US-003 加 tool/，US-004 加 panel/）；
  // 不存在的目录跳过，存在了就自动纳入扫描，避免新代码绕过这条门禁。
  const scanned = ['lib', 'hooks', 'tool'].filter((d) => fs.existsSync(path.join(ROOT, d)));
  for (const dir of scanned) {
  for (const file of fs.readdirSync(path.join(ROOT, dir))) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
    src.split('\n').forEach((line, i) => {
      // 注释可以写中文，字符串字面量不行
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      for (const m of code.matchAll(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g)) {
        if (cjk.test(m[0])) offenders.push(`${dir}/${file}:${i + 1} ${m[0]}`);
      }
    });
  }
  }
  assert.ok(scanned.includes('hooks'), 'hooks/ 已存在就必须被扫到');
  assert.deepStrictEqual(offenders, [], `发现硬编码中文：\n${offenders.join('\n')}`);
});

test('form 选填字段：合法值写入、非法值不写、读回校验（PROTOCOL.md schema:1 加法）', () => {
  const dir = tmp();
  const { record } = sf.writeStatus({
    agent: 'codex', sessionId: '01a08a1d-4f63-7e30-af03-48ae77b414b5', cwd: '',
    project: 'Codex App', tty: null, pid: null, state: 'running',
    lastEvent: 'ipc:queued-followups-changed', source: 'ipc', form: 'app', ts: 1789000000000
  }, dir);
  assert.strictEqual(record.form, 'app');
  assert.strictEqual(sf.validateRecord(record), null);
  // 非法 form：写入时不落该字段（不造假形态）
  const r2 = sf.buildRecord({ agent: 'codex', sessionId: 'x', cwd: '/p', state: 'running', lastEvent: 'e', ts: 1, form: 'browser' });
  assert.ok(!('form' in r2), '非法 form 不该落盘');
  // 读回校验：文件里出现非法 form 按损坏处理
  assert.strictEqual(sf.validateRecord(Object.assign({}, record, { form: 'browser' })), 'bad-form');
  // 缺省（老文件没有 form）仍合法
  const legacy = Object.assign({}, record);
  delete legacy.form;
  assert.strictEqual(sf.validateRecord(legacy), null, '没有 form 的旧记录必须继续可读');
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nstate-files-test: ${passed} passed`);

// ---- since：活跃段起点（2026-09-11 修「工具调用把 mm:ss 计时归零」缺陷）----

test('活跃组内 since 继承首次，不被后续事件刷新（计时不归零）', () => {
  const dir = tmp();
  const base = { schema: 1, agent: 'claude-code', sessionId: 's', cwd: '/x', project: 'p', tty: null, pid: 1 };
  const t0 = 1000000;
  sf.writeStatus({ ...base, state: 'running', lastEvent: 'UserPromptSubmit', ts: t0 }, dir);
  sf.writeStatus({ ...base, state: 'running', lastEvent: 'PreToolUse', ts: t0 + 60000 }, dir);
  sf.writeStatus({ ...base, state: 'waiting', lastEvent: 'Notification', ts: t0 + 90000 }, dir);
  const rec = sf.readSnapshots(dir).records[0];
  assert.strictEqual(rec.since, t0, 'running→PreToolUse→waiting 全在活跃组，since 应保持首次');
  assert.strictEqual(rec.ts, t0 + 90000, 'ts 仍是最后心跳（stale/error 推导要用它）');
});

test('离开活跃组再回来，since 重置为新起点', () => {
  const dir = tmp();
  const base = { schema: 1, agent: 'claude-code', sessionId: 's', cwd: '/x', project: 'p', tty: null, pid: 1 };
  const t0 = 1000000;
  sf.writeStatus({ ...base, state: 'running', lastEvent: 'UserPromptSubmit', ts: t0 }, dir);
  sf.writeStatus({ ...base, state: 'done', lastEvent: 'Stop', ts: t0 + 50000 }, dir);
  sf.writeStatus({ ...base, state: 'running', lastEvent: 'UserPromptSubmit', ts: t0 + 200000 }, dir);
  assert.strictEqual(sf.readSnapshots(dir).records[0].since, t0 + 200000, '新一轮应重新起算');
});

test('旧文件没有 since 时读得出来（schema:1 加法，向后兼容）', () => {
  const dir = tmp();
  const legacy = { schema: 1, agent: 'claude-code', sessionId: 'old', cwd: '/x', project: 'p', tty: null, pid: 1, state: 'running', lastEvent: 'PreToolUse', ts: 1000000 };
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify(legacy));
  const snap = sf.readSnapshots(dir);
  assert.strictEqual(snap.records.length, 1, '缺 since 的旧文件不该被当成损坏');
  assert.strictEqual(snap.records[0].since, undefined);
});

test('since 非数字时判损坏（不接受垃圾值）', () => {
  const dir = tmp();
  const bad = { schema: 1, agent: 'claude-code', sessionId: 'b', cwd: '/x', project: 'p', tty: null, pid: 1, state: 'running', lastEvent: 'X', ts: 1, since: 'nope' };
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(bad));
  const snap = sf.readSnapshots(dir);
  assert.strictEqual(snap.records.length, 0);
  assert.strictEqual(snap.unknown.length, 1);
});
