'use strict';
// 状态文件读写（PROTOCOL.md schema:1 的唯一实现处）。
// 只碰状态目录：默认 ~/.local/state/pet-agent-status/，测试经 PET_AGENT_STATUS_DIR 覆盖。

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA = 1;
const AGENTS = ['claude-code', 'codex'];
const STATES = ['running', 'waiting', 'done', 'ended'];
const SOURCES = ['hook', 'ipc', 'reconcile'];

// PROTOCOL.md「字段」表里必填的那些；缺任意一项按损坏跳过。
const REQUIRED = ['schema', 'agent', 'sessionId', 'cwd', 'project', 'tty', 'pid', 'state', 'lastEvent', 'ts'];

function stateDir() {
  const override = process.env.PET_AGENT_STATUS_DIR;
  if (override) return override;
  return path.join(os.homedir(), '.local', 'state', 'pet-agent-status');
}

// 防路径穿越：PROTOCOL.md 规定只留 [A-Za-z0-9._-]，其余一律 _
function sanitizeSessionId(sessionId) {
  const s = String(sessionId == null ? '' : sessionId);
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned === '' ? '_' : cleaned;
}

function fileFor(sessionId, dir) {
  return path.join(dir || stateDir(), `${sanitizeSessionId(sessionId)}.json`);
}

// 组装一条符合 schema:1 的记录。调用方给什么就写什么，缺省项补协议要求的 null。
function buildRecord(input) {
  const cwd = String(input.cwd == null ? '' : input.cwd);
  const rec = {
    schema: SCHEMA,
    agent: input.agent,
    sessionId: sanitizeSessionId(input.sessionId),
    cwd,
    project: input.project != null ? String(input.project) : path.basename(cwd),
    tty: input.tty != null ? String(input.tty) : null,
    pid: Number.isFinite(input.pid) ? Number(input.pid) : null,
    state: input.state,
    lastEvent: String(input.lastEvent == null ? '' : input.lastEvent),
    ts: Number.isFinite(input.ts) ? Number(input.ts) : Date.now()
  };
  if (input.threadId != null) rec.threadId = String(input.threadId);
  rec.source = SOURCES.includes(input.source) ? input.source : 'hook';
  return rec;
}

// 原子写：同目录 .tmp- 临时文件 → rename 覆盖（同分区，rename 保证读者永远看到完整 JSON）
function writeStatus(input, dir) {
  const target = dir || stateDir();
  fs.mkdirSync(target, { recursive: true });
  const rec = buildRecord(input);
  const file = path.join(target, `${rec.sessionId}.json`);
  const tmp = path.join(target, `.tmp-${rec.sessionId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 清理失败无所谓 */ }
    throw err;
  }
  return { file, record: rec };
}

// 校验一条已解析的记录是否可用；不可用返回原因（调用方归 unknown 计数）
function validateRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not-an-object';
  if (obj.schema !== SCHEMA) {
    return Number.isFinite(obj.schema) && obj.schema > SCHEMA ? 'schema-too-new' : 'schema-mismatch';
  }
  for (const key of REQUIRED) {
    if (!(key in obj)) return `missing:${key}`;
  }
  if (!AGENTS.includes(obj.agent)) return 'bad-agent';
  if (!STATES.includes(obj.state)) return 'bad-state';
  if (typeof obj.sessionId !== 'string' || obj.sessionId === '') return 'bad-sessionId';
  if (typeof obj.cwd !== 'string') return 'bad-cwd';
  if (typeof obj.project !== 'string') return 'bad-project';
  if (obj.tty !== null && typeof obj.tty !== 'string') return 'bad-tty';
  if (obj.pid !== null && !Number.isFinite(obj.pid)) return 'bad-pid';
  if (typeof obj.lastEvent !== 'string') return 'bad-lastEvent';
  if (!Number.isFinite(obj.ts)) return 'bad-ts';
  return null;
}

// 读整个目录 → 快照数组。任何单文件问题都只归类计数，绝不抛（采集器每 2s 调一次，不许被脏文件打死）。
function readSnapshots(dir) {
  const target = dir || stateDir();
  const records = [];
  const unknown = [];
  let names;
  try {
    names = fs.readdirSync(target);
  } catch (_) {
    return { records, unknown, unknownCount: 0 };
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.tmp-')) continue;
    const file = path.join(target, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      unknown.push({ file, reason: 'unparsable' });
      continue;
    }
    const reason = validateRecord(parsed);
    if (reason) { unknown.push({ file, reason }); continue; }
    records.push(parsed);
  }
  return { records, unknown, unknownCount: unknown.length };
}

function readStatus(sessionId, dir) {
  const file = fileFor(sessionId, dir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validateRecord(parsed) ? null : parsed;
  } catch (_) {
    return null;
  }
}

function removeStatus(sessionId, dir) {
  try { fs.unlinkSync(fileFor(sessionId, dir)); return true; } catch (_) { return false; }
}

module.exports = {
  SCHEMA, AGENTS, STATES, SOURCES, REQUIRED,
  stateDir, sanitizeSessionId, fileFor,
  buildRecord, writeStatus, validateRecord, readSnapshots, readStatus, removeStatus
};
