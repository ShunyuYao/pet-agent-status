'use strict';
// Compatibility entry for existing npm/CI callers. The old PATH wrappers for ps
// and osascript are replaced by hidden-host.js's shared, isolated collector fixture.
// Child tests now own their terminal IDs and assert recorded OS command intentions;
// this wrapper must not overwrite PATH, HOME, CODEX_HOME or the child's fixture TTY.
// Usage: node tests/e2e/with-terminal-fixture.js tests/e2e/dismiss-e2e.js
const path = require('path');
const { spawnSync } = require('child_process');

const requested = process.argv[2];
const allowed = new Set(['dismiss-e2e.js', 'waiting-accuracy-e2e.js']);
if (!requested || !allowed.has(path.basename(requested))) {
  throw new Error('Expected dismiss-e2e.js or waiting-accuracy-e2e.js');
}
const test = path.join(__dirname, path.basename(requested));
const result = spawnSync(process.execPath, [test, ...process.argv.slice(3)], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status == null ? 1 : result.status;
