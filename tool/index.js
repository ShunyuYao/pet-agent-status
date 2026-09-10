'use strict';
// tool 入口：宿主 utilityProcess 里跑，activate(pet) 收到 SDK 对象。
// 职责只有三件：定时读状态目录 → aggregate 推导 → 经 events 推给 panel，顺带触发宠物联动。
//
// 合规通道：manifest 声明的 pet.{scheduler,events,pet} + 状态目录读写（README 权限披露）。

const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const stateFiles = require(path.join(LIB, 'state-files.js'));
const { aggregate } = require(path.join(LIB, 'aggregate.js'));
const { createPetLink } = require(path.join(LIB, 'pet-link.js'));
const { createNodeI18n } = require(path.join(LIB, 'i18n.js'));
const installer = require(path.join(LIB, 'claude-hooks-installer.js'));

const TICK_MS = 2000;                            // 宿主把最小间隔钳到 1000ms，2s 满足「3 秒内可感知」
// 事件名带前缀防撞（AGENTS.md 惯例）。这一组与 panel/panel.html 里的常量是**两份副本**，
// 改一处必须改两处；tests/panel-dom-test.js 与 tool-lifecycle-test.js 各自断言了名字，
// 漂移会在门禁里红。
const SNAPSHOT_EVENT = 'agent-status:snapshot';
const INSTALL_STATE_EVENT = 'agent-status:install-state';   // tool → panel：接入与否
const INSTALL_CLAUDE_EVENT = 'agent-status:install-claude';   // panel → tool：接入意图
const UNINSTALL_CLAUDE_EVENT = 'agent-status:uninstall-claude'; // panel → tool：移除意图

// 进程存活探测：kill(pid, 0) 不发信号只查存在性。EPERM = 存在但不属于本用户，算存活。
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

/**
 * 造一个采集器。所有外部依赖可注入，测试不碰真实目录/时钟/进程。
 * @param {object} [deps] { dir, now, isPidAlive, t, playAnimGuard, readSnapshots }
 */
