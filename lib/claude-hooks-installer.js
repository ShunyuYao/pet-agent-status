'use strict';
// 「一键接入 / 移除 Claude Code 钩子」：合并写入用户的 settings.json。
//
// 这是本插件唯一会改用户 ~/.claude/settings.json 的地方（README 权限披露第 2 行）。
// 三条硬要求：写前备份、保留用户已有条目、卸载只摘自己那条。
// 自己的条目靠 command 里的绝对脚本路径识别（marker 字段会被 Claude Code 当未知字段，
// 但用户手改配置时容易丢，所以判定以 command 为准，marker 只做冗余标注）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const { HOOKED_EVENTS } = require('./claude-events.js');

const BACKUP_SUFFIX = '.bak-pet-agent-status';
// 写进 settings.json 的标记字段，方便用户在配置里一眼认出这几条是谁加的
const MARKER = 'pet-agent-status';

function settingsPath() {
  const override = process.env.PET_AS_CLAUDE_SETTINGS;
  if (override) return override;
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// settings.json 里的 command 由 Claude Code 交给 shell 执行，路径含空格必须引起来。
// 宿主的插件落地目录在 `~/Library/Application Support/吐梨邦/plugins/` 之下（含空格），
// 裸拼会让 shell 把路径切成两个参数 → hook 以 MODULE_NOT_FOUND 退出并向 stderr 吐堆栈，
// 正好违反「绝不打扰会话」的初衷。用单引号包裹（POSIX 下单引号内除 `'` 外一律字面量），
// 路径自身含单引号时按 '\'' 惯例转义。
function shellQuote(s) {
  return `'${String(s).split("'").join("'\\''")}'`;
}

// hook 脚本的绝对路径。插件目录会随安装位置变，所以每次现算，不写死。
function hookCommand() {
  const script = path.join(__dirname, '..', 'hooks', 'claude-status-hook.js');
  return `${shellQuote(process.execPath)} ${shellQuote(script)}`;
}

// 读现有配置。文件不存在 = 空配置；文件损坏则抛（宁可让用户看到报错，也不能把
// 他手写的配置当空文件覆盖掉 —— 那是不可逆的数据丢失）。
function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`settings.json is not a JSON object: ${file}`);
  }
  return parsed;
}

// 条目身份**只认 command**。别拿 MARKER 当身份判据：marker 是给人看的标注，
// 若按 marker 认领，卸载会连带删掉「同样带 marker 但 command 指向别处」的条目
// （多插件目录并存、或用户手抄了一条时就会踩到）。command 才是唯一真身份。
function isOurs(entry, command) {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  return hooks.some((h) => h && h.command === command);
}

// 原子写：同目录 tmp + rename，理由同 state-files.js —— 半截 settings.json 会让
// Claude Code 起不来，这是用户配置，比状态文件更输不起。
function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 清理失败无所谓 */ }
    throw err;
  }
}

// 备份原文件。只在原文件存在时备份，且**已存在的备份绝不覆盖**。
//
// 备份的唯一用途是「回滚到本插件动手之前」。若每次 install/uninstall 都刷新备份，
// 第二次点接入就会把备份刷成「已含本插件 7 条钩子」的版本 —— 用户 cp 回去后
// isInstalled 仍为 true，备份丧失全部意义且无从察觉。首份即是接入前原文，保住它。
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = file + BACKUP_SUFFIX;
  if (fs.existsSync(dest)) return dest; // 首份不覆盖
  fs.copyFileSync(file, dest);
  return dest;
}

function ourEntry(command) {
  return { [MARKER]: true, hooks: [{ type: 'command', command }] };
}

function install(options) {
  const file = (options && options.settingsFile) || settingsPath();
  const command = (options && options.command) || hookCommand();
  const settings = readSettings(file);
  const backupFile = backup(file);

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  let added = 0;
  for (const event of HOOKED_EVENTS) {
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // 幂等：已经有我们的条目就不再追加（否则每次点接入都多一条，事件触发 N 次）
    const kept = list.filter((entry) => !isOurs(entry, command));
    kept.push(ourEntry(command));
    if (kept.length !== list.length || list.length === 0) added++;
    settings.hooks[event] = kept;
  }

  writeSettings(file, settings);
  return { file, backupFile, command, events: HOOKED_EVENTS.slice(), added };
}

function uninstall(options) {
  const file = (options && options.settingsFile) || settingsPath();
  const command = (options && options.command) || hookCommand();
  let settings;
  try {
    settings = readSettings(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { file, backupFile: null, removed: 0 };
    throw err;
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    return { file, backupFile: null, removed: 0 };
  }

  const backupFile = backup(file);
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => !isOurs(entry, command));
    removed += list.length - kept.length;
    // 事件下只剩空数组就把 key 删掉，别在用户配置里留空壳
    if (kept.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = kept;
  }
  // hooks 整个空了也删掉，恢复成接入前的样子
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(file, settings);
  return { file, backupFile, removed };
}

// 面板要显示「已接入 ✓ / 一键接入」两种状态，靠这个判定
function isInstalled(options) {
  const file = (options && options.settingsFile) || settingsPath();
  const command = (options && options.command) || hookCommand();
  let settings;
  try { settings = readSettings(file); } catch (_) { return false; }
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  return HOOKED_EVENTS.every((event) => {
    const list = hooks[event];
    return Array.isArray(list) && list.some((entry) => isOurs(entry, command));
  });
}

module.exports = {
  BACKUP_SUFFIX, MARKER,
  settingsPath, hookCommand, readSettings, writeSettings,
  install, uninstall, isInstalled
};
