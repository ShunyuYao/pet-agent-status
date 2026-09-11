'use strict';
// 线程 rollout 文件的活动探测（PROTOCOL.md「rollout 活动信号」的唯一实现处）。
//
// 依据 fixtures/codex-ipc-facts.md §10：任务运行期间线程 rollout 文件每隔约 2–12s 持续
// 追加，文件名自带 threadId——这是被动侧唯一可靠的「正在跑」信号（提交时刻的
// queued-followups 广播实测不发，§10.1 反证）。
//
// 三条纪律：
//   ① 只读 stat，绝不读文件内容（会话正文红线）；
//   ② 内部存储无稳定性承诺——任何一步失败静默返回空结果，绝不抛出去打死采集轮；
//   ③ 只扫今天与昨天两个日期目录（覆盖跨午夜边界），不递归全库——sessions 会积累
//      数月的文件，全扫的 stat 开销会跟着历史线性涨。

const fs = require('fs');
const os = require('os');
const path = require('path');

// mtime 距今在此窗口内算「活动中」。实测追加间隔最长 ~12s，30s 留出一倍余量；
// 采集 tick 是 2s，窗口再小也不至于漏采，但太小会在追加间隙里闪断。
const ACTIVE_WINDOW_MS = 30 * 1000;

// rollout 文件名尾部的 threadId（UUID）。与 codex-deeplink 的 UUID 白名单同精神：
// 形态不合就当没看见，绝不把脏字符串当 id 用。
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// 某毫秒时刻所在天的日期目录段（本地时区，与 Codex 落盘规则一致：YYYY/MM/DD 补零）
function dayDir(base, ms) {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(base, String(d.getFullYear()), mm, dd);
}

/**
 * @param {object} [deps] { codexHome, now, fsMod } 全可注入，测试不碰真实 ~/.codex
 */
function createRolloutActivity(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const fsMod = d.fsMod || fs;
  const home = d.codexHome || defaultCodexHome();
  const windowMs = Number.isFinite(d.windowMs) ? d.windowMs : ACTIVE_WINDOW_MS;

  /**
   * 当前「活动中」的线程集合。
   * @returns {Map<string, number>} threadId（小写）→ 该 rollout 文件 mtime（毫秒）
   */
  function activeThreads() {
    const at = now();
    const out = new Map();
    const base = path.join(home, 'sessions');
    // 今天 + 昨天：任务可能在午夜前开的（rollout 落昨天的目录）午夜后还在追加
    for (const dir of [dayDir(base, at), dayDir(base, at - 24 * 60 * 60 * 1000)]) {
      let names = [];
      try { names = fsMod.readdirSync(dir); } catch (_) { continue; }   // 目录不存在=今天还没会话
      for (const name of names) {
        const m = ROLLOUT_RE.exec(name);
        if (!m) continue;
        let st = null;
        try { st = fsMod.statSync(path.join(dir, name)); } catch (_) { continue; }
        const mtime = st && st.mtimeMs;
        if (!Number.isFinite(mtime) || at - mtime > windowMs) continue;
        const id = m[1].toLowerCase();
        // 同一线程理论上只有一份 rollout；真出现多份取最新的那个 mtime
        if (!out.has(id) || out.get(id) < mtime) out.set(id, mtime);
      }
    }
    return out;
  }

  return { activeThreads };
}

module.exports = { createRolloutActivity, ACTIVE_WINDOW_MS, ROLLOUT_RE };
