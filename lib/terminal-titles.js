'use strict';
// 终端标签标题解析器：tty → 终端里显示的会话标题。
//
// 事实依据（fixtures/terminal-titles-facts.md，2026-09-11 本机实录）：
// Claude Code 把 AI 生成的会话标题经 OSC 转义推给终端（磁盘上没有这份数据），
// iTerm2（session 的 name）与 Terminal.app（tab 的 custom title）都能按 tty 查回来。
// 这是 Claude Code 会话唯一能拿到「用户在终端亲眼看到的那个 AI 标题」的通道。
//
// 边界（facts §3/§4）：
// - `tell application` 会把没在跑的终端拉起来——每家查询块先判 `is running`；
//   `application "X"` 对没装的 App 直接抛错，故各自 try 包裹，一家坏不影响另一家。
// - osascript 走宿主既有的自动化授权（与 terminal-jump 跳转同一份），不新增权限面。
// - 一次调度拉全量 `tty | title` 建 Map + TTL 缓存；任何失败静默空 Map，TTL 后重试。

const TTL_MS = 15 * 1000;      // 标题变化不频繁（改名/spinner 翻面），15s 足够跟上
const OSA_TIMEOUT_MS = 5000;   // 与 codex-deeplink 的 open 同档：卡住不如放弃本轮

// 两家终端一把抓：每家自己 try（没装/没授权/报错就贡献空段），linefeed 分行。
// 输出行格式 `tty | title`（facts §1/§2 实录形态）。
const LIST_SCRIPT = `
set out to ""
try
  if application "iTerm2" is running then
    tell application "iTerm2"
      repeat with w in windows
        repeat with tb in tabs of w
          repeat with s in sessions of tb
            set out to out & (tty of s) & " | " & (name of s) & linefeed
          end repeat
        end repeat
      end repeat
    end tell
  end if
end try
try
  if application "Terminal" is running then
    tell application "Terminal"
      repeat with w in windows
        repeat with tb in tabs of w
          set out to out & (tty of tb) & " | " & (custom title of tb) & linefeed
        end repeat
      end repeat
    end tell
  end if
end try
return out
`;

/**
 * 清洗终端标题（facts §4）：去开头状态符号（Claude Code 的 spinner，非标题本体）、
 * 去结尾 ` (claude)`/` (codex)` 厂牌后缀。清洗后为空返回 null——不造假名。
 */
function cleanTitle(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/\s+\((claude|codex)\)$/i, '');
  // 开头 1–2 个非字母数字码点（后跟空白或到头）= 状态符号（✳ ◐ ◑ …），
  // 含「只剩一个孤零 spinner」的形态。标题正文以字词开头。
  s = s.replace(/^[^\p{L}\p{N}\s]{1,2}(\s+|$)/u, '');
  s = s.trim();
  return s === '' ? null : s;
}

function defaultExec(cmd, args) {
  const { execFileSync } = require('child_process');
  return execFileSync(cmd, args, { timeout: OSA_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {object} [deps] { execFile, now, ttlMs }（测试注入 execFile，绝不 spawn 真 osascript）
 */
function createTerminalTitles(deps) {
  const d = deps || {};
  const exec = typeof d.execFile === 'function' ? d.execFile : defaultExec;
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const ttl = Number.isFinite(d.ttlMs) ? d.ttlMs : TTL_MS;

  let cache = new Map();       // tty → 清洗后的标题
  let cachedAt = -Infinity;

  function refresh() {
    const next = new Map();
    let raw = '';
    try {
      raw = String(exec('osascript', ['-e', LIST_SCRIPT]) || '');
    } catch (_) { cache = next; return; }   // 没授权/超时/osascript 缺失：本轮空表
    for (const line of raw.split('\n')) {
      const sep = line.indexOf(' | ');
      if (sep <= 0) continue;
      const tty = line.slice(0, sep).trim();
      const title = cleanTitle(line.slice(sep + 3));
      if (tty.startsWith('/dev/') && title != null) next.set(tty, title);
    }
    cache = next;
  }

  /** tty → 终端里显示的标题；查不到返回 null（上层自行回落） */
  function lookup(tty) {
    if (typeof tty !== 'string' || tty === '') return null;
    const at = now();
    if (at - cachedAt >= ttl) {
      cachedAt = at;           // 先记时间：refresh 失败也别在 TTL 内反复 spawn
      try { refresh(); } catch (_) { /* 静默，沿用旧表 */ }
    }
    return cache.get(tty) || null;
  }

  return { lookup, cleanTitle, get size() { return cache.size; } };
}

module.exports = { createTerminalTitles, cleanTitle, TTL_MS, LIST_SCRIPT };
