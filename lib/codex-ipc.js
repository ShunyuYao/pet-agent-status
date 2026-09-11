'use strict';
// Codex App 内部 IPC 适配器（实验增强，默认关）。
//
// 实测事实见 fixtures/codex-ipc-facts.md。三条设计红线，都写在那份文档的 §5/§7：
//   ① **被动监听**：握手后只收不发，不向未知 method 发请求。我们是客体，不是控制方。
//   ② **未知一律 unknown**：只有实录确认过语义的事件才映射；其余忽略。
//      绝不把没见过的事件猜成 done —— 「绝不误报完成」是协议级硬红线。
//   ③ **故障即退场**：解帧失败/握手失败/断线 → 停用自己，退回 Hooks 通道。
//      IPC 是锦上添花，它挂了不能影响面板既有功能。
//
// 帧格式：4 字节小端长度前缀 + UTF-8 JSON。半包/粘包都要处理（一次 data 可能给半帧或多帧）。

const MAX_FRAME = 1 << 20;        // 单帧上限 1MB：异常长度直接判协议错，防内存放大
const HANDSHAKE_TIMEOUT_MS = 5000;
const BACKOFF_MS = [1000, 5000, 15000, 60000];   // 断线重连退避，封顶 60s

/**
 * 纯函数帧解析器：喂 Buffer，吐出完整消息。状态（残包）留在闭包里。
 * 抽成独立工厂是为了让半包/粘包/超长帧能脱离 socket 单测。
 */
function createFrameParser() {
  let buf = Buffer.alloc(0);
  /**
   * @returns {{messages: object[], error: string|null}} error 非 null = 协议错，调用方应断开
   */
  function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    const messages = [];
    for (;;) {
      if (buf.length < 4) break;
      const len = buf.readUInt32LE(0);
      if (len > MAX_FRAME) return { messages, error: `frame too large: ${len}` };
      if (buf.length < 4 + len) break;          // 半包：等下一块
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        messages.push(JSON.parse(body.toString('utf8')));
      } catch (_) {
        return { messages, error: 'invalid JSON frame' };
      }
    }
    return { messages, error: null };
  }
  return { push, get buffered() { return buf.length; } };
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

/**
 * 已实录确认语义的事件 → 内部动作。其余一律忽略（返回 null）。
 * facts §4 是唯一依据；§5 那些【调研】未复现的事件**刻意不在此表**。
 */
function interpret(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'response' && msg.method === 'initialize') return { kind: 'handshake-ok' };
  if (msg.type !== 'broadcast') return null;
  if (msg.method === 'thread-stream-following-changed') {
    const p = msg.params || {};
    if (typeof p.conversationId !== 'string' || !p.conversationId) return null;
    return { kind: 'following', conversationId: p.conversationId, following: p.following === true };
  }
  return null;   // 未知事件：忽略，不猜语义
}

/**
 * @param {object} deps 全部可注入，测试不碰真 socket
 *   connect(path) → socket 状 EventEmitter（connect/data/error/close + write/destroy）
 *   socketPath、randomUUID、onFollowing(conversationId, following)、onStatus(state)、setTimer/clearTimer
 */
function createCodexIpc(deps) {
  const d = deps || {};
  const socketPath = d.socketPath;
  const connect = d.connect || ((p) => require('net').connect(p));
  const randomUUID = d.randomUUID || (() => require('crypto').randomUUID());
  const setTimer = d.setTimer || setTimeout;
  const clearTimer = d.clearTimer || clearTimeout;

  let sock = null;
  let parser = null;
  let handshakeTimer = null;
  let retryTimer = null;
  let attempt = 0;
  let state = 'idle';      // idle | connecting | ready | disabled
  let stopped = true;
  const following = new Map();   // conversationId → boolean

  function setState(next, reason) {
    if (state === next) return;
    state = next;
    if (typeof d.onStatus === 'function') { try { d.onStatus(state, reason || ''); } catch (_) { /* 诊断回调不该反杀 */ } }
  }

  function cleanupSocket() {
    if (handshakeTimer) { clearTimer(handshakeTimer); handshakeTimer = null; }
    if (sock) {
      try { sock.removeAllListeners && sock.removeAllListeners(); } catch (_) { /* mock 可能没有 */ }
      try { sock.destroy(); } catch (_) { /* 已经死了 */ }
      sock = null;
    }
    parser = null;
  }

  // 协议错：不重连（重连只会再错一次），直接停用，交给 Hooks 通道兜底
  function disable(reason) {
    stopped = true;
    cleanupSocket();
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    following.clear();
    setState('disabled', reason);
  }

  function scheduleRetry(reason) {
    if (stopped) return;
    cleanupSocket();
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    setState('idle', reason);
    retryTimer = setTimer(() => { retryTimer = null; open(); }, wait);
  }

  function open() {
    if (stopped) return;
    setState('connecting');
    parser = createFrameParser();
    try {
      sock = connect(socketPath);
    } catch (e) {
      // App 没跑 / socket 不存在：不是协议错，退避重试（App 随时可能起来）
      scheduleRetry(`connect threw: ${(e && e.code) || e}`);
      return;
    }
    sock.on('connect', () => {
      sock.write(encodeFrame({
        type: 'request',
        requestId: randomUUID(),
        sourceClientId: 'initializing-client',
        method: 'initialize',
        params: { clientType: 'pet-agent-status' },
      }));
      handshakeTimer = setTimer(() => {
        handshakeTimer = null;
        // 握手没回应：可能是版本变了。按 facts §7 停用而不是死磕。
        disable('handshake timeout');
      }, HANDSHAKE_TIMEOUT_MS);
    });
    sock.on('data', (chunk) => {
      const { messages, error } = parser.push(chunk);
      for (const m of messages) handle(m);
      if (error) disable(`frame error: ${error}`);
    });
    sock.on('error', (e) => scheduleRetry(`socket error: ${(e && e.code) || e}`));
    sock.on('close', () => { if (!stopped && state !== 'disabled') scheduleRetry('closed'); });
  }

  function handle(msg) {
    const ev = interpret(msg);
    if (!ev) return;
    if (ev.kind === 'handshake-ok') {
      if (handshakeTimer) { clearTimer(handshakeTimer); handshakeTimer = null; }
      attempt = 0;             // 握手成功才算真正连上，退避计数清零
      setState('ready');
      return;
    }
    if (ev.kind === 'following') {
      if (ev.following) following.set(ev.conversationId, true);
      else following.delete(ev.conversationId);
      if (typeof d.onFollowing === 'function') {
        try { d.onFollowing(ev.conversationId, ev.following); } catch (_) { /* 消费方异常不反杀适配器 */ }
      }
    }
  }

  return {
    start() { if (!stopped) return; stopped = false; attempt = 0; open(); },
    stop() { stopped = true; cleanupSocket(); if (retryTimer) { clearTimer(retryTimer); retryTimer = null; } following.clear(); setState('idle', 'stopped'); },
    /** 当前被 App「跟随」的会话集合（供 summary.focus 在同级中优先） */
    followingIds() { return [...following.keys()]; },
    isFollowing(id) { return following.get(id) === true; },
    get state() { return state; },
  };
}

module.exports = { createCodexIpc, createFrameParser, encodeFrame, interpret, MAX_FRAME, BACKOFF_MS };
