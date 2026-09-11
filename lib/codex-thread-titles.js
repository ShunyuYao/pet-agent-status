'use strict';
// Codex 线程标题解析器：threadId → AI 生成的会话标题。
//
// 事实依据（2026-09-11 本机实测，详见 fixtures/codex-ipc-facts.md §9）：
// Codex App 与 CLI 共用 ~/.codex 的线程库——实录 App 任务的 conversationId 在
// 两处本地存储里都能查到同一条 AI 生成标题：
//   ① `~/.codex/sqlite/codex-dev.db` 表 `local_thread_catalog`（thread_id → display_title），
//      由 App 的 app-server 维护，App 在跑时**当天更新**（较新）；
//   ② `~/.codex/session_index.jsonl` 每行 `{id, thread_name, updated_at}`（更新节奏不明，偏旧）。
// 两处都是**内部存储、无公开稳定性承诺**（同 IPC/深链接，facts §7）——所以全部失败路径
// 静默降级为「查不到」，上层回落 hook 兜底标题/品牌名，绝不因此打死采集。
//
// 只读纪律：① sqlite 一律 readOnly 打开、查完即关，不持有用户库的 fd；
// ② 本模块绝不创建/修改 ~/.codex 下任何文件；③ 测试必须注入 codexHome 指向临时目录。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 1000;   // 标题不是实时数据，30s 一刷足够（每 tick 查缓存 Map）

// node:sqlite 是 Node 22.5+ 才有的内建模块（宿主 Electron 43 自带；老环境没有）。
// 拿不到就只剩 session_index.jsonl 一条路——功能降级不报错。
function loadSqlite() {
  try { return require('node:sqlite'); } catch (_) { return null; }
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * @param {object} [deps] { codexHome, now, ttlMs, sqlite }（测试全量注入，绝不碰真 ~/.codex）
 */
function createCodexThreadTitles(deps) {
  const d = deps || {};
  const home = d.codexHome || defaultCodexHome();
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const ttl = Number.isFinite(d.ttlMs) ? d.ttlMs : DEFAULT_TTL_MS;
  const sqlite = 'sqlite' in d ? d.sqlite : loadSqlite();

  const dbFile = path.join(home, 'sqlite', 'codex-dev.db');
  const indexFile = path.join(home, 'session_index.jsonl');

  let cache = new Map();     // threadId → title
  let cachedAt = -Infinity;
  let indexMtime = 0;
  let indexTitles = new Map();

  // ① catalog：整表拉 id→标题（本机实测 <100 行，全量比增量简单可靠）
  function readCatalog() {
    const out = new Map();
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') return out;
    let db = null;
    try {
      db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      const rows = db.prepare('SELECT thread_id, display_title FROM local_thread_catalog').all();
      for (const r of rows) {
        if (typeof r.thread_id === 'string' && typeof r.display_title === 'string' && r.display_title !== '') {
          out.set(r.thread_id, r.display_title);
        }
      }
    } catch (_) { /* 文件不存在/表结构变了/被锁：内部存储本就无承诺，静默降级 */ }
    try { if (db) db.close(); } catch (_) { /* close 失败也不留 fd 引用 */ }
    return out;
  }

  // ② session_index.jsonl：按 mtime 缓存，没变不重读（该文件可能长到几百 KB）
  function readIndex() {
    let mtime = 0;
    try { mtime = fs.statSync(indexFile).mtimeMs; } catch (_) { return new Map(); }
    if (mtime === indexMtime && indexTitles.size) return indexTitles;
    const out = new Map();
    try {
      const lines = fs.readFileSync(indexFile, 'utf8').split('\n');
      for (const line of lines) {
        if (line === '') continue;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj.id === 'string' && typeof obj.thread_name === 'string' && obj.thread_name !== '') {
            out.set(obj.id, obj.thread_name);   // 顺序读、后行覆盖前行 = 取最新
          }
        } catch (_) { /* 单行坏了跳过，不废整个索引 */ }
      }
    } catch (_) { return new Map(); }
    indexMtime = mtime;
    indexTitles = out;
    return out;
  }

  function refresh(at) {
    const merged = readIndex();                      // 旧源打底
    for (const [id, title] of readCatalog()) merged.set(id, title);   // catalog 较新，覆盖
    cache = merged;
    cachedAt = at;
  }

  /** threadId → 标题；查不到返回 null（上层自行回落，绝不造假标题） */
  function lookup(threadId) {
    if (typeof threadId !== 'string' || threadId === '') return null;
    const at = now();
    if (at - cachedAt >= ttl) {
      try { refresh(at); } catch (_) { cachedAt = at; /* 本轮失败沿用旧缓存，TTL 后再试 */ }
    }
    return cache.get(threadId) || null;
  }

  return { lookup, get size() { return cache.size; } };
}

module.exports = { createCodexThreadTitles, DEFAULT_TTL_MS };
