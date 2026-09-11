'use strict';
// Codex App 任务的导航适配器：`codex://threads/<thread-id>`。
//
// 独立成一个适配器（而不是散在跳转逻辑里）的理由写在 fixtures/codex-ipc-facts.md §7：
// 深链接是**内部路由**，OpenAI 没有公开稳定性承诺。将来路径变了只换这一个文件，
// 不波及面板与 CLI 跳转链路。
//
// 与 CLI 跳转（lib/terminal-jump.js 按 tty 聚焦终端）是**两条并列的路**，不是同一条的分支：
// App 任务根本没有 tty，CLI 会话也没有 threadId。选哪条由行数据自己决定，见 pickNavigator。

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 只接受 UUID 形态的 threadId —— 绝不把任意字符串拼进 URL 再交给 `open`
 * （那等于把 shell/URL 注入面开给状态文件的写入方）。
 */
function isValidThreadId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** @returns {string|null} 合法则给出深链接，否则 null（上层据此不显示入口） */
function buildDeepLink(threadId) {
  return isValidThreadId(threadId) ? `codex://threads/${threadId}` : null;
}

/**
 * 行 → 导航方式。两条路并列，判定只此一处（对齐 terminal-jump 的「判定唯一实现」精神）。
 * @returns {{kind:'deeplink', url:string} | {kind:'tty'} | null}
 */
function pickNavigator(row) {
  if (!row) return null;
  // App 任务（form:'app'）：有 threadId 且没有 tty —— 只能走深链接。
  // ⚠️ 必须认 form，不能只认「codex + threadId + 无 tty」：Codex **CLI** 会话也带 threadId，
  // 管道里跑到 tty=null 时若给深链接，会把用户跳进 App 里一个不存在的任务页
  // （v0.5.0 CI 真实抓到过：codex-hook-test 端到端在无 tty 环境判可点，本地有 tty 测不出）。
  if (row.agent === 'codex' && row.form === 'app' && !row.tty && isValidThreadId(row.threadId)) {
    return { kind: 'deeplink', url: buildDeepLink(row.threadId) };
  }
  // WorkBuddy 会话（PROTOCOL.md「WorkBuddy 来源」）：`workbuddy://chat/<sessionId>` 是
  // asar 实录路由（fixtures/workbuddy-facts.md）。同样只接受 UUID 形态，脏 id 不拼 URL。
  if (row.agent === 'workbuddy' && !row.tty && isValidThreadId(row.sessionId)) {
    return { kind: 'deeplink', url: `workbuddy://chat/${row.sessionId}` };
  }
  // 其余（含所有 CLI 会话）走既有的 tty 聚焦链路
  if (row.tty) return { kind: 'tty' };
  return null;
}

/**
 * 打开深链接。`open` 退出码只代表「系统受理了这个 URL」，
 * **不代表页面真的呈现**（facts §6）——所以成功分支的文案是「正在打开」而非「已打开」。
 * @param {string} url
 * @param {(cmd:string, args:string[])=>void} execFileImpl 注入，测试不真跑 open
 * @returns {{ok:true} | {ok:false, reason:'invalid'|'no-scheme'|'failed'}}
 */
function openDeepLink(url, execFileImpl) {
  // 白名单前缀：只放行这两条实录路由，绝不把任意 URL 交给 `open`
  const allowed = typeof url === 'string'
    && (url.startsWith('codex://threads/') || url.startsWith('workbuddy://chat/'));
  if (!allowed) return { ok: false, reason: 'invalid' };
  const exec = execFileImpl || defaultExec;
  try {
    exec('open', [url]);
    return { ok: true };
  } catch (e) {
    // Scheme 没注册（没装 Codex App）时 `open` 报 kLSApplicationNotFoundErr
    const msg = String((e && e.message) || '');
    if (/not found|no application|kLSApplicationNotFound/i.test(msg)) return { ok: false, reason: 'no-scheme' };
    return { ok: false, reason: 'failed' };
  }
}

function defaultExec(cmd, args) {
  const { execFileSync } = require('child_process');
  return execFileSync(cmd, args, { timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] });
}

module.exports = { isValidThreadId, buildDeepLink, pickNavigator, openDeepLink, UUID_RE };
