'use strict';
// 点击会话行 → 跳回它所在的终端窗口/标签页（US-005）。
//
// 分两层，测试只碰上层：
//  1. 纯函数层：detectTerminal（判进程树归属）/ buildScript（生成 AppleScript 文本）。
//     进程表由 psTreeProvider 注入，测试伪造，不探真实进程。
//  2. 薄执行壳：runJump —— spawn `osascript -e <script>`（README 权限披露第 3 行已声明用途）。
//     测试**绝不**真跑 osascript（会骚扰真实桌面），执行器同样可注入。
//
// 终端归属判定**只此一处**：panel 不判、aggregate 不判，两边都只消费 row.canJump。
// 判定散落多处 = 两边迟早给出不一致的答案（点得动却跳不了，或跳得了却点不动）。

const { execFileSync } = require('child_process');

// ---- 已知终端 App：可执行文件路径里出现这些片段就算命中 ----
//
// 匹配的是 `ps -o comm` 给的**绝对路径**（实测形如
// `/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal`），
// 所以拿 `.app/` 这段做锚，比裸进程名稳（裸名 `Terminal` 太容易误伤）。
const ITERM_MARKERS = ['/iTerm.app/', '/iTerm2.app/'];
const TERMINAL_MARKERS = ['/Terminal.app/'];
// 兜底档：认得出是哪个 App，但没有按 tty 精确定位的 AppleScript 接口 ——
// 只 activate，不假装精确（criteria §2）。
const FALLBACK_APPS = [
  { markers: ['/Warp.app/'], app: 'Warp' },
  { markers: ['/kitty.app/'], app: 'kitty' },
  { markers: ['/Alacritty.app/'], app: 'Alacritty' },
  { markers: ['/WezTerm.app/'], app: 'WezTerm' },
  { markers: ['/Hyper.app/'], app: 'Hyper' },
  { markers: ['/Ghostty.app/'], app: 'Ghostty' },
  { markers: ['/Tabby.app/'], app: 'Tabby' },
  // VS Code / Cursor 的集成终端：能激活到编辑器窗口，标签页定位无接口
  { markers: ['/Visual Studio Code.app/'], app: 'Visual Studio Code' },
  { markers: ['/Cursor.app/'], app: 'Cursor' }
];

// 父链最多爬这么多层。防的是 ppid 成环（进程表是快照，pid 复用时理论上可能自指）
// —— 爬不动就当推断不出，返回 null，而不是死循环把 tool 挂住。
const MAX_DEPTH = 24;

// '/dev/ttys004' 与 'ttys004' 都要认：ps 的 TTY 列不带 /dev 前缀，
// 而协议里的 tty 字段是全路径（PROTOCOL.md 字段表）。
function normalizeTty(tty) {
  const s = String(tty == null ? '' : tty).trim();
  if (!s) return '';
  return s.startsWith('/dev/') ? s.slice('/dev/'.length) : s;
}

// tty 必须长这样才允许进 AppleScript / 进程树匹配。
// 白名单而不是转义：tty 名的合法形态本来就极窄（ttys004 / ttyp0），
// 不合规的一律拒绝（返回 null → 面板不给跳转入口），比转义后放行更保险。
const TTY_RE = /^tty[a-z0-9]+$/i;

function isValidTty(tty) {
  return TTY_RE.test(normalizeTty(tty));
}

// 默认进程表来源。comm 取绝对路径（-o comm= 在 macOS 上给的是完整路径）。
function readPsTree() {   // 真实进程表（spawn ps）；测试一律注入伪造的，不走这里
  let out;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8', timeout: 4000 });
  } catch (_) {
    return [];
  }
  return parsePsOutput(out);
}

// 逐行切 `pid ppid tty comm`。comm 可能含空格（App 路径里就有），所以只切前三列。
function parsePsOutput(text) {
  const rows = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], comm: m[4].trim() });
  }
  return rows;
}

function matchApp(comm) {
  const s = String(comm == null ? '' : comm);
  if (ITERM_MARKERS.some((k) => s.includes(k))) return 'iterm2';
  if (TERMINAL_MARKERS.some((k) => s.includes(k))) return 'terminal';
  for (const entry of FALLBACK_APPS) {
    if (entry.markers.some((k) => s.includes(k))) return `activate:${entry.app}`;
  }
  return null;
}

/**
 * 这个 tty 归哪个终端 App 管。**终端归属判定的唯一入口。**
 *
 * 做法：从进程表里挑出挂在该 tty 上的进程，各自沿 ppid 往上爬，
 * 第一个能认出 App 的祖先就是答案（真实链路是
 * Terminal.app → login → -zsh → claude → node）。
 *
 * @param {string} tty '/dev/ttys004' 或 'ttys004'
 * @param {Function|object[]} [psTreeProvider] 返回 [{pid, ppid, comm}] 的函数（或直接给数组）
 * @returns {'iterm2'|'terminal'|`activate:${string}`|null} 推断不出返回 null
 */
