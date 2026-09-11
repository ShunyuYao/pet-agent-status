'use strict';
// US-9 验收测试：Codex 线程标题解析器（lib/codex-thread-titles.js）。
// 全离线：codexHome 一律 mkdtemp 注入，绝不读真实 ~/.codex（隔离红线）。
// 夹具形态照抄 fixtures/codex-ipc-facts.md §9 的实测结构：
//   sqlite/codex-dev.db 表 local_thread_catalog(thread_id, display_title, ...)
//   session_index.jsonl 每行 {id, thread_name, updated_at}

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createCodexThreadTitles } = require(path.join(ROOT, 'lib', 'codex-thread-titles.js'));

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { /* Node <22.5：catalog 支路按降级测 */ }

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-titles-'));
  tmpDirs.push(d);
  return d;
}

let passed = 0;
let skipped = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function testSqlite(name, fn) {
  if (!sqlite) { skipped++; console.log(`  SKIP(node:sqlite 不可用)  ${name}`); return; }
  test(name, fn);
}

const T1 = '01a08a1d-4f63-7e30-af03-48ae77b414b5';   // §9 实录的那条 App/vscode 线程形态
const T2 = '01a066a6-e447-7330-a44b-cd11653a36fa';

function writeIndex(home, rows) {
  fs.writeFileSync(path.join(home, 'session_index.jsonl'),
    rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

function writeCatalog(home, rows) {
  const dir = path.join(home, 'sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'codex-dev.db'));
  db.exec('CREATE TABLE IF NOT EXISTS local_thread_catalog (host_id TEXT NOT NULL, thread_id TEXT NOT NULL, display_title TEXT NOT NULL, PRIMARY KEY (host_id, thread_id))');
  const ins = db.prepare('INSERT OR REPLACE INTO local_thread_catalog (host_id, thread_id, display_title) VALUES (?, ?, ?)');
  for (const [id, title] of rows) ins.run('local', id, title);
  db.close();
}

// ---- 1. 两个源各自可用 ----

test('session_index.jsonl：id → thread_name；坏行跳过不废整个索引', () => {
  const home = tmp();
  writeIndex(home, [
    { id: T1, thread_name: '查找 Codex 宠物多会话管理', updated_at: 'x' },
    'this line is not json',
    { id: T2, thread_name: '再次尝试', updated_at: 'y' }
  ]);
  const titles = createCodexThreadTitles({ codexHome: home, now: () => 0 });
  assert.strictEqual(titles.lookup(T1), '查找 Codex 宠物多会话管理');
  assert.strictEqual(titles.lookup(T2), '再次尝试');
  assert.strictEqual(titles.lookup('01a00000-0000-7000-8000-000000000000'), null, '查不到返回 null，不造假标题');
});

testSqlite('catalog（codex-dev.db）可用且覆盖 index（catalog 较新）', () => {
  const home = tmp();
  writeIndex(home, [{ id: T1, thread_name: 'index 里的旧名', updated_at: 'x' }]);
  writeCatalog(home, [[T1, 'catalog 里的新名'], [T2, '只在 catalog 有']]);
  const titles = createCodexThreadTitles({ codexHome: home, now: () => 0 });
  assert.strictEqual(titles.lookup(T1), 'catalog 里的新名');
  assert.strictEqual(titles.lookup(T2), '只在 catalog 有');
});

// ---- 2. 降级路径全部静默 ----

test('codexHome 不存在 / 两个源都缺：lookup 一律 null 不抛', () => {
  const titles = createCodexThreadTitles({ codexHome: path.join(tmp(), 'no-such'), now: () => 0 });
  assert.strictEqual(titles.lookup(T1), null);
});

test('node:sqlite 不可用（注入 sqlite:null）时只走 index，不抛', () => {
  const home = tmp();
  writeIndex(home, [{ id: T1, thread_name: '只有索引', updated_at: 'x' }]);
  const titles = createCodexThreadTitles({ codexHome: home, now: () => 0, sqlite: null });
  assert.strictEqual(titles.lookup(T1), '只有索引');
});

testSqlite('db 文件是垃圾（表不存在）时静默降级到 index', () => {
  const home = tmp();
  writeIndex(home, [{ id: T1, thread_name: '索引兜底', updated_at: 'x' }]);
  fs.mkdirSync(path.join(home, 'sqlite'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sqlite', 'codex-dev.db'), 'not a sqlite file');
  const titles = createCodexThreadTitles({ codexHome: home, now: () => 0 });
  assert.strictEqual(titles.lookup(T1), '索引兜底');
});

test('非法入参：非字符串/空串 threadId 一律 null', () => {
  const titles = createCodexThreadTitles({ codexHome: tmp(), now: () => 0 });
  assert.strictEqual(titles.lookup(null), null);
  assert.strictEqual(titles.lookup(''), null);
  assert.strictEqual(titles.lookup(42), null);
});

// ---- 3. TTL：标题晚到（App 后台生成）也追得上 ----

test('TTL 内用缓存；TTL 过后拿到新写入的标题（标题是 App 事后生成的，必须能追上）', () => {
  const home = tmp();
  writeIndex(home, [{ id: T1, thread_name: '旧名', updated_at: 'x' }]);
  let clock = 0;
  const titles = createCodexThreadTitles({ codexHome: home, now: () => clock, ttlMs: 1000 });
  assert.strictEqual(titles.lookup(T1), '旧名');
  // 索引更新（App 生成/改写了标题）——TTL 未到仍是缓存值。
  // 显式 bump mtime：两次写可能落在同一毫秒，mtime 缓存会误判「没变」（测试防抖，非被测行为）
  writeIndex(home, [{ id: T1, thread_name: '新名', updated_at: 'y' }]);
  fs.utimesSync(path.join(home, 'session_index.jsonl'), new Date(), new Date(Date.now() + 5000));
  clock = 500;
  assert.strictEqual(titles.lookup(T1), '旧名', 'TTL 内不重读（避免每 tick 全量扫描）');
  clock = 1500;
  assert.strictEqual(titles.lookup(T1), '新名', 'TTL 过后必须看到新标题');
});

// ---- 4. 只读纪律：解析器绝不在 codexHome 里创建/修改文件 ----

testSqlite('lookup 全程不在 codexHome 下新增文件（readOnly 打开，查完即关）', () => {
  const home = tmp();
  writeIndex(home, [{ id: T1, thread_name: 'x', updated_at: 'x' }]);
  writeCatalog(home, [[T1, 'y']]);
  const before = fs.readdirSync(home).sort().concat(fs.readdirSync(path.join(home, 'sqlite')).sort());
  const titles = createCodexThreadTitles({ codexHome: home, now: () => 0 });
  titles.lookup(T1);
  const after = fs.readdirSync(home).sort().concat(fs.readdirSync(path.join(home, 'sqlite')).sort());
  assert.deepStrictEqual(after, before, '解析器不许在线程库目录留任何痕迹');
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\ncodex-thread-titles-test: ${passed} passed${skipped ? `, ${skipped} skipped` : ''}`);
