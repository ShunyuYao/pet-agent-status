'use strict';
// Observed Codex storage shapes, metadata only; no conversation columns or content.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const PARENT = '00000000-0000-4000-8000-000000000201';
const CHILD = '00000000-0000-4000-8000-000000000202';
const GUARDIAN = '00000000-0000-4000-8000-000000000203';
const TURN = '00000000-0000-4000-8000-000000000301';
const NEXT = '00000000-0000-4000-8000-000000000302';
const childSource = (parent = PARENT) => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/child' } } });
function createData(home) {
  fs.mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT, thread_source TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT, status TEXT)');
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, rollout_ordinal INTEGER, PRIMARY KEY(thread_id,turn_id))');
  return {
    db,
    thread(id, source = 'vscode', kind = 'user') {
      db.prepare('INSERT INTO threads(id,source,thread_source) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,thread_source=excluded.thread_source').run(id, source, kind);
    },
    edge(child = CHILD, parent = PARENT) { db.prepare('INSERT INTO thread_spawn_edges VALUES (?,?,?)').run(parent, child, 'open'); },
    rollout(id, at) {
      const day = new Date(at);
      const dir = path.join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-fixture-${id}.jsonl`);
      fs.appendFileSync(file, '{}\n'); fs.utimesSync(file, at / 1000, at / 1000);
      db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file, id);
    },
    turn(id, status, at, turn = TURN, ordinal = 1) {
      history.prepare('INSERT OR REPLACE INTO thread_turns VALUES (?,?,?,?,?,?)').run(id, turn, status, Math.floor(at / 1000), status === 'inProgress' ? null : Math.floor(at / 1000), ordinal);
    },
    close() { db.close(); history.close(); }
  };
}
module.exports = { createData, childSource, PARENT, CHILD, GUARDIAN, TURN, NEXT };