function detectTerminal(tty, psTreeProvider) {
  if (!isValidTty(tty)) return null;
  const want = normalizeTty(tty);

  let list;
  try {
    if (Array.isArray(psTreeProvider)) list = psTreeProvider;
    else if (typeof psTreeProvider === 'function') list = psTreeProvider(want);
    else list = readPsTree();
  } catch (_) {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0) return null;

  const byPid = new Map();
  for (const p of list) {
    if (p && p.pid != null) byPid.set(Number(p.pid), p);
  }

  // 挂在该 tty 上的进程可能有好几个（login/shell/claude/node），任一条链爬到即可
  const seeds = list.filter((p) => p && normalizeTty(p.tty) === want);
  for (const seed of seeds) {
    let cur = seed;
    for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
      const kind = matchApp(cur.comm);
      if (kind) return kind;
      const next = byPid.get(Number(cur.ppid));
      if (!next || next === cur) break;   // 到头了 / 自指
      cur = next;
    }
  }
  return null;
}

// AppleScript 字符串字面量转义。这里只用于 App 名（内部常量），
// tty 走 TTY_RE 白名单不靠转义 —— 两道防线各管各的。
function escapeAppleString(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 生成聚焦用的 AppleScript 文本（纯函数，不执行）。
 * @param {string} kind detectTerminal 的返回值
 * @param {string} tty
 * @returns {string|null} 生成不了返回 null（panel 不给入口）
 */
function buildScript(kind, tty) {
  if (typeof kind !== 'string' || !kind) return null;
  if (kind.startsWith('activate:')) {
    const app = kind.slice('activate:'.length);
    if (!app) return null;
    // 兜底：只激活，不假装能定位到具体标签页
    return `tell application "${escapeAppleString(app)}" to activate`;
  }
  // 精确档必须有个合法 tty 才谈得上「精确」
  if (!isValidTty(tty)) return null;
  const dev = `/dev/${normalizeTty(tty)}`;

  if (kind === 'iterm2') {
    // iTerm2 的层级是 window > tab > session，tty 挂在 session 上
    return [
      'tell application "iTerm2"',
      '  repeat with w in windows',
      '    repeat with tb in tabs of w',
      '      repeat with s in sessions of tb',
      `        if tty of s is "${dev}" then`,
      '          select w',
      '          select tb',
      '          select s',
      '          activate',
      '          return',
      '        end if',
      '      end repeat',
      '    end repeat',
      '  end repeat',
      'end tell'
    ].join('\n');
  }

  if (kind === 'terminal') {
    // Terminal.app：tty 挂在 tab 上，选中 tab 并把它的 window 提到最前
    return [
      'tell application "Terminal"',
      '  repeat with w in windows',
      '    repeat with tb in tabs of w',
      `      if tty of tb is "${dev}" then`,
      '        set selected of tb to true',
      '        set index of w to 1',
      '        activate',
      '        return',
      '      end if',
      '    end repeat',
      '  end repeat',
      'end tell'
    ].join('\n');
  }

  return null;
}

/**
 * 一步到位：tty → 脚本。panel 那边判「有没有跳转入口」用的就是它非 null。
 */
function scriptForTty(tty, psTreeProvider) {
  const kind = detectTerminal(tty, psTreeProvider);
  if (!kind) return null;
  return buildScript(kind, tty);
}

const DEFAULT_TIMEOUT_MS = 5000;

// 默认执行器：spawn osascript。脚本经 -e 参数传，不经 shell，天然无注入面。
function defaultRunner(script, timeoutMs) {
  try {
    execFileSync('osascript', ['-e', script], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true };
  } catch (err) {
    // 超时 / 非零退出 / 二进制不存在，统一成可展示的原因，绝不 throw 出去
    const reason = (err && (err.stderr || err.message) ? String(err.stderr || err.message) : 'osascript failed').trim();
    return { ok: false, reason: reason.split('\n')[0].slice(0, 200) };
  }
}

/**
 * 执行跳转。**不 throw、不静默**：失败一律返回 {ok:false, reason}，
 * 由调用方（tool）写进下一次快照的 jumpError，面板显示行内错误条（DESIGN.md）。
 *
 * @param {string} tty
 * @param {{psTree?:Function, runner?:Function, timeoutMs?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, kind?:string|null, script?:string}}
 */
function runJump(tty, opts) {
  const o = opts || {};
  const kind = detectTerminal(tty, o.psTree);
  const script = buildScript(kind, tty);
  if (!script) return { ok: false, reason: 'unavailable', kind };
  const run = typeof o.runner === 'function' ? o.runner : defaultRunner;
  let result;
  try {
    result = run(script, Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_TIMEOUT_MS);
  } catch (err) {
    result = { ok: false, reason: (err && err.message) ? String(err.message) : 'jump failed' };
  }
  const ok = !!(result && result.ok);
  return ok
    ? { ok: true, kind, script }
    : { ok: false, kind, script, reason: (result && result.reason) ? String(result.reason) : 'jump failed' };
}

module.exports = {
  TTY_RE, MAX_DEPTH, DEFAULT_TIMEOUT_MS,
  normalizeTty, isValidTty, parsePsOutput, matchApp, readPsTree,
  detectTerminal, buildScript, scriptForTty, runJump
};
