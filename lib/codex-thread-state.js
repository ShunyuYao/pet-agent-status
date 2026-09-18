'use strict';
// Read only metadata for already identified App threads. Never read message/error columns.
// Internal storage: unavailable SQLite/schema/locks degrade to empty metadata.
const path = require('path');
const os = require('os');
const { isValidThreadId } = require('./codex-deeplink');
const { readRolloutIdentity } = require('./codex-rollout-activity');
function loadSqlite() { try { return require('node:sqlite'); } catch (_) { return null; } }
function hasSubagentSource(source) {
  try {
    const value = JSON.parse(source)?.subagent;
    return (typeof value === 'string' && value.length > 0)
      || (value != null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
  } catch (_) { return false; }
}
function createCodexThreadState(deps = {}) {
  const home = deps.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sqlite = 'sqlite' in deps ? deps.sqlite : loadSqlite();
  // Source identity is immutable for a thread ID. Remember only positive evidence;
  // missing/unknown metadata is retried, and a temporary DB failure cannot undo it.
  const subagents = new Set();
  function read(ids) {
    const out = new Map();
    const valid = [...new Set(ids || [])].filter(isValidThreadId);
    for (const id of valid) if (subagents.has(id)) out.set(id, { isSubagent: true });
    if (!sqlite || !valid.length) return out;
    function withDb(file, consume) {
      let db;
      try {
        db = new sqlite.DatabaseSync(path.join(home, file), { readOnly: true });
        consume(db);
      } catch (_) { /* optional storage must not interrupt collection */ }
      finally { try { if (db) db.close(); } catch (_) { /* best effort */ } }
    }
    function query(db, sql, consume, lookupId = id => id) {
      try {
        const stmt = db.prepare(sql);
        for (const id of valid) {
          const row = stmt.get(lookupId(id));
          if (row) { const entry = out.get(id) || {}; consume(entry, row); out.set(id, entry); }
        }
      } catch (_) { /* optional storage must not interrupt collection */ }
    }
    withDb('state_5.sqlite', db => {
      // Select only a fixed allowlist. Older schemas may lack identity columns;
      // that must not disable the existing rollout path or turn-completion barrier.
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
      const fields = ['rollout_path', 'source', 'thread_source'].filter(field => columns.has(field));
      if (fields.length) query(db, `SELECT ${fields.join(',')} FROM threads WHERE id=?`, (entry, row) => {
        if (typeof row.rollout_path === 'string') entry.rolloutPath = row.rollout_path;
        if (hasSubagentSource(row.source) || ['subagent', 'guardian_review'].includes(row.thread_source)) entry.isSubagent = true;
      });
      // These are explicit spawn edges, not ordinary user-created thread forks.
      query(db, 'SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges WHERE child_thread_id=?', (entry, row) => {
        if (isValidThreadId(row.parent_thread_id) && row.parent_thread_id !== row.child_thread_id) entry.isSubagent = true;
      });
    });
    // Resumed tasks retain their App ID while the turn history can move to the
    // runtime ID in the indexed filename. Do not reuse the old terminal turn.
    withDb('thread_history_1.sqlite', db => query(db, 'SELECT turn_id,status,started_at,completed_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1', (entry, row) => {
      // Preserve an explicit unknown status as a veto, never as running evidence.
      if (!isValidThreadId(row.turn_id)) return;
      entry.turn = { id: row.turn_id, status: row.status,
        startedAt: Number.isFinite(row.started_at) ? row.started_at * 1000 : null,
        completedAt: Number.isFinite(row.completed_at) ? row.completed_at * 1000 : null };
    }, id => readRolloutIdentity(home, out.get(id)?.rolloutPath, id)?.runtimeId || id));
    for (const [id, entry] of out) if (entry.isSubagent === true) subagents.add(id);
    return out;
  }
  return { read };
}
module.exports = { createCodexThreadState };
