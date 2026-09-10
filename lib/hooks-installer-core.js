'use strict';
// 「一键接入 / 移除钩子」的通用内核：合并写入一个「hooks 段与 Claude Code settings.json
// 同构」的 JSON 配置文件。
//
// 为什么是共用内核而不是给 Codex 抄一份：
// fixtures/codex-hooks-facts.md 实测确认 `$CODEX_HOME/hooks.json` 的 hooks 段与
// Claude Code settings.json 的 hooks 段**结构同构**（`hooks.<Event>[] = {matcher?, hooks:[{type,command}]}`）。
// 这段逻辑背着 US-002 四轮返工换来的三条硬不变量：
//   1. 备份**首份不覆盖**（否则重复接入会把备份刷成「已含钩子」的版本，回滚失效）；
//   2. 摘除粒度 = 身份粒度 = **单条 command**（否则吃掉用户追加进同一分组的命令）；
//   3. 删 key / 删容器的判据是**创建归属**（createdKey/createdHooks），不是「现在空不空」
//      （否则用户原有的 `PreCompact: []` 空数组占位会被静默删掉）。
// 抄一份 = 把这三条 fork 成两份，改一处漏一处，且 Codex 那份从没被这四轮返工检验过。
// 差异（配置路径、事件集合、hook 脚本文件名、marker/标记字段名）全部参数化。

const fs = require('fs');
const path = require('path');

const BACKUP_SUFFIX = '.bak-pet-agent-status';

// settings.json / hooks.json 里的 command 由宿主 CLI 交给 shell 执行，路径含空格必须引起来。
// 宿主的插件落地目录在 `~/Library/Application Support/吐梨邦/plugins/` 之下（含空格），
// 裸拼会让 shell 把路径切成两个参数 → hook 以 MODULE_NOT_FOUND 退出并向 stderr 吐堆栈，
// 正好违反「绝不打扰会话」的初衷。用单引号包裹（POSIX 下单引号内除 `'` 外一律字面量），
// 路径自身含单引号时按 '\'' 惯例转义。
function shellQuote(s) {
  return `'${String(s).split("'").join("'\\''")}'`;
}

// 读现有配置。文件不存在 = 空配置；文件损坏则抛（宁可让用户看到报错，也不能把
// 他手写的配置当空文件覆盖掉 —— 那是不可逆的数据丢失）。
function readConfig(file) {
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
    throw new Error(`hooks config is not a JSON object: ${file}`);
  }
  return parsed;
}

