'use strict';
// Read only metadata for already identified App threads. Never read message/error columns.
// Internal storage: unavailable SQLite/schema/locks degrade to empty metadata.
const path = require('path');
const os = require('os');
const { isValidThreadId } = require('./codex-deeplink');
function loadSqlite() { try { return require('node:sqlite'); } catch (_) { return null; } }
function createCodexThreadState(deps = {}) {
  const home = deps.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sqlite = 'sqlite' in deps ? deps.sqlite : loadSqlite();
  function read(ids) {
    const out = new Map();
    const valid = [...new Set(ids || [])].filter(isValidThreadId);
    if (!sqlite || !valid.length) return out;
    function query(file, sql, consume) {
      let db;
      try {
        db = new sqlite.DatabaseSync(path.join(home, file), { readOnly: true });
        const stmt = db.prepare(sql);
        for (const id of valid) {
          const row = stmt.get(id);
          if (row) { const entry = out.get(id) || {}; consume(entry, row); out.set(id, entry); }
        }
      } catch (_) { /* optional storage must not interrupt collection */ }
      finally { try { if (db) db.close(); } catch (_) { /* best effort */ } }
    }
    query('thread_history_1.sqlite', 'SELECT turn_id,status,started_at,completed_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1', (entry, row) => {
      // Preserve an explicit unknown status as a veto, never as running evidence.
      if (!isValidThreadId(row.turn_id)) return;
      entry.turn = { id: row.turn_id, status: row.status,
        startedAt: Number.isFinite(row.started_at) ? row.started_at * 1000 : null,
        completedAt: Number.isFinite(row.completed_at) ? row.completed_at * 1000 : null };
    });
    query('state_5.sqlite', 'SELECT rollout_path FROM threads WHERE id=?', (entry, row) => {
      if (typeof row.rollout_path === 'string') entry.rolloutPath = row.rollout_path;
    });
    return out;
  }
  return { read };
}
module.exports = { createCodexThreadState };
