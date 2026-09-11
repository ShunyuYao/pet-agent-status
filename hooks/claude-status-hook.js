#!/usr/bin/env node
'use strict';
// Claude Code hook 入口：stdin 收官方事件 JSON → 按 PROTOCOL.md 映射表写一个状态文件。
//
// 铁律：**绝不阻塞 Claude Code**。无论解析失败、磁盘满、库文件被删，一律静默退出 0；
// 非 0 退出码或 stderr 噪音都会打扰用户的会话，而这只是个状态指示器，不值得。

const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

// 正常路径读完 stdin 就退；万一 Claude Code 不关 stdin，兜底 3s 自杀，不留僵尸。
const READ_TIMEOUT_MS = 3000;

function quit() {
  process.exit(0);
}

function handle(raw) {
  const { stateForEvent } = require(path.join(LIB, 'claude-events.js'));
  const { writeStatus } = require(path.join(LIB, 'state-files.js'));
  const { resolveTty, resolveAgentPid } = require(path.join(LIB, 'tty-detect.js'));

  const event = JSON.parse(raw);
  // 传完整事件：Notification 要靠 matcher/message 区分「等批准」与「闲置提醒」
  // （见 lib/claude-events.js 的 isIdleNotification）。
  const state = stateForEvent(event.hook_event_name, event);
  if (state === null) return; // 未知事件：不写、不报错

  // session_id / cwd 是协议必填项的来源，缺了写出来也是坏记录，不如不写
  if (!event.session_id || !event.cwd) return;

  const input = {
    agent: 'claude-code',
    sessionId: event.session_id,
    cwd: event.cwd,
    tty: resolveTty(process.ppid),
    // 挂钩的是 agent 进程，本脚本自己的 pid 一写完就没了，做存活探测无意义。
    // ⚠️ 不能直接用 ppid：hook 的直接父进程常是 agent 起的**中间 shell**，它写完就退，
    // 拿它做存活探测会把活得好好的会话误判成 error。取「父链上第一个有 tty 的祖先」＝ agent 本体。
    pid: resolveAgentPid(process.ppid) || process.ppid,
    state,
    lastEvent: event.hook_event_name,
    source: 'hook'
  };
  // 会话标题：Claude Code 不落盘 AI 生成的会话名（2026-09-11 实测 ~/.claude 全仓无此数据，
  // resume 列表的标题是展示时临时派生的），本机能拿到的最好等价物 = 首条 prompt 的首行。
  // 只在 UserPromptSubmit 带上；writeStatus 首见定名 + 截断（PROTOCOL.md「title」——
  // 「不采集会话正文」红线的显式让步：只许首行 + 64 码点，绝不落完整 prompt）。
  if (event.hook_event_name === 'UserPromptSubmit' && typeof event.prompt === 'string') {
    input.title = event.prompt;
  }
  writeStatus(input);
}

function main() {
  let raw = '';
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    try { handle(raw); } catch (_) { /* 见文件头铁律：任何错误都静默 */ }
    quit();
  };

  const timer = setTimeout(finish, READ_TIMEOUT_MS);
  timer.unref();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

main();
