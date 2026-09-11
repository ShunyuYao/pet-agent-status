'use strict';
// node 解释器解析（lib/node-bin.js）——写进 agent hooks 配置的那个可执行文件。
//
// 这组断言钉的是 2026-09-11 的真机缺陷：安装器用 process.execPath 当解释器，
// 而插件 tool 跑在宿主 Electron utilityProcess 里，execPath 是 Electron Helper，
// 写进 settings.json 后**所有 hook 静默失败**（agent 不报错、状态永不更新、
// 面板从不出现绿色 done）。核心用例就是「execPath 是 Electron 时绝不能采用它」。
const assert = require('assert');
const path = require('path');
const { resolveNodeBin, isNodeExecPath } = require(path.join(__dirname, '..', 'lib', 'node-bin.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { console.log('  FAIL', name); throw e; }
}

const ELECTRON = '/App/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron';

test('execPath 是 Electron 时绝不采用它（本缺陷的核心断言）', () => {
  const got = resolveNodeBin({
    env: {}, execPath: ELECTRON,
    fileExists: (p) => p === '/usr/local/bin/node' || p === ELECTRON,
    whichNode: () => null,
  });
  assert.strictEqual(got, '/usr/local/bin/node');
  assert.notStrictEqual(got, ELECTRON, 'Electron Helper 不是 node，不能写进 hooks');
});

test('isNodeExecPath 只认 basename 恰好是 node 的路径', () => {
  assert.strictEqual(isNodeExecPath('/usr/local/bin/node'), true);
  assert.strictEqual(isNodeExecPath('/x/bin/node'), true);
  assert.strictEqual(isNodeExecPath(ELECTRON), false);
  assert.strictEqual(isNodeExecPath('/x/nodejs'), false, 'nodejs 不算（避免误采同名前缀）');
  assert.strictEqual(isNodeExecPath('/x/node-wrapper'), false);
});

test('优先级：PET_AS_NODE_BIN > execPath 是 node > PATH > 兜底', () => {
  const exists = () => true;
  assert.strictEqual(resolveNodeBin({
    env: { PET_AS_NODE_BIN: '/custom/node' }, execPath: '/usr/bin/node',
    fileExists: exists, whichNode: () => '/from/path/node',
  }), '/custom/node', '显式指定优先');

  assert.strictEqual(resolveNodeBin({
    env: {}, execPath: '/usr/bin/node',
    fileExists: exists, whichNode: () => '/from/path/node',
  }), '/usr/bin/node', 'execPath 自己是 node 时直接用');

  assert.strictEqual(resolveNodeBin({
    env: {}, execPath: ELECTRON,
    fileExists: exists, whichNode: () => '/from/path/node',
  }), '/from/path/node', 'Electron 时落到 PATH');
});

test('PATH 查不到时走常见安装位置兜底（GUI 应用 PATH 常缺 nvm/homebrew）', () => {
  const got = resolveNodeBin({
    env: {}, execPath: ELECTRON,
    fileExists: (p) => p === '/opt/homebrew/bin/node',
    whichNode: () => null,
  });
  assert.strictEqual(got, '/opt/homebrew/bin/node');
});

test('指定的 PET_AS_NODE_BIN 不存在时不采用，继续往下找', () => {
  const got = resolveNodeBin({
    env: { PET_AS_NODE_BIN: '/gone/node' }, execPath: ELECTRON,
    fileExists: (p) => p === '/usr/bin/node',
    whichNode: () => null,
  });
  assert.strictEqual(got, '/usr/bin/node');
});

test('一个都找不到时抛错（宁可装不上，也不写一条注定失败的 hook）', () => {
  assert.throws(() => resolveNodeBin({
    env: {}, execPath: ELECTRON, fileExists: () => false, whichNode: () => null, fallbacks: [],
  }), /no usable node/);
});

test('which 抛异常不崩，继续兜底', () => {
  const got = resolveNodeBin({
    env: {}, execPath: ELECTRON,
    fileExists: (p) => p === '/usr/bin/node',
    whichNode: () => { throw new Error('which exploded'); },
    fallbacks: ['/usr/bin/node'],
  });
  assert.strictEqual(got, '/usr/bin/node');
});

console.log(`node-bin-test: ${passed} passed`);
