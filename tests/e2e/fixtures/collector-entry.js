'use strict';
// Staged test entry only. Production collector, aggregation, panel and SDK remain intact.
// Only external files/app discovery and OS process execution use isolated fixtures.
const fs = require('fs');
const path = require('path');
const root = __dirname;
const { createCollector } = require(path.join(root, 'tool', 'index.js'));
const { createAppLauncher, SUPPORTED_APPS } = require(path.join(root, 'lib', 'app-launcher.js'));
const { createClaudeDesktopSessions } = require(path.join(root, 'lib', 'claude-desktop-sessions.js'));
const { createWorkbuddySource } = require(path.join(root, 'lib', 'workbuddy-source.js'));
const { createTerminalTitles } = require(path.join(root, 'lib', 'terminal-titles.js'));
const fixture = JSON.parse(fs.readFileSync(process.env.PET_AS_E2E_FIXTURE, 'utf8'));
let collector;
const recordAction = (action) => fs.appendFileSync(fixture.actions, JSON.stringify({ at: Date.now(), ...action }) + '\n');
const execFile = (command, args) => { recordAction({ command, args }); return ''; };

async function activate(pet) {
  await pet.storage.set('codexIpcEnabled', false);
  collector = createCollector({
    dir: fixture.state,
    codexHome: fixture.codex,
    codexIpcPath: path.join(fixture.codex, 'ipc', 'ipc.sock'),
    settingsFile: fixture.claudeSettings,
    codexHooksFile: fixture.codexHooks,
    claudeDesktop: createClaudeDesktopSessions({ appSupportDir: fixture.claudeApp }),
    workbuddySource: createWorkbuddySource({ home: fixture.workbuddy, dir: fixture.state }),
    terminalTitles: createTerminalTitles({ execFile: () => fs.readFileSync(fixture.terminalTitles, 'utf8') }),
    psTree: JSON.parse(fs.readFileSync(fixture.psTree, 'utf8')),
    jumpRunner: (script) => { recordAction({ command: 'osascript', args: ['-e', script] }); return { ok: true }; },
    execFile,
    createAppLauncher: ({ now }) => {
      const launcher = createAppLauncher({
        now,
        probe: (bundleId) => {
          const ids = JSON.parse(fs.readFileSync(fixture.apps, 'utf8'));
          const app = SUPPORTED_APPS.find((candidate) => candidate.bundleId === bundleId);
          return app && ids.includes(app.id) ? path.join(fixture.applications, app.id + '.app') : null;
        },
        execFile
      });
      const detect = launcher.detect;
      let previous;
      launcher.detect = (options) => {
        const current = fs.readFileSync(fixture.apps, 'utf8');
        if (current !== previous) { launcher.invalidate(); previous = current; }
        return detect(options);
      };
      return launcher;
    }
  });
  await collector.start(pet);
  return collector;
}

module.exports = { activate, deactivate: async (pet) => { if (collector) await collector.stop(pet); } };
