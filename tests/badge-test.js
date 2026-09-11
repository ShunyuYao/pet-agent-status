'use strict';
// 折叠徽标（lib/badge.js）——宿主 pet.badge.* 的消费侧。
//
// 需求条件 → 断言（PRD docs/prd-pet-badge-sdk.md US-B03，先断言后实现）：
//   ① summary → segments 映射：waiting→warning 段、running→primary 段，waiting 恒排最左
//   ② 无会话 → clear，不留空徽标
//   ③ onClick 恒为 'openPanel'
//   ④ 变化才发：同一份 summary 不重复 set（tick 是 2s 一轮，每轮都发＝每 2s 一次跨进程 IPC）
//   ⑤ 旧宿主（无 pet.badge）静默降级，不抛异常、不打断采集
//   ⑥ set 被拒（名额被占）不重试风暴；内容变了才再试
//   ⑦ dispose 撤徽标
const assert = require('assert');
const path = require('path');
const { createBadgeLink, segmentsFor } = require(path.join(__dirname, '..', 'lib', 'badge.js'));

let passed = 0;
function test(name, fn) {
  const r = fn();
  const done = () => { passed++; console.log('  ok ', name); };
  if (r && typeof r.then === 'function') return r.then(done, (e) => { console.log('  FAIL', name); throw e; });
  done();
  return Promise.resolve();
}

function mockPet() {
  const calls = [];
  return {
    calls,
    setResult: true,
    pet: {
      badge: {
        set(o) { calls.push(['set', o]); return Promise.resolve(this._owner.setResult); },
        clear() { calls.push(['clear']); return Promise.resolve(true); },
      },
    },
  };
}
// set 的返回值要能被测试改，绑一下 owner
function makePet() {
  const m = mockPet();
  m.pet.badge._owner = m;
  return m;
}

(async () => {
  // ① 映射与排序
  await test('summary → segments：waiting 恒排最左，running 跟后', () => {
    assert.deepStrictEqual(segmentsFor({ waiting: 1, running: 2 }),
      [{ tone: 'warning', text: '1' }, { tone: 'primary', text: '2' }]);
    assert.deepStrictEqual(segmentsFor({ waiting: 0, running: 3 }), [{ tone: 'primary', text: '3' }]);
    assert.deepStrictEqual(segmentsFor({ waiting: 2, running: 0 }), [{ tone: 'warning', text: '2' }]);
  });

  await test('无会话 → null（上层据此 clear）', () => {
    assert.strictEqual(segmentsFor({ waiting: 0, running: 0 }), null);
    assert.strictEqual(segmentsFor(null), null);
  });

  await test('段文本 ≤4 字符（宿主硬限，超了整条 set 会被拒）', () => {
    const segs = segmentsFor({ waiting: 0, running: 123456 });
    assert.ok(segs[0].text.length <= 4, `实际 ${segs[0].text}`);
    assert.strictEqual(segs[0].text, '999+');
  });

  // ②③ 首次投递
  await test('首次有会话：set 一次，onClick=openPanel', async () => {
    const m = makePet();
    const link = createBadgeLink();
    const r = await link.onSummary({ waiting: 1, running: 2 }, m.pet);
    assert.strictEqual(r, 'set');
    assert.strictEqual(m.calls.length, 1);
    assert.strictEqual(m.calls[0][0], 'set');
    assert.strictEqual(m.calls[0][1].onClick, 'openPanel');
    assert.deepStrictEqual(m.calls[0][1].segments,
      [{ tone: 'warning', text: '1' }, { tone: 'primary', text: '2' }]);
  });

  // ④ 去重
  await test('变化才发：同一份 summary 连发三轮只 set 一次', async () => {
    const m = makePet();
    const link = createBadgeLink();
    await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    const a = await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    const b = await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    assert.strictEqual(a, 'skip');
    assert.strictEqual(b, 'skip');
    assert.strictEqual(m.calls.filter((c) => c[0] === 'set').length, 1, '只应 set 一次');
  });

  await test('内容真变化时才再发', async () => {
    const m = makePet();
    const link = createBadgeLink();
    await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    await link.onSummary({ waiting: 1, running: 1 }, m.pet);
    assert.strictEqual(m.calls.filter((c) => c[0] === 'set').length, 2);
  });

  // ② 空态
  await test('从有会话到无会话：clear 一次，且不反复 clear', async () => {
    const m = makePet();
    const link = createBadgeLink();
    await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    const r1 = await link.onSummary({ waiting: 0, running: 0 }, m.pet);
    const r2 = await link.onSummary({ waiting: 0, running: 0 }, m.pet);
    assert.strictEqual(r1, 'clear');
    assert.strictEqual(r2, 'skip');
    assert.strictEqual(m.calls.filter((c) => c[0] === 'clear').length, 1);
  });

  // ⑤ 旧宿主降级
  await test('旧宿主（无 pet.badge）静默降级，不抛异常', async () => {
    const link = createBadgeLink();
    const legacy = { bubble() {}, playAnim() {} };   // 0.19.0 之前的宿主 SDK
    const r = await link.onSummary({ waiting: 1, running: 1 }, legacy);
    assert.strictEqual(r, 'unsupported');
    // 再来一轮也不抛
    assert.strictEqual(await link.onSummary({ waiting: 2, running: 0 }, legacy), 'unsupported');
  });

  await test('pet.badge 只有一半方法时也按不支持处理（防半残宿主）', async () => {
    const link = createBadgeLink();
    const half = { badge: { set() { return Promise.resolve(true); } } };  // 没有 clear
    assert.strictEqual(await link.onSummary({ waiting: 1, running: 0 }, half), 'unsupported');
  });

  // ⑥ 被拒不重试
  await test('set 返回 false（名额被占）：同内容不重试，内容变了才再试', async () => {
    const m = makePet();
    m.setResult = false;
    const link = createBadgeLink();
    const r1 = await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    const r2 = await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    assert.strictEqual(r1, 'rejected');
    assert.strictEqual(r2, 'skip', '同内容不应反复试');
    assert.strictEqual(m.calls.filter((c) => c[0] === 'set').length, 1);
    // 内容变了：再试一次（名额可能已经释放）
    await link.onSummary({ waiting: 1, running: 1 }, m.pet);
    assert.strictEqual(m.calls.filter((c) => c[0] === 'set').length, 2);
  });

  await test('宿主 set 抛异常时不打断采集（返回 rejected 而非抛出）', async () => {
    const link = createBadgeLink();
    const boom = { badge: { set() { throw new Error('host exploded'); }, clear() { return Promise.resolve(true); } } };
    assert.strictEqual(await link.onSummary({ waiting: 1, running: 0 }, boom), 'rejected');
  });

  // ⑦ dispose
  await test('dispose 撤徽标（正常停用路径自己收干净）', async () => {
    const m = makePet();
    const link = createBadgeLink();
    await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    await link.dispose(m.pet);
    assert.strictEqual(m.calls.filter((c) => c[0] === 'clear').length, 1);
    // dispose 后状态重置：同样的 summary 会重新 set
    await link.onSummary({ waiting: 0, running: 1 }, m.pet);
    assert.strictEqual(m.calls.filter((c) => c[0] === 'set').length, 2);
  });

  await test('旧宿主上 dispose 不抛', async () => {
    const link = createBadgeLink();
    await link.dispose({ bubble() {} });
  });

  console.log(`badge-test: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
