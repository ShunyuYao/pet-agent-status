'use strict';
// Hidden real-host E2E harness. The staged panel/lib/tool bytes are copied unchanged.
// Only manifest.entry.tool selects a test fixture that injects external file sources,
// installed-App discovery, terminal process inventory and OS command execution.
// Production collector/state-files/aggregate/rendering and the actual Electron SDK,
// preload, events, scheduler and persistent storage are never mocked.
// Native focus/OS launch behavior is outside this harness; command intentions are logged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_HOST = '/Users/shunyu/projects/desktop_pet/桌宠测试版';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label = 'condition', timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? ' — ' + lastError.message : ''}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

async function start(options = {}) {
  const pluginDir = path.resolve(options.pluginDir || path.join(__dirname, '..', '..'));
  const hostDir = path.resolve(options.hostDir || DEFAULT_HOST);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-hidden-'));
  const artifacts = path.resolve(options.artifactDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-evidence-')));
  const paths = {
    root, artifacts, userData: path.join(root, 'user-data'), stage: path.join(root, 'stage'),
    state: path.join(root, 'state'), codex: path.join(root, 'codex'),
    claudeApp: path.join(root, 'claude-app'), workbuddy: path.join(root, 'workbuddy'),
    applications: path.join(root, 'applications'), apps: path.join(root, 'apps.json'),
    actions: path.join(artifacts, 'actions.jsonl'), log: path.join(artifacts, 'host.log'),
    rendererLog: path.join(artifacts, 'renderer.jsonl'),
    claudeSettings: path.join(root, 'claude-settings.json'), codexHooks: path.join(root, 'codex-hooks.json'),
    terminalTitles: path.join(root, 'terminal-titles.txt'), psTree: path.join(root, 'ps-tree.json'),
    fixture: path.join(root, 'fixture.json')
  };
  paths.stateDir = paths.state;
  for (const dir of [artifacts, paths.userData, paths.state, paths.codex, paths.claudeApp, paths.workbuddy, paths.applications]) fs.mkdirSync(dir, { recursive: true });
  const excluded = new Set(['.git', 'node_modules', 'tests']);
  fs.cpSync(pluginDir, paths.stage, { recursive: true, filter: (source) => !excluded.has(path.basename(source)) && !fs.lstatSync(source).isSymbolicLink() });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'collector-entry.js'), path.join(paths.stage, 'e2e-fixture.js'));
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.stage, 'manifest.json'), 'utf8'));
  manifest.entry.tool = 'e2e-fixture.js';
  writeJson(path.join(paths.stage, 'manifest.json'), manifest);
  const grants = { [manifest.id]: { granted: manifest.permissions.slice(), version: manifest.version, at: Date.now() } };
  writeJson(path.join(paths.userData, 'config.json'), { plugins: { grants } });
  writeJson(paths.apps, options.apps || ['claude', 'codex', 'workbuddy']);
  writeJson(paths.psTree, [
    { pid: 990001, ppid: 1, tty: '??', comm: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
    { pid: 990002, ppid: 990001, tty: 'ttys901', comm: '/bin/zsh' },
    { pid: 990003, ppid: 990001, tty: 'ttys902', comm: '/bin/zsh' },
    { pid: 990004, ppid: 990001, tty: 'ttys903', comm: '/bin/zsh' }
  ]);
  for (const file of [paths.claudeSettings, paths.codexHooks]) writeJson(file, {});
  for (const file of [paths.actions, paths.log, paths.rendererLog, paths.terminalTitles]) fs.writeFileSync(file, '');
  writeJson(paths.fixture, paths);
  const sourceHash = {};
  function hashTree(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(relative, entry.name), full = path.join(dir, entry.name);
      if (entry.isDirectory()) hashTree(full, name);
      else if (entry.isFile()) sourceHash[name] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }
  for (const folder of ['panel', 'lib', 'tool', 'assets']) hashTree(path.join(paths.stage, folder), folder);
  writeJson(path.join(artifacts, 'staged-source-sha256.json'), sourceHash);
  const errors = [], connections = new Map();
  let app, stopping = false, cdpPort, panelReadyLogOffset = 0;
  const harness = { paths, errors, waitFor, panel: null, settings: null, pet: null };
  const rendererEvent = (target, message) => {
    if (message.method === 'Runtime.exceptionThrown' || (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') || (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')) {
      const item = { at: Date.now(), target: target.url, ...message };
      errors.push(item);
      fs.appendFileSync(paths.rendererLog, JSON.stringify(item) + '\n');
    }
  };
  async function connect(target) {
    if (!target) throw new Error('Missing CDP target');
    if (connections.has(target.id)) return connections.get(target.id);
    if (decodeURIComponent(target.url).includes(manifest.id + '/panel/panel.html')) {
      // Each new panel has its own sandbox preload. Attaching Runtime while it
      // initializes can produce binding.startupData=null (recorded in 0.12.2).
      // Consume the next production panel-ready event from this launch's host log
      // before attaching; no sleeps, synthetic state, or suppressed console errors.
      const marker = '[plugins] 事件 agent-status:panel-ready ← ' + manifest.id;
      await waitFor(() => {
        const log = fs.readFileSync(paths.log, 'utf8');
        const index = log.indexOf(marker, panelReadyLogOffset);
        if (index < 0) return false;
        panelReadyLogOffset = index + marker.length;
        return true;
      }, 'new panel production ready signal');
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
      } else rendererEvent(target, message);
    };
    socket.onclose = () => { connections.delete(target.id); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP target closed')); } pending.clear(); };
    const connection = {
      close: () => socket.close(),
      send(method, params = {}) { return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      }); }
    };
    connections.set(target.id, connection);
    await connection.send('Runtime.enable');
    await connection.send('Log.enable');
    return connection;
  }
  harness.cdp = async (method, params = {}, target = harness.panel) => (await connect(target)).send(method, params);
  harness.evaluate = async (expression, target = harness.panel) => {
    const result = await harness.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, target);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  harness.targets = async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) });
    return response.json();
  };
  harness.findTarget = async (needle) => (await harness.targets()).find((target) => target.type === 'page' && decodeURIComponent(target.url).includes(needle));
  harness.writeState = (record) => {
    if (!record || !/^[A-Za-z0-9._-]+$/.test(record.sessionId || '')) throw new Error('writeState requires a safe sessionId');
    const file = path.join(paths.state, record.sessionId + '.json');
    writeJson(file + '.tmp', record); fs.renameSync(file + '.tmp', file); return file;
  };
  harness.setApps = (ids) => {
    if (!Array.isArray(ids) || ids.some((id) => !['claude', 'codex', 'workbuddy'].includes(id))) throw new Error('Unknown fixture App');
    writeJson(paths.apps, ids);
  };
  harness.screenshot = async (file, target = harness.panel) => {
    await harness.evaluate('(async()=>{ await document.fonts.ready; await Promise.all([...document.images].map(i=>i.decode())); return true; })()', target);
    const result = await harness.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, target);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64')); return file;
  };
  harness.fireHook = (event, options = {}) => {
    const result = spawnSync(process.execPath, [path.join(paths.stage, 'hooks', 'claude-status-hook.js')], {
      input: JSON.stringify(event), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PET_AGENT_STATUS_DIR: paths.state, PET_AS_TTY: options.tty || '/dev/ttys901', PET_AS_CLAUDE_SETTINGS: paths.claudeSettings, PET_AS_CODEX_HOOKS: paths.codexHooks }
    });
    if (result.status !== 0 || result.error) throw new Error(`Hook failed: ${result.error?.message || result.stderr}`);
    return result;
  };
  async function stopProcess() {
    stopping = true;
    for (const connection of connections.values()) connection.close(); connections.clear();
    if (app && app.pid) {
      const current = app;
      try { process.kill(-current.pid, 'SIGTERM'); } catch (_) { /* already gone */ }
      if (current.exitCode == null && current.signalCode == null) {
        await Promise.race([new Promise((resolve) => current.once('exit', resolve)), delay(2500)]);
      }
      try { process.kill(-current.pid, 'SIGKILL'); } catch (_) { /* group exited */ }
    }
    app = null;
  }
  harness.stop = async () => { await stopProcess(); process.removeListener('exit', emergencyCleanup); fs.rmSync(root, { recursive: true, force: true }); };
  const emergencyCleanup = () => { if (app?.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { /* already gone */ } } };
  process.on('exit', emergencyCleanup);
  async function launch() {
    stopping = false;
    const logOffset = fs.statSync(paths.log).size;
    panelReadyLogOffset = fs.readFileSync(paths.log, 'utf8').length;
    cdpPort = await freePort(); harness.port = cdpPort;
    const executable = path.join(hostDir, 'demo', 'node_modules', '.bin', 'electron');
    const env = { ...process.env, PET_E2E_TEST: '1', PET_E2E_BACKGROUND: '1', PET_E2E_HIDDEN: '1', PET_USERDATA_DIR: paths.userData, PET_AGENT_STATUS_DIR: paths.state, PET_AS_E2E_FIXTURE: paths.fixture, PET_AS_WORKBUDDY_HOME: paths.workbuddy, PET_AS_CLAUDE_APP_SUPPORT: paths.claudeApp, PET_AS_CLAUDE_SETTINGS: paths.claudeSettings, PET_AS_CODEX_HOOKS: paths.codexHooks };
    delete env.ELECTRON_RUN_AS_NODE; delete env.REACT_SETTINGS_URL;
    app = spawn(executable, ['.', `--remote-debugging-port=${cdpPort}`], { cwd: path.join(hostDir, 'demo'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    harness.pid = app.pid;
    for (const stream of [app.stdout, app.stderr]) stream.on('data', (data) => fs.appendFileSync(paths.log, data));
    app.on('error', (error) => fs.appendFileSync(paths.log, error.stack + '\n'));
    app.on('exit', (code, signal) => { if (!stopping) fs.appendFileSync(paths.log, `Host exited: ${code}/${signal}\n`); });
    // Do not enable Runtime during Electron's sandbox preload initialization.
    // Observe this launch's renderer-ready marker first; retain all console errors.
    await waitFor(() => fs.readFileSync(paths.log).subarray(logOffset).toString().includes('[renderer] frames loaded '), 'host renderer initialized', 45000);
    const startupLog = fs.readFileSync(paths.log).subarray(logOffset).toString();
    if (/sandboxed_renderer\.bundle\.js script failed|TypeError: Cannot destructure property 'preloadScripts'/.test(startupLog)) {
      throw new Error('Host sandbox preload failed before CDP connection; see host.log');
    }
    harness.pet = await waitFor(() => harness.findTarget('demo/index.html'), 'hidden host CDP', 45000);
    await harness.evaluate("window.petAPI.openSettings('plugins')", harness.pet);
    harness.settings = await waitFor(() => harness.findTarget('settings.html'), 'settings target');
    await waitFor(() => harness.evaluate("typeof window.settings?.pluginsList === 'function'", harness.settings), 'settings bridge');
    const installed = await harness.evaluate('window.settings.pluginsList()', harness.settings);
    if (!installed.some((plugin) => plugin.id === manifest.id)) {
      const result = await harness.evaluate(`window.settings.pluginsInstallPath(${JSON.stringify(paths.stage)})`, harness.settings);
      if (!result?.ok) throw new Error('Plugin installation failed: ' + JSON.stringify(result));
    }
    await waitFor(async () => (await harness.evaluate('window.settings.pluginsList()', harness.settings)).some((plugin) => plugin.id === manifest.id && plugin.status === 'active'), 'plugin active', 45000);
    await harness.evaluate(`window.settings.pluginsTogglePanel(${JSON.stringify(manifest.id)})`, harness.settings);
    harness.panel = await waitFor(() => harness.findTarget(manifest.id + '/panel/panel.html'), 'panel target');
    await waitFor(() => harness.evaluate("document.readyState === 'complete' && !!window.pet && !!document.getElementById('gear')"), 'panel loaded');
    await harness.evaluate(`new Promise((resolve, reject) => {
      let received = false;
      window.pet.events.on('agent-status:snapshot', async () => {
        if (received) return; received = true;
        try {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode()));
          resolve(true);
        } catch (error) { reject(error); }
      });
    })`);
    // Hidden windows can suppress requestAnimationFrame indefinitely. Screenshot requests
    // force Chromium to paint without showing/focusing a native window.
    await harness.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    for (const target of await harness.targets()) if (target.type === 'page') await connect(target);
    return harness;
  }
  harness.restart = async () => { await stopProcess(); return launch(); };
  try { return await launch(); } catch (error) { await harness.stop(); error.message += `\nEvidence: ${artifacts}`; throw error; }
}

module.exports = { start, waitFor };
