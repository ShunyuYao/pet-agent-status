#!/usr/bin/env node
'use strict';
// Codex CLI hook 入口：stdin 收事件 JSON → 按 PROTOCOL.md Codex 映射表写一个状态文件。
//
// 铁律与 Claude Code hook 完全一致：**绝不阻塞 Codex CLI**。解析失败、磁盘满、库文件被删，
// 一律静默退出 0；非 0 退出码或 stderr 噪音都会打扰用户的会话，而这只是个状态指示器。
//
// 事件名与 payload 字段名来自 fixtures/codex-hooks-facts.md 的本机实测，未凭记忆推测。

const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

// 正常路径读完 stdin 就退；万一 Codex 不关 stdin，兜底 3s 自杀，不留僵尸。
const READ_TIMEOUT_MS = 3000;

function quit() {
  process.exit(0);
}

function handle(raw) {
  const { stateForEvent, threadIdOf } = require(path.join(LIB, 'codex-events.js'));
  const { writeStatus } = require(path.join(LIB, 'state-files.js'));
  const { resolveTty, resolveAgentPid } = require(path.join(LIB, 'tty-detect.js'));

  const event = JSON.parse(raw);
  const state = stateForEvent(event.hook_event_name);
  if (state === null) return; // 未知事件：不写、不报错

  // session_id / cwd 是协议必填项的来源，缺了写出来也是坏记录，不如不写
  if (!event.session_id || !event.cwd) return;

  const input = {
    agent: 'codex',
    sessionId: event.session_id,
    cwd: event.cwd,
    tty: resolveTty(process.ppid),
    // 挂钩的是 Codex CLI 进程；不能用 ppid（hook 的直接父常是中间 shell，写完即退，
    // 拿它做存活探测会把活着的会话误判成 error）。取父链上第一个有 tty 的祖先＝agent 本体。
    pid: resolveAgentPid(process.ppid) || process.ppid,
    state,
    lastEvent: event.hook_event_name,
    source: 'hook'
  };
  // facts 实测：Codex 的 session_id 本身就是线程号。形态不对就不写（见 codex-events.js）。
  const threadId = threadIdOf(event.session_id);
  if (threadId) input.threadId = threadId;

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
