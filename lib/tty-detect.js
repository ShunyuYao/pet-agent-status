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

module.exports = { detectTty, ttyNameByRdev };