// 原子写：同目录 tmp + rename。半截配置会让宿主 CLI 起不来，这是用户配置，
// 比状态文件更输不起。
function writeConfig(file, data) {
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
// 第二次点接入就会把备份刷成「已含本插件钩子」的版本 —— 用户 cp 回去后
// isInstalled 仍为 true，备份丧失全部意义且无从察觉。首份即是接入前原文，保住它。
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = file + BACKUP_SUFFIX;
  if (fs.existsSync(dest)) return dest; // 首份不覆盖
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * 造一套某个 agent 的安装器。
 * @param {object} spec
 *   spec.configPath()      → 配置文件绝对路径（读环境变量覆盖）
 *   spec.hookScript        → hook 脚本绝对路径
 *   spec.hookedEvents      → 要挂的事件名数组
 *   spec.marker            → 写进条目的人类可读标记字段名
 *   spec.createdKeyFlag    → 「这个事件 key 是我造的」标记字段名
 *   spec.createdHooksFlag  → 「hooks 容器是我造的」标记字段名
 */
function createInstaller(spec) {
  const MARKER = spec.marker;
  const CREATED_KEY = spec.createdKeyFlag;
  const CREATED_HOOKS = spec.createdHooksFlag;
  const HOOKED_EVENTS = spec.hookedEvents;

  // hook 脚本的绝对路径。插件目录会随安装位置变，所以每次现算，不写死。
  function hookCommand() {
    return `${shellQuote(process.execPath)} ${shellQuote(spec.hookScript)}`;
  }

  // 条目身份**只认 command**。别拿 MARKER 当身份判据：marker 是给人看的标注，
  // 若按 marker 认领，卸载会连带删掉「同样带 marker 但 command 指向别处」的条目
  // （多插件目录并存、或用户手抄了一条时就会踩到）。command 才是唯一真身份。
  function isOurs(entry, command) {
    if (!entry || typeof entry !== 'object') return false;
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks.some((h) => h && h.command === command);
  }

  // 从一个分组里只摘掉本插件那一条 command，返回 { entry, removed }。
  //
  // 身份判据是分组内某条 command，那删除粒度就必须也是**那一条 command**，不能是整个分组。
  // `hooks.<Event>[].hooks` 是数组，允许一组里挂多条命令；用户完全可能把自己的命令
  // 追加进本插件写出的那个分组（配置里看着就是同一块，手改时最顺手）。
  // 若按分组删，用户那条会被连带抹掉且毫无提示 —— 这是不可逆的用户配置丢失。
  // entry 为 null 表示这个分组已经没有剩余命令，调用方应整条丢弃。
  function stripOurCommand(entry, command) {
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    const kept = hooks.filter((h) => !(h && h.command === command));
    const removed = hooks.length - kept.length;
    if (removed === 0) return { entry, removed: 0 };
    // 分组里除了我们没别的命令了 —— 整条丢弃，别在用户配置里留空壳分组
    if (kept.length === 0) return { entry: null, removed };
    // 还剩用户自己的命令：保住这个分组，只把我们那条摘掉。
    // 同时清掉 MARKER —— 分组已不再属于本插件，留着会让用户以为整组是插件的。
    const next = {};
    for (const key of Object.keys(entry)) {
      if (key === MARKER || key === CREATED_KEY || key === CREATED_HOOKS) continue;
      next[key] = key === 'hooks' ? kept : entry[key];
    }
    return { entry: next, removed };
  }

  // 从事件列表里摘掉本插件的 command（保住同组内用户自己的命令）。
  // install（幂等去重）与 uninstall 共用同一套摘除逻辑，避免两处粒度将来再次跑偏。
  function stripFromList(list, command) {
    const kept = [];
    let removed = 0;
    let createdKey = false;
    let createdHooks = false;
    for (const entry of list) {
      if (!isOurs(entry, command)) { kept.push(entry); continue; }
      if (entry[CREATED_KEY] === true) createdKey = true;
      if (entry[CREATED_HOOKS] === true) createdHooks = true;
      const res = stripOurCommand(entry, command);
      removed += res.removed;
      if (res.entry !== null) kept.push(res.entry);
    }
    return { list: kept, removed, createdKey, createdHooks };
  }

  // createdKey 表示「这个事件 key 在 install 之前不存在，是本插件现造的」。
  // 只有这种 key 才允许在卸载时连 key 一起收回；用户原有的 key 一律还给用户。
  function ourEntry(command, createdKey, createdHooks) {
    const entry = { [MARKER]: true, hooks: [{ type: 'command', command }] };
    if (createdKey) entry[CREATED_KEY] = true;
    if (createdHooks) entry[CREATED_HOOKS] = true;
    return entry;
  }

  // 上一轮装的条目里带没带某个创建标记 —— 幂等重装时要沿用首次安装的判断，
  // 不能按「本次安装前在不在」重算：那时 key/容器已经被上一次 install 造出来了，
  // 重算必然得出 false，卸载就再也收不回自己造的东西（变成留空壳）。
  function hadFlag(list, command, flag) {
    return list.some((e) => isOurs(e, command) && e[flag] === true);
  }

  function resolve(options, key) {
    return (options && options[key]) || null;
  }

  function fileOf(options) {
    return resolve(options, 'configFile') || spec.configPath();
  }

  function commandOf(options) {
    return resolve(options, 'command') || hookCommand();
  }

  function install(options) {
    const file = fileOf(options);
    const command = commandOf(options);
    const config = readConfig(file);
    const backupFile = backup(file);

    // 用户原本有没有 hooks 这个容器。没有则是本插件现造的，卸载时要连容器一起收回；
    // 有（哪怕是空对象 {}）就是用户的配置内容，卸载后必须原样还回去。
    const hooksExisted = Object.prototype.hasOwnProperty.call(config, 'hooks')
      && config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks);
    if (!hooksExisted) config.hooks = {};

    let added = 0;
    for (const event of HOOKED_EVENTS) {
      const existed = Object.prototype.hasOwnProperty.call(config.hooks, event);
      const list = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
      // 幂等：先摘掉已有的自己（只摘 command 粒度，保住同组内用户的命令）再追加
      // —— 否则每次点接入都多一条，事件触发 N 次。
      const { list: kept, removed } = stripFromList(list, command);
      // 是不是本插件造的：首次安装看原本在不在；重装沿用上次的标记。
      const createdKey = removed > 0 ? hadFlag(list, command, CREATED_KEY) : !existed;
      const createdHooks = removed > 0 ? hadFlag(list, command, CREATED_HOOKS) : !hooksExisted;
      kept.push(ourEntry(command, createdKey, createdHooks));
      if (removed === 0) added++;
      config.hooks[event] = kept;
    }

    writeConfig(file, config);
    return { file, backupFile, command, events: HOOKED_EVENTS.slice(), added, hooksExisted };
  }

  function uninstall(options) {
    const file = fileOf(options);
    const command = commandOf(options);
    let config;
    try {
      config = readConfig(file);
    } catch (err) {
      if (err.code === 'ENOENT') return { file, backupFile: null, removed: 0 };
      throw err;
    }
    if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
      return { file, backupFile: null, removed: 0 };
    }

    const backupFile = backup(file);
    let removed = 0;
    // hooks 容器本身是不是本插件造的（读自条目上的显式标记，不从 key 归属反推）。
    let createdHooks = false;
    for (const event of Object.keys(config.hooks)) {
      const list = config.hooks[event];
      if (!Array.isArray(list)) continue;
      const res = stripFromList(list, command);
      removed += res.removed;
      if (res.createdHooks) createdHooks = true;
      // 删 key 的唯一条件：这个 key 是**本插件 install 时现造的**，且摘完已空。
      //
      // 别退回「空了就删」—— 那个判据与「是谁创建的」无关，会把用户原有的空数组键
      // （`PreCompact: []` 之类的占位/临时停用写法）静默删掉。空数组不是垃圾，是用户
      // 的配置内容；本插件只有权收回自己造的东西。这与「删除粒度 = 身份粒度」是同一条
      // 铁律，只是提高了一个容器层级：条目层认 command，key 层认 createdKey。
      if (res.createdKey && res.list.length === 0) delete config.hooks[event];
      else config.hooks[event] = res.list;
    }
    // hooks 容器同理：只有本插件造的容器才收回，用户原有的空 `hooks: {}` 原样还回去。
    if (createdHooks && Object.keys(config.hooks).length === 0) delete config.hooks;

    writeConfig(file, config);
    return { file, backupFile, removed };
  }

  // 面板要显示「已接入 ✓ / 一键接入」两种状态，靠这个判定
  function isInstalled(options) {
    const file = fileOf(options);
    const command = commandOf(options);
    let config;
    try { config = readConfig(file); } catch (_) { return false; }
    const hooks = config.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
    return HOOKED_EVENTS.every((event) => {
      const list = hooks[event];
      return Array.isArray(list) && list.some((entry) => isOurs(entry, command));
    });
  }

  return {
    MARKER, CREATED_KEY, CREATED_HOOKS, HOOKED_EVENTS,
    hookCommand, isOurs, stripOurCommand, stripFromList,
    install, uninstall, isInstalled
  };
}

module.exports = {
  BACKUP_SUFFIX, shellQuote, readConfig, writeConfig, backup, createInstaller
};
