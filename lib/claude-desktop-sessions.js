'use strict';
// Claude Desktop App（Claude.app）会话适配器：标题反查 + tty:null 跳转兜底。
//
// 事实依据（2026-09-11 本机实测，详见 fixtures/claude-desktop-facts.md）：
// App 里的本地 Claude Code 会话跑的就是 CLI，hooks 正常触发（状态采集零改动），
// 但 tty 是 null（没有终端），且转录不进 ~/.claude/projects。App 自己在
//   ~/Library/Application Support/Claude/claude-code-sessions/<acct>/<org>/local_*.json
// 给每个会话落一份元数据，含 **AI 生成的标题**（`title`，与 CLI「标题不落盘」相反）和
// `cliSessionId`（正对上 hooks 收到的 session id）。本模块只消费这两样：
//   ① cliSessionId → title（面板行主标签，优先级见 tool 注入处）；
//   ② 「这个 sessionId 是 App 会话」的归属判定 → tty:null 行的跳转兜底
//      （无深链接可跳既有会话——facts §4，只能 `open -b` 激活 App，不假装精确）。
//
// 与 codex-thread-titles 同一套纪律：这些都是**内部存储、无公开稳定性承诺**，
// 全部失败路径静默降级为「查不到」（无标题、无入口），绝不因此打死采集。
// 只读纪律：绝不创建/修改 App 目录下任何文件；测试一律注入 appSupportDir 指向临时目录。
//
// ⚠️ 已知缺口（facts §2 实录）：部分元数据没有 cliSessionId 字段（如带
// transcriptUnavailable 的旧会话）——这类会话映射不出来，诚实降级，
// 绝不按 cwd 之类的模糊线索乱配（配错标题比没标题更糟）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 1000;   // 标题/归属不是实时数据，30s 一扫足够（同 codex-thread-titles）
const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop';

// PET_AS_CLAUDE_APP_SUPPORT 是本仓的测试隔离覆盖（同 PET_AS_CLAUDE_SETTINGS 精神），优先级最高
function defaultAppSupportDir() {
  return process.env.PET_AS_CLAUDE_APP_SUPPORT
    || path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
}

/**
 * @param {object} [deps] { appSupportDir, now, ttlMs }（测试全量注入，绝不碰真实 App 目录）
 */
function createClaudeDesktopSessions(deps) {
  const d = deps || {};
  const root = d.appSupportDir || defaultAppSupportDir();
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const ttl = Number.isFinite(d.ttlMs) ? d.ttlMs : DEFAULT_TTL_MS;
  const sessionsDir = path.join(root, 'claude-code-sessions');

  let cache = new Map();     // cliSessionId → { title, lastActivityAt }
  let cachedAt = -Infinity;

  // 全量扫 claude-code-sessions/<acct>/<org>/local_*.json（实测每层就几个条目，全量比增量可靠）
  function scan() {
    const out = new Map();
    let accts = [];
    try { accts = fs.readdirSync(sessionsDir); } catch (_) { return out; }
    for (const acct of accts) {
      const acctDir = path.join(sessionsDir, acct);
      let orgs = [];
      try { orgs = fs.readdirSync(acctDir); } catch (_) { continue; }
      for (const org of orgs) {
        const orgDir = path.join(acctDir, org);
        let files = [];
        try { files = fs.readdirSync(orgDir); } catch (_) { continue; }
        for (const f of files) {
          if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
          let meta = null;
          try { meta = JSON.parse(fs.readFileSync(path.join(orgDir, f), 'utf8')); } catch (_) { continue; }
          if (!meta || typeof meta.cliSessionId !== 'string' || meta.cliSessionId === '') continue;
          if (typeof meta.title !== 'string' || meta.title === '') continue;
          const at = Number.isFinite(meta.lastActivityAt) ? meta.lastActivityAt : 0;
          const prev = out.get(meta.cliSessionId);
          // 同一 cliSessionId 多份（App 重写元数据）：取 lastActivityAt 较新的一份
          if (!prev || at >= prev.lastActivityAt) out.set(meta.cliSessionId, { title: meta.title, lastActivityAt: at });
        }
      }
    }
    return out;
  }

  function ensureFresh() {
    const at = now();
    if (at - cachedAt < ttl) return;
    try { cache = scan(); } catch (_) { /* 本轮失败沿用旧缓存，TTL 后再试 */ }
    cachedAt = at;
  }

  /** cliSessionId（= hooks 收到的 session id）→ AI 标题；查不到返回 null（绝不造假标题） */
  function lookupTitle(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    ensureFresh();
    const hit = cache.get(sessionId);
    return hit ? hit.title : null;
  }

  /** 这个 sessionId 是不是 App 会话（能否证明归属）。跳转兜底的判据。 */
  function has(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    ensureFresh();
    return cache.has(sessionId);
  }

  return { lookupTitle, has, get size() { ensureFresh(); return cache.size; } };
}

/**
 * 行 → 是否给「激活 Claude App」兜底入口。**判定只此一处**（对齐 codex-deeplink#pickNavigator）。
 * 三个条件缺一不可：claude-code / 没有 tty（有终端走既有 tty 聚焦链路）/ 归属证明成立
 * （App 元数据里有这个 cliSessionId）——证明不了就 null，面板不渲染可点态（无假入口）。
 * @param {object} row 快照行
 * @param {(sessionId:string)=>boolean} has 归属判定（tool 注入 createClaudeDesktopSessions().has）
 * @returns {{kind:'claude-app'} | null}
 */
function pickAppNavigator(row, has) {
  if (!row || row.agent !== 'claude-code' || row.tty) return null;
  let owned = false;
  try { owned = typeof has === 'function' && !!has(row.sessionId); } catch (_) { owned = false; }
  return owned ? { kind: 'claude-app' } : null;
}

/**
 * 激活 Claude App。没有会话寻址的深链接（facts §4：claude://code/new 只能新建），
 * 所以这档是诚实的兜底：只把 App 提到前台，不假装能定位到具体会话。
 * 按 bundle id 而不是 App 名激活——用户装了别的叫 "Claude" 的东西也不会误中。
 * @param {(cmd:string, args:string[])=>void} [execFileImpl] 注入，测试不真跑 open
 * @returns {{ok:true} | {ok:false, reason:'failed'}}
 */
function activateClaudeApp(execFileImpl) {
  const exec = execFileImpl || defaultExec;
  try {
    exec('open', ['-b', CLAUDE_BUNDLE_ID]);
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: 'failed' };
  }
}

function defaultExec(cmd, args) {
  const { execFileSync } = require('child_process');
  return execFileSync(cmd, args, { timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] });
}

module.exports = {
  createClaudeDesktopSessions, pickAppNavigator, activateClaudeApp,
  CLAUDE_BUNDLE_ID, DEFAULT_TTL_MS
};
