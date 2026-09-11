'use strict';
// 反查当前进程挂在哪个 tty 上。hook 脚本由 Claude Code 直接 spawn，通常继承终端的
// stdin/stdout/stderr，所以三个 fd 里只要有一个是 tty 就能定位会话所在终端。
//
// 为什么不用 readlink('/dev/fd/N')：macOS 上对 tty 的 fd 做 readlink 返回 EINVAL（实测），
// 那条路只在 Linux 通。这里改用 fstat 的 rdev（设备号）去 /dev 里反查同 rdev 的 ttys*，
// 这在 macOS 上实测可用（见 progress.txt）。

const fs = require('fs');
const tty = require('tty');

// 只扫 /dev 下的伪终端设备，别整个目录乱 stat（/dev 里有会阻塞的设备文件）
const TTY_NAME_RE = /^ttys[0-9]+$/;

function ttyNameByRdev(rdev, devDir) {
  const base = devDir || '/dev';
  let names;
  try { names = fs.readdirSync(base); } catch (_) { return null; }
  for (const name of names) {
    if (!TTY_NAME_RE.test(name)) continue;
    try {
      if (fs.statSync(`${base}/${name}`).rdev === rdev) return `${base}/${name}`;
    } catch (_) { /* 设备不可 stat 就跳过 */ }
  }
  return null;
}

// 返回 '/dev/ttysNNN' 或 null（拿不到就是 null，协议允许）
function detectTty(fds, devDir) {
  const candidates = fds || [0, 1, 2];
  for (const fd of candidates) {
    let isTty = false;
    try { isTty = tty.isatty(fd); } catch (_) { isTty = false; }
    if (!isTty) continue;
    let rdev;
    try { rdev = fs.fstatSync(fd).rdev; } catch (_) { continue; }
    const name = ttyNameByRdev(rdev, devDir);
    if (name) return name;
  }
  return null;
}

// fd 路走不通时的兜底：拿 agent 进程的 pid 去问 ps。
//
// 实测（2026-09-10，真机）：Claude Code / Codex 给 hook 的 stdin 是 pipe（要喂事件 JSON）、
// stdout/stderr 也常是 pipe（要收 hook 输出），**三个 fd 一个都不是 tty**，所以上面那条
// fstat 路在真实环境恒返回 null —— 线上抓到的状态文件 tty 全是 null，跳转入口因此永不出现。
// 但 hook 的父进程就是 agent 本身（pid 已采到），`ps -o tty= -p <pid>` 直接给出 `ttys026`。
// execFileSync 可注入，测试不真跑 ps。
function detectTtyByPid(pid, execFileSyncImpl) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const exec = execFileSyncImpl || defaultExec;
  let out;
  try { out = String(exec('ps', ['-o', 'tty=', '-p', String(pid)]) || '').trim(); } catch (_) { return null; }
  // 没有控制终端时 ps 输出 `??`（或空）；只认 ttysNNN 形态，别把垃圾拼进路径
  if (!TTY_NAME_RE.test(out)) return null;
  return `/dev/${out}`;
}

// 沿父链向上找第一个有控制终端的祖先。
//
// ⚠️ 2026-09-11 真机根因：**agent 的 hook 的直接父进程往往没有 tty**。
// Claude Code 执行 hook 时会起一个中间 shell，`ps -o tty= -p <ppid>` 对它返回 `??`
// （无控制终端），于是只问一层的旧实现恒返回 null —— 线上 19 个状态文件里 18 个 tty 为 null，
// 用户点会话行毫无反应（拿不到 tty 就不给跳转入口）。真正带 tty 的是**更上层的 agent 进程**
// （实测 claude 进程本身 ttys017/018/026 都查得到）。
// 少数事件路径下 agent 直接 spawn hook（少一层 shell），那时父进程恰好有 tty ——
// 这解释了为什么当时 19 条里有 1 条是好的，别把那条巧合当成"实现没问题"。
//
// 上溯有上限（防父链成环/极深）；遇到 pid<=1（init）停。
const MAX_TTY_WALK = 6;
function detectTtyByPidTree(pid, execFileSyncImpl, psTreeImpl) {
  const exec = execFileSyncImpl || defaultExec;
  const readPpid = psTreeImpl || ((p) => {
    try {
      const out = String(exec('ps', ['-o', 'ppid=', '-p', String(p)]) || '').trim();
      const n = Number(out);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) { return null; }
  });
  let cur = Number(pid);
  for (let i = 0; i < MAX_TTY_WALK; i++) {
    if (!Number.isFinite(cur) || cur <= 1) return null;
    const tty = detectTtyByPid(cur, execFileSyncImpl);
    if (tty) return tty;
    const next = readPpid(cur);
    if (next == null || next === cur) return null;   // 查不到父/自环：停
    cur = next;
  }
  return null;
}

// 找到 tty 的那个祖先 pid（供状态文件记录真正的 agent 进程，而不是中间 shell）。
// pid 要准，存活探测（error 推导）才有意义：中间 shell 早就退了，拿它做探测会误报 error。
function resolveAgentPid(pid, execFileSyncImpl, psTreeImpl) {
  const exec = execFileSyncImpl || defaultExec;
  const readPpid = psTreeImpl || ((p) => {
    try {
      const out = String(exec('ps', ['-o', 'ppid=', '-p', String(p)]) || '').trim();
      const n = Number(out);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) { return null; }
  });
  let cur = Number(pid);
  for (let i = 0; i < MAX_TTY_WALK; i++) {
    if (!Number.isFinite(cur) || cur <= 1) return null;
    if (detectTtyByPid(cur, execFileSyncImpl)) return cur;
    const next = readPpid(cur);
    if (next == null || next === cur) return null;
    cur = next;
  }
  return null;
}

function defaultExec(cmd, args) {
  const { execFileSync } = require('child_process');
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
}

// hook 侧统一入口：先 fd（最准、零开销），拿不到再问 ps。
function resolveTty(pid, opts) {
  const o = opts || {};
  return detectTty(o.fds, o.devDir) || detectTtyByPidTree(pid, o.execFileSync, o.psTree);
}

module.exports = { detectTty, detectTtyByPid, detectTtyByPidTree, resolveAgentPid, resolveTty, ttyNameByRdev, MAX_TTY_WALK };
