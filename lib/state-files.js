'use strict';
// 状态文件读写（PROTOCOL.md schema:2 的唯一实现处，兼容读取 schema:1）。
// 只碰状态目录：默认 ~/.local/state/pet-agent-status/，测试经 PET_AGENT_STATUS_DIR 覆盖。

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA = 2;
const AGENTS = ['claude-code', 'codex', 'workbuddy'];
const STATES = ['running', 'waiting', 'done', 'ended'];
const SOURCES = ['hook', 'ipc', 'reconcile', 'poll'];
const FORMS = ['cli', 'app'];
// 标题上限（码点计，与宿主徽标同一计数口径）。这是「不采集会话正文」红线的显式让步边界：
// 标题只许首行 + 截断，永远不落完整 prompt（见 PROTOCOL.md「title 字段」）。
const TITLE_MAX = 64;
// 活跃组：面板对这两态显 mm:ss 计时。`since` 只在组内继承（见 PROTOCOL.md「since 字段」）。
const ACTIVE_STATES = ['running', 'waiting'];
const TURN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// 标题清洗：只取首个非空行，压掉连续空白，按码点截断到 TITLE_MAX。
// 产不出合法标题（非字符串/全空白）返回 null —— 调用方据此不写该字段，不造空标题。
function normalizeTitle(raw) {
  if (typeof raw !== 'string') return null;
  const line = raw.split('\n').map((s) => s.trim()).find((s) => s !== '') || '';
  const collapsed = line.replace(/\s+/g, ' ');
  if (collapsed === '') return null;
  const points = Array.from(collapsed);
  return points.length > TITLE_MAX ? `${points.slice(0, TITLE_MAX).join('')}…` : collapsed;
}

// 组装一条符合 schema:2 的记录。调用方给什么就写什么，缺省项补协议要求的 null。
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
  if (typeof input.turnId === 'string' && TURN_ID_RE.test(input.turnId)) rec.turnId = input.turnId;
  rec.source = SOURCES.includes(input.source) ? input.source : 'hook';
  // 选填形态字段（schema:1 加法，见 PROTOCOL.md 字段表）：非法值不写，不造假形态
  if (FORMS.includes(input.form)) rec.form = input.form;
  // 选填标题（schema:1 加法）：清洗失败不写，绝不落完整正文
  const title = normalizeTitle(input.title);
  if (title != null) rec.title = title;
  return rec;
}

// 原子写：同目录临时文件 → rename 覆盖（同分区，rename 保证读者永远看到完整 JSON）。
// 临时文件名以 .tmp 结尾（不是 .json），因此天然落在 readSnapshots 的 .json 过滤之外；
// 读侧不得靠前缀识别临时文件——`.tmp-xxx` 是协议允许的合法 sessionId，靠前缀会误杀真会话。
// `since`（活跃段起点）的维护规则：新记录在活跃组内时——前一记录也在活跃组就继承
// （工具调用刷心跳、批准后 waiting→running 都**不**重置计时），否则从本次 ts 起算；
// 离开活跃组（done/ended）不写该字段。判据全在这里，hook/ingest 调用方不各自算。
function carrySince(rec, prev) {
  if (!ACTIVE_STATES.includes(rec.state)) return;
  if (prev && ACTIVE_STATES.includes(prev.state) && !(rec.turnId && prev.turnId && rec.turnId !== prev.turnId)) {
    const inherited = Number.isFinite(prev.since) ? prev.since : prev.ts;
    if (Number.isFinite(inherited)) { rec.since = inherited; return; }
  }
  rec.since = rec.ts;
}

function writeStatus(input, dir) {
  const target = dir || stateDir();
  fs.mkdirSync(target, { recursive: true });
  const rec = buildRecord(input);
  // 标题是会话的**名字**不是「当前在干嘛」：首个产生标题的事件（首条 prompt）定名，
  // 之后的事件覆盖写状态时不许把名字冲掉、也不随后续 prompt 改名（稳定的名字才认得出行）。
  const existing = readStatus(rec.sessionId, target);
  if (existing && typeof existing.title === 'string' && existing.title !== '') rec.title = existing.title;
  carrySince(rec, existing);
  const file = path.join(target, `${rec.sessionId}.json`);
  const tmp = path.join(target, `.tmp-${rec.sessionId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`);
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
  if (obj.schema !== 1 && obj.schema !== SCHEMA) {
    return Number.isFinite(obj.schema) && obj.schema > SCHEMA ? 'schema-too-new' : 'schema-mismatch';
  }
  if (obj.turnId !== undefined && (typeof obj.turnId !== 'string' || !TURN_ID_RE.test(obj.turnId))) return 'bad-turnId';
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
  if ('form' in obj && !FORMS.includes(obj.form)) return 'bad-form';
  if ('title' in obj && (typeof obj.title !== 'string' || obj.title === '')) return 'bad-title';
  if ('since' in obj && !Number.isFinite(obj.since)) return 'bad-since';
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
    if (!name.endsWith('.json')) continue;
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
    // validateRecord 合法时返回 null、不合法时返回错误字符串 —— 判据是「有没有错误」，
    // 别写成 validateRecord(x) ? x : null（正好反了：合法的被丢掉、损坏的被放行）。
    return validateRecord(parsed) === null ? parsed : null;
  } catch (_) {
    return null;
  }
}

function removeStatus(sessionId, dir) {
  try { fs.unlinkSync(fileFor(sessionId, dir)); return true; } catch (_) { return false; }
}

module.exports = {
  SCHEMA, AGENTS, STATES, SOURCES, FORMS, ACTIVE_STATES, REQUIRED, TITLE_MAX,
  stateDir, sanitizeSessionId, fileFor, normalizeTitle,
  buildRecord, writeStatus, validateRecord, readSnapshots, readStatus, removeStatus
};
