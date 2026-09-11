'use strict';
// 找一个**真正的 node** 解释器，供写进 agent 的 hooks 配置。
//
// 为什么不能用 `process.execPath`（2026-09-11 真机根因）：插件的 tool 跑在宿主的
// utilityProcess 里，execPath 指向 `.../Electron Helper.app/.../MacOS/Electron`。
// 它不是 node，也不能当 node 用；宿主升级后那个路径还会整个消失。
// 写进 settings.json 的直接后果是 **所有 hook 静默失败**——Claude Code 不报错，
// 用户只看到状态永不更新（实测线上 19 个状态文件里一条 done 都没有，面板从不出现绿色）。
//
// 全部依赖注入，测试不碰真实文件系统、不 spawn。

const DEFAULT_FALLBACKS = Object.freeze([
  '/opt/homebrew/bin/node',        // Apple Silicon homebrew
  '/usr/local/bin/node',           // Intel homebrew / 官方 pkg
  '/usr/bin/node',
]);

function isNodeExecPath(p) {
  return typeof p === 'string' && /(^|\/)node$/.test(p);
}

/**
 * @param {object} deps
 *   env          环境变量对象（默认 process.env）
 *   execPath     当前解释器（默认 process.execPath）
 *   fileExists   (p)=>boolean
 *   whichNode    ()=>string|null   PATH 里查 node
 *   fallbacks    兜底候选路径数组
 * @returns {string} node 可执行文件绝对路径
 * @throws 找不到时抛 —— 安装必须**显式失败**，写一条注定跑不起来的 hook 比装不上更糟
 */
function resolveNodeBin(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const execPath = d.execPath !== undefined ? d.execPath : process.execPath;
  const fileExists = d.fileExists || ((p) => { try { return require('fs').existsSync(p); } catch (_) { return false; } });
  const whichNode = d.whichNode || defaultWhichNode;
  const fallbacks = d.fallbacks || DEFAULT_FALLBACKS;

  // 1) 显式指定优先（用户自定义 / 测试注入）
  const explicit = env.PET_AS_NODE_BIN;
  if (explicit && fileExists(explicit)) return explicit;

  // 2) 自己就是 node（插件在纯 Node 下跑时成立；Electron 的 basename 不是 node，天然排除）
  if (isNodeExecPath(execPath) && fileExists(execPath)) return execPath;

  // 3) PATH 里的 node（绝大多数真机走这条）。
  // 包 try：注入实现或 which 本身抛异常时，必须继续往兜底走，不能把整个安装带崩。
  let fromPath = null;
  try { fromPath = whichNode(); } catch (_) { fromPath = null; }
  if (fromPath && fileExists(fromPath)) return fromPath;

  // 4) 常见安装位置（GUI 应用继承的 PATH 常缺 nvm/homebrew，故必须有这一档）
  for (const cand of fallbacks) if (fileExists(cand)) return cand;

  // 英文常量：仓库红线要求中文只许在 locales/*.json。这条是抛给开发者/日志的，不上屏。
  throw new Error('no usable node interpreter found; install Node or set PET_AS_NODE_BIN');
}

function defaultWhichNode() {
  try {
    const { execFileSync } = require('child_process');
    const out = String(execFileSync('/usr/bin/which', ['node'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
    return out || null;
  } catch (_) { return null; }
}

module.exports = { resolveNodeBin, isNodeExecPath, DEFAULT_FALLBACKS };
