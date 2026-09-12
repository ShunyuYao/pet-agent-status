'use strict';
// US-004：真实 panel 挂载 → ready 意图 → 常驻 tool 回放 → 用户可见 DOM。
// 不推进 scheduler：此时若能看到会话，才证明打开面板无需等下一轮采集。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createCollector } = require('../tool');
const stateFiles = require('../lib/state-files');
const html = fs.readFileSync(path.join(__dirname, '../panel/panel.html'), 'utf8');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-bootstrap-'));
  const toolHandlers = new Map();
  let panelHandlers = new Map();
  let scheduled;
  let dom;
  let failReads = false;
  let releaseStartup;
  const record = { agent: 'codex', sessionId: 'pet-as-test-bootstrap', tty: null, pid: null,
    cwd: '', state: 'running', lastEvent: 'ipc:activity', ts: Date.now(), since: Date.now(),
    threadId: '01a08a1d-4f63-7e30-af03-48ae77b414b5', form: 'app', source: 'ipc' };
  const pet = {
    events: {
      on: (name, fn) => toolHandlers.set(name, fn),
      emit: (name, data) => panelHandlers.get(name)?.(data),
    },
    storage: { get: async () => { if (releaseStartup) await releaseStartup; return false; } },
    scheduler: { every: async (_ms, fn) => { scheduled = fn; return 'test-timer'; }, cancel: async () => {} },
    pet: { bubble() {}, playAnim() {} }, badge: { set: async () => true, clear: async () => {} },
  };
  const collector = createCollector({
    threadState: { read: () => new Map() },
    dir, locale: 'zh-CN', settingsFile: path.join(dir, 'settings.json'), codexHooksFile: path.join(dir, 'hooks.json'),
    readSnapshots: () => { if (failReads) throw new Error('fixture read unavailable'); return stateFiles.readSnapshots(dir); },
    isPidAlive: () => true, psTree: [],
    rolloutActivity: { activeThreads: () => new Map() }, workbuddySource: { tick() {} },
    threadTitles: { lookup: () => null }, terminalTitles: { lookup: () => null },
    claudeDesktop: { has: () => false, lookupTitle: () => null },
    createAppLauncher: () => ({ detect: () => [{ id: 'codex', name: 'Codex', pendingDone: 1 }], open() {} }),
  });
  function mount() {
    dom?.window.close();
    panelHandlers = new Map();
    dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(win) {
      Object.defineProperty(win.navigator, 'language', { value: 'zh-CN' });
      win.pet = { ui: { setPanelPinned() {} }, events: {
        on: (name, fn) => panelHandlers.set(name, fn),
        emit: (name, data) => toolHandlers.get(name)?.(data),
      } };
    } });
    return dom.window.document;
  }
  try {
    stateFiles.writeStatus(record, dir);
    await collector.start(pet); // 第一轮发生时，没有任何 panel 订阅。
    failReads = true; // 打开时扫描会失败；只能回放常驻采集器已经拿到的结果。
    for (let i = 0; i < 3; i++) {
      const doc = mount();
      assert.equal(doc.querySelectorAll('.row').length, 1, '每次开窗应立即展示已有会话');
      assert.equal(doc.querySelector('.row').dataset.sessionId, record.sessionId);
      assert.equal(doc.getElementById('empty').hidden, true, '有会话时不能闪接入引导');
      assert(doc.querySelector('[data-app-id="codex"]'), '启动器也应立即回放');
    }
    failReads = false;
    stateFiles.writeStatus({ ...record, state: 'done', lastEvent: 'ipc:read-state', ts: Date.now() + 1 }, dir);
    scheduled(); // 系统定时触发的等价物，证明回放后仍能继续更新。
    assert(dom.window.document.querySelector('.row.state-done'), '后续快照仍更新当前面板');
    assert(mount().querySelector('.row.state-done'), '再次开窗回放的是更新后的结果');

    fs.unlinkSync(path.join(dir, record.sessionId + '.json'));
    scheduled();
    assert.equal(mount().getElementById('empty').hidden, false, '真实无会话时立即显示空态');
    await collector.stop(pet);

    // 冷启动时先挂 panel：不能把未采集过的默认空数组误报为真实空态。
    let unblock;
    releaseStartup = new Promise(resolve => { unblock = resolve; });
    const cold = createCollector({
    threadState: { read: () => new Map() },
      dir, locale: 'zh-CN', psTree: [], settingsFile: path.join(dir, 'settings.json'), codexHooksFile: path.join(dir, 'hooks.json'),
      rolloutActivity: { activeThreads: () => new Map() }, workbuddySource: { tick() {} },
      threadTitles: { lookup: () => null }, terminalTitles: { lookup: () => null },
      claudeDesktop: { has: () => false, lookupTitle: () => null },
      createAppLauncher: () => ({ detect: () => [], open() {} }),
    });
    const starting = cold.start(pet);
    assert.equal(mount().getElementById('empty').hidden, true, '冷启动不回放虚假的空态');
    unblock(); await starting;
    assert.equal(dom.window.document.getElementById('empty').hidden, false, '首轮采集完成后再显示真实空态');
    await cold.stop(pet);
    console.log('panel-bootstrap-test: PASS (reopen, latest state, apps, empty, cold start)');
  } finally {
    dom?.window.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
