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

const TICK_MS = 2000;                            // 宿主把最小间隔钳到 1000ms，2s 满足「3 秒内可感知」
const SNAPSHOT_EVENT = 'agent-status:snapshot';  // 事件名带前缀防撞（AGENTS.md 惯例）

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
  const t = typeof d.t === 'function' ? d.t : createNodeI18n(d.locale).t;
  const link = createPetLink({ playAnimGuard: d.playAnimGuard });

  let taskId = null;
  let lastSnapshot = { rows: [], summary: { running: 0, waiting: 0, total: 0, unknown: 0 } };

  // 一轮采集。整体包 try/catch：抛出去会打死宿主定时任务，下一轮就没了。
  function tick(pet) {
    try {
      const at = now();
      const raw = readSnapshots(d.dir);
      const result = aggregate(raw, { now: at, isPidAlive: alive, t });
      lastSnapshot = result;
      emit(pet, SNAPSHOT_EVENT, result);
      link.onSnapshot(result.rows, pet, { now: at, t });
      return result;
    } catch (_) {
      return lastSnapshot;   // 本轮读坏了就沿用上轮，面板不闪空
    }
  }

  async function start(pet) {
    if (taskId != null) return taskId;   // 启停串行，不重复注册（重复注册 = 泄漏定时器）
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
    get taskId() { return taskId; },
    get lastSnapshot() { return lastSnapshot; }
  };
}

function emit(pet, name, data) {
  try {
    if (pet && pet.events && typeof pet.events.emit === 'function') pet.events.emit(name, data);
  } catch (_) { /* 面板没开着，推送失败无所谓 */ }
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
  isPidAlive, TICK_MS, SNAPSHOT_EVENT
};
