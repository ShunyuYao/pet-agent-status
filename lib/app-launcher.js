'use strict';
// App 启动器：检测本机装了哪些我们支持的桌面 App，并拉起/切前台。
// 设计稿与决策：docs/design-launcher-proposal.md（Figma UJimpWGl2hGkrbzxIVCAK5 第 ⑤ 区）。
//
// 权限：复用既有 nodeAccess 的 `child_process` spawn `open`（README 权限披露第 3 行
// 已声明「`open -b` 把 Claude App 提到前台」），**不需要新增任何 SDK 面**。
//
// 四条硬判据，都对着具体教训：
//   ① **按 bundleId 认，不按 /Applications/<Name>.app 路径认**。实测本机没有独立的
//      Codex.app —— `com.openai.codex` 解析到 /Applications/ChatGPT.app（lsregister 里
//      codex: scheme 也确由它注册）。按路径找会永远判「Codex 没装」，而且只在
//      「装了 Codex 但没装 Claude/WorkBuddy」的机器上暴露，本机测不出来。
//   ② **没装的整条不出现**，不给 installed:false 的灰项 —— UI 侧没有灰态设计
//      （点不动的入口＝死链）。一个都没装时返回空数组，UI 整条 footer 不渲染。
//   ③ **顺序固定**，不按「有没有会话在跑」动态排。动态排序会让图标位置跳来跳去，
//      肌肉记忆失效；「哪个在跑」由右上角绿点表达，不靠位置表达。
//   ④ **探测失败一律当没装，静默降级**。mdfind 可能被关（Spotlight 索引禁用）、
//      可能超时；这只是个便捷入口，绝不能因此打死每 2s 一轮的采集器。

const path = require('path');

// 登记表：id 是内部键与 UI 图标名，bundleId 是唯一寻址依据（见判据①）。
// 新增 App 只动这张表 —— 探测、排序、open 全部由它驱动。
// **顺序即 UI 顺序**（判据③）。
const SUPPORTED_APPS = [
  { id: 'claude', bundleId: 'com.anthropic.claudefordesktop', name: 'Claude' },
  // ⚠️ 不是 Codex.app。实测 com.openai.codex 解析到 /Applications/ChatGPT.app。
  { id: 'codex', bundleId: 'com.openai.codex', name: 'Codex' },
  { id: 'workbuddy', bundleId: 'com.workbuddy.workbuddy', name: 'WorkBuddy' }
];

// 协议 agent 字段 → 启动器 id。协议里 Claude 叫 'claude-code'，这里叫 'claude'
// （UI 上它代表的是 Claude 这个厂牌 / 那个 App），两套命名刻意不强行统一。
const AGENT_TO_APP = {
  'claude-code': 'claude',
  codex: 'codex',
  workbuddy: 'workbuddy'
};

// 「在跑」的状态集合：running 与 waiting 都算 —— waiting 是「在等你批准」，
// 用户正需要切过去处理它，比 running 更该标出来。done/ended/idle 不算。
const ACTIVE_STATES = ['running', 'waiting'];

// 探测结果缓存窗。tool 每 2s 一轮 tick，每轮 spawn 三次 mdfind 是纯浪费；
// 5min 足够覆盖「用户中途装了个 App」的场景（他还得回来点面板才看得到）。
const CACHE_MS = 5 * 60 * 1000;

/**
 * 把快照行折成 {claude,codex,workbuddy} 的「在跑」映射。
 * 数据取自现成 snapshot，**零新增采集**。
 */
function runningFromRows(rows) {
  const out = { claude: false, codex: false, workbuddy: false };
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r) continue;
    const appId = AGENT_TO_APP[r.agent];
    if (!appId) continue;
    if (ACTIVE_STATES.indexOf(r.state) === -1) continue;
    out[appId] = true;
  }
  return out;
}

// 默认探测器：mdfind 按 bundleId 查。惰性 require，测试注入 probe 时根本不会走到这里。
function defaultProbe(bundleId) {
  const { execFileSync } = require('child_process');
  // 只传常量化的查询串，bundleId 来自本文件的登记表（非用户输入），无注入面。
  const out = execFileSync(
    'mdfind',
    [`kMDItemCFBundleIdentifier == '${bundleId}'`],
    { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const first = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

function defaultExecFile(cmd, args) {
  const { execFileSync } = require('child_process');
  return execFileSync(cmd, args, { timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * @param {object} [deps] { probe, execFile, now } 全可注入；测试绝不碰真实 /Applications。
 */
function createAppLauncher(deps) {
  const d = deps || {};
  const probe = d.probe || defaultProbe;
  const execFile = d.execFile || defaultExecFile;
  const now = d.now || Date.now;

  let cache = null;      // { at:number, map:{ [id]: string|null } }

  // 探一轮：每个登记的 App 问一次「装了没」。任一失败按没装（判据④）。
  function probeAll() {
    const map = {};
    for (const app of SUPPORTED_APPS) {
      let hit = null;
      try { hit = probe(app.bundleId) || null; } catch (_) { hit = null; }
      map[app.id] = hit;
    }
    return map;
  }

  function installedMap() {
    const at = now();
    if (cache && (at - cache.at) < CACHE_MS) return cache.map;
    const map = probeAll();
    cache = { at, map };
    return map;
  }

  /**
   * 本机装了的 App 列表，**顺序固定**（判据③）、**没装的不出现**（判据②）。
   * @param {object} [opts] { running: {claude?:bool, codex?:bool, workbuddy?:bool} }
   * @returns {Array<{id,bundleId,name,path,running}>} 一个都没装时是空数组
   */
  function detect(opts) {
    const running = (opts && opts.running) || {};
    const map = installedMap();
    const out = [];
    for (const app of SUPPORTED_APPS) {     // 遍历顺序即 UI 顺序
      const p = map[app.id];
      if (!p) continue;                     // 没装：整条不出现
      out.push({
        id: app.id,
        bundleId: app.bundleId,
        name: app.name,
        path: p,
        running: running[app.id] === true   // 恒为布尔，不留 undefined
      });
    }
    return out;
  }

  /**
   * 打开 App：未运行→拉起，已运行→切前台。macOS 的 `open -b` 两种情形是同一条命令
   * （已运行时天然是 activate 语义），所以这里**不按 running 分支**。
   * @returns {{ok:true} | {ok:false, reason:'unknown-app'|'not-installed'|'failed'}}
   */
  function open(appId) {
    // 只认登记表里的 id，任意字符串一律拒 —— bundleId 绝不来自调用方（安全边界）。
    const app = SUPPORTED_APPS.find((a) => a.id === appId);
    if (!app) return { ok: false, reason: 'unknown-app' };
    // 没装就别拉：`open -b` 对未注册 bundleId 会报错，提前拒更干净
    if (!installedMap()[app.id]) return { ok: false, reason: 'not-installed' };
    try {
      execFile('open', ['-b', app.bundleId]);
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: 'failed' };
    }
  }

  // 用户中途装/删了 App 时，面板可主动要求重新探测
  function invalidate() { cache = null; }

  return { detect, open, invalidate };
}

module.exports = {
  createAppLauncher,
  runningFromRows,
  SUPPORTED_APPS,
  AGENT_TO_APP,
  ACTIVE_STATES,
  CACHE_MS
};
