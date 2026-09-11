'use strict';
// rollout 活动探测（PROTOCOL.md「rollout 活动信号」；实测依据 fixtures/codex-ipc-facts.md §10.2）。
//
// 需求条件 → 断言：
//   ① 今天目录里 mtime 新鲜的 rollout 文件 → 报告该 threadId（文件名解析，不读内容）
//   ② mtime 超窗（>30s）→ 不报告
//   ③ 昨天目录（跨午夜边界）也扫；前天不扫
//   ④ 文件名不合 rollout-<…>-<UUID>.jsonl 形态 → 忽略（脏名不进结果）
//   ⑤ sessions 目录不存在 / stat 失败 → 静默空结果，绝不抛
//   ⑥ 全程只碰临时目录（真实 ~/.codex 由注入的 codexHome 隔离）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createRolloutActivity, ACTIVE_WINDOW_MS } = require(path.join(ROOT, 'lib', 'codex-rollout-activity.js'));

const CID = '01a090b0-117a-77b1-9e02-2ccfef2171c2';   // §10 实录里的真实 UUID
const CID2 = '01a08a1d-4f63-7e30-af03-48ae77b414b5';

let passed = 0;
const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-rollout-'));
  tmpDirs.push(d);
  return d;
}
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { console.log('  FAIL', name); throw e; }
}

// 按本地日期造 sessions/YYYY/MM/DD 目录（与实现同一套补零规则）
function dayDirOf(home, ms) {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const p = path.join(home, 'sessions', String(d.getFullYear()), mm, dd);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function touchRollout(dir, cid, mtimeMs, name) {
  const f = path.join(dir, name || `rollout-2026-09-11T21-37-33-${cid}.jsonl`);
  fs.writeFileSync(f, '');   // 内容无关：实现只 stat 不读
  fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
}

// 固定「当前时刻」：正午，避免真实午夜边界干扰昨天/前天目录的日期计算
const NOON = new Date(2026, 8, 11, 12, 0, 0).getTime();
function rig(home) {
  return createRolloutActivity({ codexHome: home, now: () => NOON });
}

test('① 新鲜 rollout → 报告 threadId（含 mtime），不读内容', () => {
  const home = tmp();
  touchRollout(dayDirOf(home, NOON), CID, NOON - 5000);
  const m = rig(home).activeThreads();
  assert.strictEqual(m.size, 1);
  assert.ok(m.has(CID));
  assert.strictEqual(m.get(CID), NOON - 5000);
});

test('② mtime 超窗 → 不报告；窗内窗外并存只报窗内', () => {
  const home = tmp();
  const dir = dayDirOf(home, NOON);
  touchRollout(dir, CID, NOON - ACTIVE_WINDOW_MS - 1000);
  touchRollout(dir, CID2, NOON - 1000);
  const m = rig(home).activeThreads();
  assert.deepStrictEqual([...m.keys()], [CID2]);
});

test('③ 昨天目录也扫（跨午夜）；前天不扫', () => {
  const home = tmp();
  const DAY = 24 * 60 * 60 * 1000;
  // mtime 都造成「新鲜」的——扫不扫只由目录日期决定，别让窗口过滤掺和进来
  touchRollout(dayDirOf(home, NOON - DAY), CID, NOON - 2000);
  touchRollout(dayDirOf(home, NOON - 2 * DAY), CID2, NOON - 2000);
  const m = rig(home).activeThreads();
  assert.deepStrictEqual([...m.keys()], [CID], '昨天要扫、前天不扫');
});

test('④ 文件名不合形态 → 忽略', () => {
  const home = tmp();
  const dir = dayDirOf(home, NOON);
  for (const bad of ['notes.jsonl', `rollout-x-${CID}.txt`, 'rollout-2026-not-a-uuid.jsonl',
    `rollout-${CID}`, `prefix-rollout-t-${CID}.jsonl`]) {
    touchRollout(dir, CID, NOON - 1000, bad);
  }
  assert.strictEqual(rig(home).activeThreads().size, 0);
});

test('⑤ sessions 目录不存在 → 空结果不抛', () => {
  const home = tmp();   // 不建 sessions
  assert.doesNotThrow(() => {
    assert.strictEqual(rig(home).activeThreads().size, 0);
  });
});

test('⑥ 只碰临时目录', () => {
  for (const d of tmpDirs) assert.ok(d.startsWith(os.tmpdir()));
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`codex-rollout-activity-test: ${passed} passed`);
