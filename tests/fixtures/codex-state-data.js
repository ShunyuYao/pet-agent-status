'use strict';
// System storage fixture: only metadata columns; deliberately no conversation content.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const CID = '00000000-0000-4000-8000-000000000091';
const TURN1 = '00000000-0000-4000-8000-000000000101';
const TURN2 = '00000000-0000-4000-8000-000000000102';
function createData(home, id = CID) {
  fs.mkdirSync(home, { recursive: true });
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, rollout_ordinal INTEGER, PRIMARY KEY(thread_id,turn_id))');
  const catalog = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  catalog.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)');
  let file;
  return {
    rollout(at, daysOld = 0) {
      const day = new Date(at - daysOld * 86400000);
      const dir = path.join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `rollout-fixture-${id}.jsonl`);
      fs.writeFileSync(file, '{}\n'); fs.utimesSync(file, at / 1000, at / 1000);
      catalog.prepare('INSERT OR REPLACE INTO threads VALUES (?,?)').run(id, file);
      return file;
    },
    append(at) { fs.appendFileSync(file, '{}\n'); fs.utimesSync(file, at / 1000, at / 1000); },
    turn(turnId, status, startedAt, ordinal = 1, completedAt = null) {
      history.prepare('INSERT OR REPLACE INTO thread_turns VALUES (?,?,?,?,?,?)').run(id, turnId, status, Math.floor(startedAt / 1000), completedAt == null ? null : Math.floor(completedAt / 1000), ordinal);
    },
    close() { history.close(); catalog.close(); }
  };
}
module.exports = { createData, CID, TURN1, TURN2 };
