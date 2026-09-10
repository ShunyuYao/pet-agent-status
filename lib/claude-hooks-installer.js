'use strict';
// 「一键接入 / 移除 Claude Code 钩子」：合并写入用户的 settings.json。
//
// 这是本插件唯一会改用户 ~/.claude/settings.json 的地方（README 权限披露第 2 行）。
// 三条硬要求（备份首份不覆盖、保留用户已有条目、卸载只摘自己那条 command）的实现
// 在 lib/hooks-installer-core.js —— 与 Codex 安装器共用同一份，避免两边分叉。
// 本文件只负责 Claude Code 特有的部分：配置路径、事件集合、hook 脚本、标记字段名。

const os = require('os');
const path = require('path');

const core = require('./hooks-installer-core.js');
const { HOOKED_EVENTS } = require('./claude-events.js');

const BACKUP_SUFFIX = core.BACKUP_SUFFIX;
// 写进 settings.json 的标记字段，方便用户在配置里一眼认出这几条是谁加的
const MARKER = 'pet-agent-status';
// 记在本插件条目里的「这个事件 key 是 install 现造的」标记。
// 卸载时据此决定该不该把 key 一并收回。
const CREATED_KEY = 'petAgentStatusCreatedKey';
// 同理，记「hooks 这个容器本身是 install 现造的」。不能从「key 是不是全是本插件造的」
// 反推容器归属：用户留一个空 `hooks: {}` 时，7 个 key 全是本插件造的，反推会得出
// 「容器也是本插件的」而把用户的空容器删掉。归属只能显式记录，不能靠内容猜。
const CREATED_HOOKS = 'petAgentStatusCreatedHooks';

function settingsPath() {
  const override = process.env.PET_AS_CLAUDE_SETTINGS;
  if (override) return override;
  return path.join(os.homedir(), '.claude', 'settings.json');
}

const impl = core.createInstaller({
  configPath: settingsPath,
  hookScript: path.join(__dirname, '..', 'hooks', 'claude-status-hook.js'),
  hookedEvents: HOOKED_EVENTS,
  marker: MARKER,
  createdKeyFlag: CREATED_KEY,
  createdHooksFlag: CREATED_HOOKS
});

// 本模块对外沿用 `settingsFile` 这个参数名（内核用的是通用的 `configFile`）。
// 调用方与既有测试都写的是 settingsFile，不因内部重构而改口。
function withFile(options) {
  if (!options) return options;
  const out = Object.assign({}, options);
  if (options.settingsFile && !out.configFile) out.configFile = options.settingsFile;
  return out;
}

module.exports = {
  BACKUP_SUFFIX, MARKER, CREATED_KEY, CREATED_HOOKS,
  settingsPath,
  hookCommand: impl.hookCommand,
  readSettings: core.readConfig,
  writeSettings: core.writeConfig,
  install: (options) => impl.install(withFile(options)),
  uninstall: (options) => impl.uninstall(withFile(options)),
  isInstalled: (options) => impl.isInstalled(withFile(options))
};
