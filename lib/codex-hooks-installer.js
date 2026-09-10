'use strict';
// 「一键接入 / 移除 Codex CLI 钩子」：合并写入 `$CODEX_HOME/hooks.json`。
//
// 配置路径与文件结构均来自 fixtures/codex-hooks-facts.md 的本机实测
// （codex-cli 0.153.4）：hooks 段与 Claude Code settings.json 同构，故安装/卸载
// 逻辑与 Claude 侧共用 lib/hooks-installer-core.js（备份首份不覆盖、command 粒度摘除、
// 创建归属决定删 key —— 那三条不变量只有一份实现）。本文件只填 Codex 特有的差异。

const os = require('os');
const path = require('path');

const core = require('./hooks-installer-core.js');
const { HOOKED_EVENTS } = require('./codex-events.js');

const BACKUP_SUFFIX = core.BACKUP_SUFFIX;
const MARKER = 'pet-agent-status';
const CREATED_KEY = 'petAgentStatusCreatedKey';
const CREATED_HOOKS = 'petAgentStatusCreatedHooks';

// facts §配置：`$CODEX_HOME/hooks.json`，CODEX_HOME 缺省 `~/.codex`。
// PET_AS_CODEX_HOOKS 是本仓的测试隔离覆盖（PROTOCOL.md 路径覆盖表），优先级最高。
function hooksPath() {
  const override = process.env.PET_AS_CODEX_HOOKS;
  if (override) return override;
  const home = process.env.CODEX_HOME;
  if (home) return path.join(home, 'hooks.json');
  return path.join(os.homedir(), '.codex', 'hooks.json');
}

const impl = core.createInstaller({
  configPath: hooksPath,
  hookScript: path.join(__dirname, '..', 'hooks', 'codex-status-hook.js'),
  hookedEvents: HOOKED_EVENTS,
  marker: MARKER,
  createdKeyFlag: CREATED_KEY,
  createdHooksFlag: CREATED_HOOKS
});

// facts §hook trust：hooks.json 变更后 Codex 交互式 TUI 首启会弹
// 「Hooks need review → Trust all and continue」，信任状态存 `hooks.state`。
// **installer 绝不自动写 hooks.state** —— 那是 Codex 的安全机制，插件替用户点头
// 等于绕过它。接入成功后由面板提示用户「下次启动 Codex 时确认信任」。
// 这个常量只作说明与测试断言用（断言我们没碰这个文件）。
const TRUST_STATE_FILE = 'hooks.state';

function withFile(options) {
  if (!options) return options;
  const out = Object.assign({}, options);
  if (options.hooksFile && !out.configFile) out.configFile = options.hooksFile;
  return out;
}

module.exports = {
  BACKUP_SUFFIX, MARKER, CREATED_KEY, CREATED_HOOKS, TRUST_STATE_FILE,
  hooksPath,
  hookCommand: impl.hookCommand,
  readHooks: core.readConfig,
  writeHooks: core.writeConfig,
  install: (options) => impl.install(withFile(options)),
  uninstall: (options) => impl.uninstall(withFile(options)),
  isInstalled: (options) => impl.isInstalled(withFile(options))
};
