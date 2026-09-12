'use strict';
// 「这个会话是别的 agent 起的子进程吗」——是的话 hook 不落盘，它不进面板。
//
// 为什么要这条（2026-09-12 用户提出，实录见 fixtures/nested-session-facts.md）：
// 一个 agent 在自己的 Bash 工具里跑 `claude -p ...`（双轨复核、脚本化子任务、
// 本仓 E2E 自己起的探针都算）会生成**独立 sessionId** 的会话，于是面板多出一行。
// 那一行有两处害处：
//   ① 跳不过去——它没有自己的终端，tty 是从父会话**继承**来的，点了会跳到父会话的
//      终端窗口（实录：子会话记的是 tty=/dev/ttys018、pid=99593，两个都是父会话的）；
//   ② 它不是用户在跟的任务——结束时还会计进「刚办完」汇总、让宠物喊一声。
//
// 判据：**祖先链上除了自己这个 claude 进程之外还有第二个 claude**。
// 实录链（嵌套）：hook → claude(74691) → timeout → zsh → claude(99593) → -zsh → …
// 实录链（交互）：hook → claude(99593) → -zsh → login → iTermServer → launchd
//
// ⚠️ 大小写必须敏感：Claude Desktop App 的主进程 comm 是
// `/Applications/Claude.app/Contents/MacOS/Claude`（大写 C），而 App 会话的 agent 是
// 内嵌 CLI `.../claude-code/<ver>/claude.app/Contents/MacOS/claude`（小写）。
// 不区分大小写会把 App 主进程当成第二个 claude，App 会话就整个不显示了。
//
// 方向性保守（fail-open）：ps 读不出来、链断了、装的是 npm 形态（comm 是 node）
// 一律当作「不是嵌套」照常显示。漏掉一条子进程会话只是噪音，
// 错删一条用户真在跟的会话是丢信息。

const { execFileSync } = require('child_process');

const CLAUDE_COMM = 'claude';       // 比对的是 comm 的 basename，区分大小写
const MAX_DEPTH = 24;               // 同 terminal-jump：防 ppid 成环把 hook 挂死
const PS_TIMEOUT_MS = 4000;

// 逐行切 `pid ppid tty comm`。comm 可能含空格（App 路径里就有），只切前三列。
function parsePs(text) {
  const rows = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], comm: m[4].trim() });
  }
  return rows;
}

function isClaudeComm(comm) {
  const s = String(comm == null ? '' : comm);
  const base = s.slice(s.lastIndexOf('/') + 1);
  return base === CLAUDE_COMM;
}

/**
 * @param {number} startPid hook 的父进程 pid（= agent 进程）
 * @param {string} psText `ps -eo pid=,ppid=,tty=,comm=` 的输出
 * @returns {boolean} 链上 claude 进程数 ≥2 即为子进程会话
 */
function isNestedByPs(startPid, psText) {
  const rows = parsePs(psText);
  if (rows.length === 0) return false;
  const byPid = new Map();
  for (const r of rows) byPid.set(r.pid, r);

  let cur = byPid.get(Number(startPid));
  if (!cur) return false;                 // 链上找不到自己：拿不准，照常显示
  let claudes = 0;
  const seen = new Set();
  for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
    if (seen.has(cur.pid)) break;         // 成环：到此为止，用已数到的结果
    seen.add(cur.pid);
    if (isClaudeComm(cur.comm)) {
      claudes++;
      if (claudes >= 2) return true;      // 够了就走，不必爬完整条链
    }
    cur = byPid.get(cur.ppid);
  }
  return false;
}

// 真实进程表。PET_AS_PS_OUTPUT 是测试/E2E 的注入口（同 PET_AS_* 覆盖约定），
// 让测试不必 spawn 真 ps，也能喂入实录的进程树。
function readPs() {
  const injected = process.env.PET_AS_PS_OUTPUT;
  if (typeof injected === 'string' && injected !== '') return injected;
  try {
    return execFileSync('ps', ['-eo', 'pid=,ppid=,tty=,comm='], {
      encoding: 'utf8', timeout: PS_TIMEOUT_MS
    });
  } catch (_) {
    return '';                            // 读不出来 → fail-open
  }
}

/** hook 用：这个会话是不是别的 agent 起的子进程。任何异常都按「不是」处理。 */
function isNestedAgentSession(ppid) {
  try {
    return isNestedByPs(ppid, readPs());
  } catch (_) {
    return false;
  }
}

module.exports = { isNestedByPs, isNestedAgentSession, parsePs, readPs, isClaudeComm, CLAUDE_COMM, MAX_DEPTH };
