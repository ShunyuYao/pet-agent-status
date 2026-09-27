'use strict';
// Single collector writer. Only fixed metadata crosses this boundary, never payloads/errors.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { stateDir } = require('./state-files');
const MAX_BYTES = 1024 * 1024;
const EVENTS = new Set(['collector.started', 'collector.stopped', 'collector.health', 'collector.fault',
  'collector.state-files', 'collector.state', 'settings.changed', 'ipc.connecting', 'ipc.ready',
  'ipc.retry', 'ipc.disabled', 'ipc.stopped', 'ipc.event', 'ipc.consumer-error',
  'metadata.error', 'metadata.ready', 'ingest.error']);
const ENUMS = {
  state: ['off', 'idle', 'connecting', 'ready', 'disabled', 'running', 'waiting', 'waiting-input',
    'done', 'ended', 'failed', 'stopped', 'sync-paused', 'unknown', 'error'],
  reason: ['connect-error', 'socket-error', 'closed', 'handshake-timeout', 'invalid-json',
    'frame-too-large', 'sqlite-unavailable', 'callback-error', 'read-error', 'write-error', 'query-error'],
  stage: ['tick', 'metadata', 'rollout', 'workbuddy', 'settings-read', 'settings-write', 'scheduler'],
  database: ['state_5.sqlite', 'thread_history_1.sqlite'],
  query: ['catalog', 'identity', 'spawn', 'turn'],
  kind: ['following', 'activity', 'read-state'],
  source: ['hook', 'ipc', 'reconcile', 'poll']
};
const NUMBERS = ['attempt', 'retryMs', 'retryAt', 'frameBytes', 'lastMessageAt', 'receivedFrames',
  'recognizedEvents', 'followingCount', 'trackedCount', 'metadataCount', 'activeCount', 'rows',
  'running', 'waiting', 'unknown', 'badFiles', 'evidenceAt'];
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function errorCode(error) {
  return typeof error?.code === 'string' && /^(?:E[A-Z0-9_]{1,60}|SQLITE_[A-Z0-9_]{1,60})$/.test(error.code)
    ? error.code : 'UNCLASSIFIED';
}
function createDiagnostics({ dir, now = Date.now, maxBytes = MAX_BYTES, version = 'unknown' } = {}) {
  const folder = path.join(dir || stateDir(), 'diagnostics');
  const file = path.join(folder, 'agent-status.jsonl');
  const instance = randomUUID(), recent = new Map();
  const limit = Math.max(1024, Math.min(MAX_BYTES, maxBytes));
  let retryWriteAt = 0;
  function record(event, input = {}, intervalMs = 0) {
    try {
      if (!EVENTS.has(event)) return false;
      const at = now();
      if (at < retryWriteAt) return false;
      const data = {};
      for (const [key, allowed] of Object.entries(ENUMS)) if (allowed.includes(input[key])) data[key] = input[key];
      for (const key of NUMBERS) if (Number.isFinite(input[key]) && input[key] >= 0) data[key] = input[key];
      for (const key of ['sessionId', 'turnId', 'runId']) if (typeof input[key] === 'string' && UUID.test(input[key])) data[key] = input[key];
      for (const key of ['enabled', 'following', 'unavailable', 'read']) if (typeof input[key] === 'boolean') data[key] = input[key];
      if (input.code === 'UNCLASSIFIED' || errorCode({ code: input.code }) !== 'UNCLASSIFIED') data.code = input.code;
      const key = event + JSON.stringify(data);
      if (intervalMs && recent.has(key) && at - recent.get(key) < intervalMs) return false;
      const line = JSON.stringify({ at: new Date(at).toISOString(), pid: process.pid, instance,
        version: /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][a-zA-Z0-9]+)*$/.test(version) ? version : 'unknown', event, ...data }) + '\n';
      const bytes = Buffer.byteLength(line);
      if (bytes > limit) return false;
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size + bytes > limit) {
        try { fs.unlinkSync(file + '.2'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { fs.renameSync(file + '.1', file + '.2'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { fs.renameSync(file, file + '.1'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
      recent.delete(key); recent.set(key, at);
      if (recent.size > 128) recent.delete(recent.keys().next().value);
      return true;
    } catch (_) { retryWriteAt = now() + 30000; return false; }
  }
  return { record };
}
module.exports = { createDiagnostics, errorCode, MAX_BYTES };
