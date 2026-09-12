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
//   ③ 近期目录发现 + 已知 App 线程的已校验路径；不递归历史全库。

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
  const tracked = new Map();
  function activeThreads(metadata = new Map()) {
    const at = now();
    const out = new Map();
    const base = path.join(home, 'sessions');
    // Only remember currently known App threads. Paths are checked against the real
    // sessions root each time so a replaced symlink cannot escape between polls.
    for (const id of tracked.keys()) if (!metadata.has(id)) tracked.delete(id);
    for (const [id, info] of metadata) {
      if (info && typeof info.rolloutPath === 'string') tracked.set(id, info.rolloutPath);
    }
    function inspect(file, expectedId) {
      try {
        const realBase = fsMod.realpathSync(base);
        const realFile = fsMod.realpathSync(file);
        const relative = path.relative(realBase, realFile);
        if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return;
        const match = ROLLOUT_RE.exec(path.basename(realFile));
        if (!match || (expectedId && match[1].toLowerCase() !== expectedId.toLowerCase())) return;
        const st = fsMod.statSync(realFile);
        if (!st.isFile() || !Number.isFinite(st.mtimeMs) || at - st.mtimeMs > windowMs || st.mtimeMs > at + 1000) return;
        const id = match[1].toLowerCase();
        if (!out.has(id) || out.get(id) < st.mtimeMs) out.set(id, st.mtimeMs);
        if (metadata.has(id)) tracked.set(id, realFile);
      } catch (_) { /* deleted files, denied paths and missing roots are not activity */ }
    }
    for (const [id, file] of tracked) inspect(file, id);
    // Recent directories discover new files; old App files use the indexed paths above.
    for (const dir of [dayDir(base, at), dayDir(base, at - 24 * 60 * 60 * 1000)]) {
      let names = [];
      try { names = fsMod.readdirSync(dir); } catch (_) { continue; }   // 目录不存在=今天还没会话
      for (const name of names) {
        const m = ROLLOUT_RE.exec(name);
        if (!m) continue;
        inspect(path.join(dir, name), m[1]);
      }
    }
    return out;
  }

  return { activeThreads };
}

module.exports = { createRolloutActivity, ACTIVE_WINDOW_MS, ROLLOUT_RE };