function createCollector(deps) {
  const d = deps || {};
  const readSnapshots = typeof d.readSnapshots === 'function' ? d.readSnapshots : stateFiles.readSnapshots;
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const alive = typeof d.isPidAlive === 'function' ? d.isPidAlive : isPidAlive;
  // 语言只认这一处。副行/时间文案由 tool 取词后随行下发，panel 的静态文案则按
  // 快照里带的 locale 取 —— 两边各猜各的会当场撞车：tool 看 LANG、panel 看
  // navigator.language，两者不一致时同一块面板上半截中文下半截英文。
  const i18n = createNodeI18n(d.locale);
  const t = typeof d.t === 'function' ? d.t : i18n.t;
  const locale = d.locale || i18n.locale;
  const link = createPetLink({ playAnimGuard: d.playAnimGuard });
  // 缺省 undefined → installer 自己走 settingsPath()（即 PET_AS_CLAUDE_SETTINGS 覆盖）；
  // 测试注入临时文件，绝不碰真实 ~/.claude/settings.json
  const installOpts = d.settingsFile ? { settingsFile: d.settingsFile } : undefined;

  let taskId = null;
  let lastSnapshot = { rows: [], summary: { running: 0, waiting: 0, total: 0, unknown: 0 } };

  // 一轮采集。整体包 try/catch：抛出去会打死宿主定时任务，下一轮就没了。
  function tick(pet) {
    try {
      const at = now();
      const raw = readSnapshots(d.dir);
      const result = aggregate(raw, { now: at, isPidAlive: alive, t });
      // locale 随快照下发，panel 据此选词表（契约仍是 {rows, summary}，locale 是附加字段）
      result.locale = locale;
      lastSnapshot = result;
      emit(pet, SNAPSHOT_EVENT, result);
      // 接入态随每轮一起推：面板是随开随关的，start 时推一次的话，
      // 之后才打开的面板永远等不到这条，空态会一直停在「一键接入」——
      // 哪怕钩子早就装好了。读一个小 JSON，2s 一次的开销可以忽略。
      pushInstallState(pet);
      link.onSnapshot(result.rows, pet, { now: at, t });
      return result;
    } catch (_) {
      return lastSnapshot;   // 本轮读坏了就沿用上轮，面板不闪空
    }
  }

  // panel 的接入按钮只发意图，改配置的活在这边（panel 上下文没有 fs，也不该有）。
  // 每次改完立刻回推一次接入态，面板的「一键接入 / 已接入 ✓」当场翻面。
  function pushInstallState(pet) {
    let claude = false;
    try { claude = installer.isInstalled(installOpts); } catch (_) { claude = false; }
    emit(pet, INSTALL_STATE_EVENT, { claude });
    return claude;
  }

  function handleInstall(pet) {
    // 改用户 settings.json 失败不该打死采集器：面板照旧显示「未接入」，用户可再试。
    try { installer.install(installOpts); } catch (_) { /* 权限/磁盘问题 */ }
    return pushInstallState(pet);
  }

  function handleUninstall(pet) {
    try { installer.uninstall(installOpts); } catch (_) { /* 同上 */ }
    return pushInstallState(pet);
  }

  async function start(pet) {
    if (taskId != null) return taskId;   // 启停串行，不重复注册（重复注册 = 泄漏定时器）
    // 先接意图再起定时器：面板可能在 tick 之前就点了接入
    subscribe(pet, INSTALL_CLAUDE_EVENT, () => handleInstall(pet));
    subscribe(pet, UNINSTALL_CLAUDE_EVENT, () => handleUninstall(pet));
    // 必须 await：pet.scheduler.every 返回的是 Promise<taskId>，
    // 直接存 Promise 会让 cancel 拿到个对象、恒 miss，旧定时器永不回收（宿主已知坑）。
    taskId = await pet.scheduler.every(TICK_MS, () => tick(pet));
    tick(pet);   // 立刻来一轮，用户开面板不用等 2 秒
    return taskId;
  }

  async function stop(pet) {
    if (taskId == null) return;
    const id = taskId;
    taskId = null;   // 先清再 cancel：cancel 失败也不该留个假 id 挡住下次 start
    try { await pet.scheduler.cancel(id); } catch (_) { /* 宿主已经收走了 */ }
  }

  return {
    start, stop, tick,
    handleInstall, handleUninstall, pushInstallState,
    get taskId() { return taskId; },
    get lastSnapshot() { return lastSnapshot; }
  };
}

function emit(pet, name, data) {
  try {
    if (pet && pet.events && typeof pet.events.emit === 'function') pet.events.emit(name, data);
  } catch (_) { /* 面板没开着，推送失败无所谓 */ }
}

// 订阅 panel 发来的意图。回调整体包 try/catch：panel 送来什么都不该打死 tool。
function subscribe(pet, name, fn) {
  try {
    if (pet && pet.events && typeof pet.events.on === 'function') {
      pet.events.on(name, (data) => { try { fn(data); } catch (_) { /* 单次意图失败 */ } });
    }
  } catch (_) { /* 宿主没给 events 面 */ }
}

let collector = null;
let activeSdk = null;

async function activate(pet) {
  activeSdk = pet;
  collector = createCollector();
  await collector.start(pet);
  return collector;
}

// 宿主当前是 kill 子进程 + 自动取消定时器（runtime.js#deactivateRec），没有调 deactivate 的路径；
// 这里仍显式实现，既是 criteria 要求，也为宿主将来接上这个钩子留好口子。
// pet 省略时用 activate 时存下的那个 —— 宿主多半不会再传一遍。
async function deactivate(pet) {
  if (!collector) return;
  await collector.stop(pet || activeSdk);
  collector = null;
  activeSdk = null;
}

module.exports = {
  activate, deactivate, createCollector,
  isPidAlive, TICK_MS,
  SNAPSHOT_EVENT, INSTALL_STATE_EVENT, INSTALL_CLAUDE_EVENT, UNINSTALL_CLAUDE_EVENT
};
