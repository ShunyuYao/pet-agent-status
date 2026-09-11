'use strict';
// tool 入口：宿主 utilityProcess 里跑，activate(pet) 收到 SDK 对象。
// 职责只有三件：定时读状态目录 → aggregate 推导 → 经 events 推给 panel，顺带触发宠物联动。
//
// 合规通道：manifest 声明的 pet.{scheduler,events,pet} + 状态目录读写（README 权限披露）。

const path = require('path');
const os = require('os');

const LIB = path.join(__dirname, '..', 'lib');
const stateFiles = require(path.join(LIB, 'state-files.js'));
const { aggregate, DISMISSIBLE } = require(path.join(LIB, 'aggregate.js'));
const { createPetLink } = require(path.join(LIB, 'pet-link.js'));
const { createBadgeLink } = require(path.join(LIB, 'badge.js'));
const deeplink = require(path.join(LIB, 'codex-deeplink.js'));
const { createCodexIpc } = require(path.join(LIB, 'codex-ipc.js'));
const { createCodexAppIngest } = require(path.join(LIB, 'codex-app-ingest.js'));
const { createCodexThreadTitles } = require(path.join(LIB, 'codex-thread-titles.js'));
const { createTerminalTitles } = require(path.join(LIB, 'terminal-titles.js'));
const { createNodeI18n } = require(path.join(LIB, 'i18n.js'));
const installer = require(path.join(LIB, 'claude-hooks-installer.js'));
const codexInstaller = require(path.join(LIB, 'codex-hooks-installer.js'));
const terminalJump = require(path.join(LIB, 'terminal-jump.js'));

const TICK_MS = 2000;                            // 宿主把最小间隔钳到 1000ms，2s 满足「3 秒内可感知」
// 事件名带前缀防撞（AGENTS.md 惯例）。这一组与 panel/panel.html 里的常量是**两份副本**，
// 改一处必须改两处；tests/panel-dom-test.js 与 tool-lifecycle-test.js 各自断言了名字，
// 漂移会在门禁里红。
const SNAPSHOT_EVENT = 'agent-status:snapshot';
const LOCALE_EVENT = 'agent-status:locale';
const INSTALL_STATE_EVENT = 'agent-status:install-state';   // tool → panel：接入与否
const INSTALL_CLAUDE_EVENT = 'agent-status:install-claude';   // panel → tool：接入意图
const UNINSTALL_CLAUDE_EVENT = 'agent-status:uninstall-claude'; // panel → tool：移除意图
const INSTALL_CODEX_EVENT = 'agent-status:install-codex';       // panel → tool：Codex 接入意图
const UNINSTALL_CODEX_EVENT = 'agent-status:uninstall-codex';   // panel → tool：Codex 移除意图
const JUMP_EVENT = 'agent-status:jump';                         // panel → tool：跳回终端意图
const SETTINGS_STATE_EVENT = 'agent-status:settings-state';     // tool → panel：设置视图状态
const SET_SETTING_EVENT = 'agent-status:set-setting';           // panel → tool：改设置意图

// 设置的唯一真相源：pet.storage 的这个键。**默认开**（没存过值 = true）；
// 只有显式存过 false 才算关。刻意不用 manifest entry.settings —— 那份值只有宿主设置页
// 能写、panel 写不了，两处开关必漂（同好友仓「判据只允许一处」教训）。
const IPC_ENABLED_KEY = 'codexIpcEnabled';

// 跳转失败的错误条挂多久。留到下一次跳转成功/超时为止，不能永远挂着 ——
// 用户在别处修好终端后面板还红着，会以为坏了。
const JUMP_ERROR_TTL_MS = 30 * 1000;
// 进程表（ps）缓存窗口。canJump 是每行每 tick 都要问的，而终端归属几分钟内不会变；
// 不缓存的话 2s 一轮 × N 行会 spawn 一堆 ps。
const PS_CACHE_MS = 10 * 1000;

// 进程存活探测：kill(pid, 0) 不发信号只查存在性。EPERM = 存在但不属于本用户，算存活。
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

/**
 * 造一个采集器。所有外部依赖可注入，测试不碰真实目录/时钟/进程。
 * @param {object} [deps] { dir, now, isPidAlive, t, playAnimGuard, readSnapshots }
 */
// Codex IPC socket 默认路径。与 hooks 配置同源认 CODEX_HOME（fixtures/codex-ipc-facts.md §1），
// 可经 deps.codexIpcPath 覆盖（测试注入假路径，绝不碰真 socket）。
function defaultCodexIpcPath() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'ipc', 'ipc.sock');
}

function createCollector(deps) {
  const d = deps || {};
  const readSnapshots = typeof d.readSnapshots === 'function' ? d.readSnapshots : stateFiles.readSnapshots;
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const alive = typeof d.isPidAlive === 'function' ? d.isPidAlive : isPidAlive;
  // 语言只认这一处。副行/时间文案由 tool 取词后随行下发，panel 的静态文案则按
  // 快照里带的 locale 取 —— 两边各猜各的会当场撞车：tool 看 LANG、panel 看
  // navigator.language，两者不一致时同一块面板上半截中文下半截英文。
  let i18n = createNodeI18n(d.locale);
  let t = typeof d.t === 'function' ? d.t : i18n.t;
  let locale = d.locale || i18n.locale;
  // 换语言：重建词表与取词函数（注入了 d.t 的测试不受影响，仍用注入的那个）
  function applyLocale(next) {
    i18n = createNodeI18n(next);
    if (typeof d.t !== 'function') t = i18n.t;
    locale = i18n.locale;
  }
  const link = createPetLink({ playAnimGuard: d.playAnimGuard });
  const badgeLink = createBadgeLink();
  // Codex App 实时增强（**默认开**，storage 键 IPC_ENABLED_KEY，panel 设置视图可关）。
  // 两条增益：① App 任务摄入为状态文件（codex-app-ingest，映射表冻结在 PROTOCOL.md）；
  // ② following 信号进 focus 同级优先。连不上/协议变了会自己停用，
  // 面板与 Hooks 通道完全不受影响（fixtures/codex-ipc-facts.md §7）。
  // 工厂可注入：测试绝不碰真 socket（默认路径是真实 ~/.codex/ipc/ipc.sock）。
  const ipcFactory = typeof d.createCodexIpc === 'function' ? d.createCodexIpc : createCodexIpc;
  const ingest = createCodexAppIngest({ dir: d.dir, now });
  // 会话标题解析（US-9）：Codex 线程目录里 AI 生成的标题按 threadId 查（App 与 CLI 共库，
  // fixtures/codex-ipc-facts.md §9）。可注入：测试绝不读真实 ~/.codex（默认走 CODEX_HOME）。
  const threadTitles = d.threadTitles || createCodexThreadTitles({ codexHome: d.codexHome, now });
  // 终端标签标题（US-9 增强）：Claude Code 把 AI 标题推给了终端（磁盘上没有），
  // 按 tty 从 iTerm2/Terminal.app 查回来（fixtures/terminal-titles-facts.md）。
  // 可注入：测试绝不 spawn 真 osascript（会触发自动化授权弹窗/拉起终端查询）。
  const termTitles = d.terminalTitles || createTerminalTitles({ now });
  let codexIpc = null;
  let ipcEnabled = null;   // 上次读到的开关值（null = 还没读过）
  // 缺省 undefined → installer 自己走 settingsPath()（即 PET_AS_CLAUDE_SETTINGS 覆盖）；
  // 测试注入临时文件，绝不碰真实 ~/.claude/settings.json
  const installOpts = d.settingsFile ? { settingsFile: d.settingsFile } : undefined;
  // 同理，Codex 侧缺省走 hooksPath()（即 PET_AS_CODEX_HOOKS / CODEX_HOME 覆盖），
  // 测试注入临时文件，绝不碰真实 ~/.codex/hooks.json
  const codexOpts = d.codexHooksFile ? { hooksFile: d.codexHooksFile } : undefined;

  let taskId = null;
  let lastSnapshot = { rows: [], summary: { running: 0, waiting: 0, total: 0, unknown: 0 } };

  // ---- 跳转（US-005）----
  // psTree/runner 可注入：测试绝不 spawn ps、更不真跑 osascript（会骚扰真实桌面）。
  // 数组或函数都收（terminal-jump 两种都吃）：测试注数组最省事，注函数可模拟 ps 变化
  const psTree = (typeof d.psTree === 'function' || Array.isArray(d.psTree)) ? d.psTree : null;
  const jumpRunner = typeof d.jumpRunner === 'function' ? d.jumpRunner : undefined;
  const jumpErrors = new Map();   // sessionId → { text, at }
  // sessionId → 用户点掉它的时刻。只影响**已结束**的行（done/idle/unknown），
  // 该会话再有新事件就自动复现（判据是 ts 比较，见 aggregate#isDismissed）。
  // 不落盘：这是「这一轮看过了」的临时视图状态，重启后重新按真实状态显示。
  const dismissedAt = new Map();
  let psCache = null;             // { at, list } —— 见 PS_CACHE_MS

  // 进程表读一次给一轮里所有行共用。terminal-jump 接受「函数或数组」，这里给数组。
  function psTreeCached(at) {
    if (psTree) return psTree;   // 注入的自己管缓存
    if (psCache && at - psCache.at < PS_CACHE_MS) return psCache.list;
    let list = [];
    try { list = terminalJump.readPsTree(); } catch (_) { list = []; }
    psCache = { at, list };
    return list;
  }

  // canJump 判定：委托给 lib/terminal-jump.js（归属判定唯一实现处），本文件不自己判。
  function makeCanJump(at) {
    const tree = psTreeCached(at);
    return (tty) => terminalJump.detectTerminal(tty, tree) != null;
  }

  // 当前有效的行内错误（过了 TTL 就忘掉）
  function activeJumpErrors(at) {
    const out = {};
    for (const [id, entry] of [...jumpErrors.entries()]) {
      if (at - entry.at >= JUMP_ERROR_TTL_MS) { jumpErrors.delete(id); continue; }
      out[id] = entry.text;
    }
    return out;
  }

  /**
   * panel 点了某一行。查它的 tty → 生成脚本 → 执行；失败**不 throw 不静默**，
   * 错误文案存起来随下一次快照回推，面板在该行下方显示行内错误条（DESIGN.md）。
   */
  // 读开关：storage 没存过值（undefined/null）= 默认开；只有显式 false 才关。
  // storage 读挂了按「维持现状」处理（首轮现状 = 默认开）——读取抖动不该把连接抖没。
  async function readIpcEnabled(pet) {
    try {
      if (pet && pet.storage && typeof pet.storage.get === 'function') {
        const v = await pet.storage.get(IPC_ENABLED_KEY);
        return v == null ? true : v !== false;
      }
    } catch (_) { /* 读不到走下面的兜底 */ }
    return ipcEnabled == null ? true : ipcEnabled;
  }

  // 按开关开/关 IPC 增强。设置是运行时可改的，每轮 tick 都对一次。
  async function syncCodexIpc(pet) {
    const want = await readIpcEnabled(pet);
    ipcEnabled = want;
    if (want && !codexIpc) {
      codexIpc = ipcFactory({
        socketPath: d.codexIpcPath || defaultCodexIpcPath(),
        // 摄入回调落状态文件，下一轮 tick（≤2s）自然进快照/联动，不在回调里强推
        onActivity: (id) => ingest.onActivity(id),
        onReadState: (id, hasUnread) => ingest.onReadState(id, hasUnread),
        // 连接状态变了立刻告诉设置视图（ready/disabled 的翻面不该等 tick）
        onStatus: () => pushSettingsState(pet)
      });
      codexIpc.start();
    } else if (!want && codexIpc) {
      codexIpc.stop();
      codexIpc = null;
    }
  }

  // 设置视图状态：开关值 + IPC 连接态（off = 开关关着没实例）
  function pushSettingsState(pet) {
    emit(pet, SETTINGS_STATE_EVENT, {
      codexIpcEnabled: ipcEnabled == null ? true : ipcEnabled,
      ipcState: codexIpc ? codexIpc.state : 'off'
    });
  }

  // panel 设置视图发来的改设置意图。只认白名单键，storage 写失败不打死采集器。
  async function handleSetSetting(pet, data) {
    if (!data || data.key !== IPC_ENABLED_KEY) return;
    const value = data.value !== false;
    try {
      if (pet && pet.storage && typeof pet.storage.set === 'function') {
        await pet.storage.set(IPC_ENABLED_KEY, value);
      }
    } catch (_) { /* 存不下也先按用户意图切运行态，下轮读回真值自会纠偏 */ }
    ipcEnabled = value;
    if (value && !codexIpc) await syncCodexIpc(pet);
    else if (!value && codexIpc) { codexIpc.stop(); codexIpc = null; }
    pushSettingsState(pet);
  }

  // dismissedAt 转普通对象给 aggregate。顺带清掉「状态文件已经不在了」的会话记录，
  // 否则这张表会随会话增长无限变长（同 jumpErrors 的 TTL 清理精神）。
  function dismissMap() {
    const out = {};
    for (const [id, at] of dismissedAt) out[id] = at;
    return out;
  }
  function pruneDismissed(records) {
    if (dismissedAt.size === 0) return;
    const alive = new Set(records.map((r) => r.sessionId));
    for (const id of [...dismissedAt.keys()]) if (!alive.has(id)) dismissedAt.delete(id);
  }

  function handleJump(pet, data) {
    const at = now();
    const sessionId = data && data.sessionId;
    if (!sessionId) return { ok: false, reason: 'unavailable' };
    const row = lastSnapshot.rows.find((r) => r.sessionId === sessionId);
    // 两条并列的导航路（判定唯一实现在 lib/codex-deeplink.js#pickNavigator）：
    // Codex App 任务没有 tty、只有 threadId，只能走深链接；其余（含所有 CLI 会话）走 tty 聚焦。
    const nav = deeplink.pickNavigator(row);
    let result;
    if (!nav) {
      result = { ok: false, reason: 'unavailable' };
    } else if (nav.kind === 'deeplink') {
      const r = deeplink.openDeepLink(nav.url, d.execFile);
      // `open` 受理 ≠ 页面真的呈现（fixtures/codex-ipc-facts.md §6）——这里只能报「已发起」。
      // Scheme 没注册（没装 Codex App）与一般失败文案不同，故 reason 分开传。
      result = r.ok ? { ok: true } : { ok: false, reason: r.reason === 'no-scheme' ? 'no-codex-app' : 'failed' };
    } else {
      result = terminalJump.runJump(row.tty, { psTree: psTreeCached(at), runner: jumpRunner });
    }
    if (result.ok) {
      jumpErrors.delete(sessionId);
      // 点完就收起：只对已经没有后续的行生效（running/waiting 还在进行中，收起会丢失视野）。
      // 记时刻而非布尔，让「又有新动静」能自动复现这一行。
      if (row && DISMISSIBLE.has(row.state)) dismissedAt.set(sessionId, at);
    } else {
      // reason==='unavailable' 是「压根找不到终端」，与「osascript 报错」文案不同：
      // 前者用户该去别处找会话，后者是这次执行挂了，可以再试。
      // 三档文案各有各的行动指引：找不到终端（去别处找会话）/ 没装 Codex App（去装或启动）/
      // 这次执行挂了（可以再试）。塞进同一句「失败：<reason>」会把内部枚举名甩给用户。
      const text = result.reason === 'unavailable'
        ? t('jump.unavailable')
        : result.reason === 'no-codex-app'
          ? t('jump.noCodexApp')
          : t('jump.failed', { reason: result.reason });
      jumpErrors.set(sessionId, { text, at });
    }
    // 立刻回推一轮，用户点完当场看到结果，不用等下一个 tick
    tick(pet);
    return result;
  }

  // 一轮采集。整体包 try/catch：抛出去会打死宿主定时任务，下一轮就没了。
  function tick(pet) {
    try {
      const at = now();
      const raw = readSnapshots(d.dir);
      pruneDismissed(raw.records || []);   // 会话文件没了就忘掉它的已读记录
      const result = aggregate(raw, {
        now: at, isPidAlive: alive, t,
        canJump: makeCanJump(at),          // 判定实现在 lib/terminal-jump.js，这里只注入
        // 无 tty 行（App 任务）的可点判定：唯一实现在 codex-deeplink#pickNavigator，
        // aggregate 保持零厂牌特判，只吃注入
        canJumpWithoutTty: (row) => deeplink.pickNavigator(row) != null,
        jumpErrors: activeJumpErrors(at),  // 上次跳转失败的行内错误条
        dismissedAt: dismissMap(),         // 用户点掉的行（已结束态才生效）
        // App 正在跟随的会话在 focus 同级里优先（US-8；threadId 即 conversationId）
        isFollowing: (row) => !!(codexIpc && row.threadId && codexIpc.isFollowing(row.threadId)),
        // 会话标题优先级（facts §4）：Codex 线程目录 AI 标题 > 终端标签标题 >
        // （aggregate 回落）落盘 title（首条 prompt 首行）> project。
        // 两个解析器各自唯一实现在 lib/codex-thread-titles.js / lib/terminal-titles.js。
        titleFor: (rec) => {
          if (rec.agent === 'codex' && rec.threadId) {
            const fromCatalog = threadTitles.lookup(rec.threadId);
            if (fromCatalog) return fromCatalog;
          }
          return rec.tty ? termTitles.lookup(rec.tty) : null;
        }
      });
      // locale 随快照下发，panel 据此选词表（契约仍是 {rows, summary}，locale 是附加字段）
      result.locale = locale;
      lastSnapshot = result;
      emit(pet, SNAPSHOT_EVENT, result);
      // 接入态随每轮一起推：面板是随开随关的，start 时推一次的话，
      // 之后才打开的面板永远等不到这条，空态会一直停在「一键接入」——
      // 哪怕钩子早就装好了。读一个小 JSON，2s 一次的开销可以忽略。
      pushInstallState(pet);
      pushSettingsState(pet);   // 设置视图同理随开随关，每轮都给
      link.onSnapshot(result.rows, pet, { now: at, t });
      // 折叠徽标（宿主 pet.badge.*）：数据取自同一份 summary，协议零改动。
      // 不 await：徽标失败不该拖慢/打断本轮采集，内部已自带 try/catch 与降级。
      void badgeLink.onSummary(result.summary, pet);
      void syncCodexIpc(pet);   // 设置项运行时可改：开了要连上、关了要断开
      return result;
    } catch (_) {
      return lastSnapshot;   // 本轮读坏了就沿用上轮，面板不闪空
    }
  }

  // panel 的接入按钮只发意图，改配置的活在这边（panel 上下文没有 fs，也不该有）。
  // 每次改完立刻回推一次接入态，面板的「一键接入 / 已接入 ✓」当场翻面。
  function pushInstallState(pet) {
    let claude = false;
    try { claude = installer.isInstalled(installOpts); } catch (_) { claude = false; }
    let codex = false;
    try { codex = codexInstaller.isInstalled(codexOpts); } catch (_) { codex = false; }
    // 两个厂牌各一个开关，panel 各画各的（载荷仍是同一个事件，加字段不改契约）
    emit(pet, INSTALL_STATE_EVENT, { claude, codex });
    return { claude, codex };
  }

  function handleInstall(pet) {
    // 改用户 settings.json 失败不该打死采集器：面板照旧显示「未接入」，用户可再试。
    try { installer.install(installOpts); } catch (_) { /* 权限/磁盘问题 */ }
    return pushInstallState(pet);
  }

  function handleUninstall(pet) {
    try { installer.uninstall(installOpts); } catch (_) { /* 同上 */ }
    return pushInstallState(pet);
  }

  // Codex 侧同构。**绝不碰 hooks.state**（facts §hook trust：那是 Codex 的信任机制，
  // 插件替用户点头等于绕过安全设计）—— 接入后由面板提示用户下次启动 Codex 时确认信任。
  function handleInstallCodex(pet) {
    try { codexInstaller.install(codexOpts); } catch (_) { /* 权限/磁盘问题 */ }
    return pushInstallState(pet);
  }

  function handleUninstallCodex(pet) {
    try { codexInstaller.uninstall(codexOpts); } catch (_) { /* 同上 */ }
    return pushInstallState(pet);
  }

  async function start(pet) {
    if (taskId != null) return taskId;   // 启停串行，不重复注册（重复注册 = 泄漏定时器）
    // 先接意图再起定时器：面板可能在 tick 之前就点了接入
    subscribe(pet, INSTALL_CLAUDE_EVENT, () => handleInstall(pet));
    subscribe(pet, UNINSTALL_CLAUDE_EVENT, () => handleUninstall(pet));
    subscribe(pet, INSTALL_CODEX_EVENT, () => handleInstallCodex(pet));
    subscribe(pet, UNINSTALL_CODEX_EVENT, () => handleUninstallCodex(pet));
    subscribe(pet, JUMP_EVENT, (data) => handleJump(pet, data));
    subscribe(pet, SET_SETTING_EVENT, (data) => { void handleSetSetting(pet, data); });
    // 语言以 renderer 的 navigator.language 为准（tool 进程的 LANG 不代表界面语言，
    // 实测会把中文用户判成 en）。panel 首次发现分歧时报上来，这里换表并立即重推一轮。
    subscribe(pet, LOCALE_EVENT, (data) => {
      const next = data && data.locale;
      if (!next || next === locale) return;
      applyLocale(next);
      tick(pet);
    });
    // 必须 await：pet.scheduler.every 返回的是 Promise<taskId>，
    // 直接存 Promise 会让 cancel 拿到个对象、恒 miss，旧定时器永不回收（宿主已知坑）。
    await syncCodexIpc(pet);
    taskId = await pet.scheduler.every(TICK_MS, () => tick(pet));
    tick(pet);   // 立刻来一轮，用户开面板不用等 2 秒
    return taskId;
  }

  async function stop(pet) {
    if (taskId == null) return;
    const id = taskId;
    taskId = null;   // 先清再 cancel：cancel 失败也不该留个假 id 挡住下次 start
    try { await pet.scheduler.cancel(id); } catch (_) { /* 宿主已经收走了 */ }
    // 正常停用时自己把徽标撤干净（宿主虽有兜底清除，但那是给异常路径的）
    await badgeLink.dispose(pet);
    if (codexIpc) { codexIpc.stop(); codexIpc = null; }
  }

  return {
    start, stop, tick,
    handleInstall, handleUninstall, handleInstallCodex, handleUninstallCodex,
    pushInstallState, handleJump, handleSetSetting,
    get taskId() { return taskId; },
    get lastSnapshot() { return lastSnapshot; },
    get ipcEnabled() { return ipcEnabled; },
    get codexIpc() { return codexIpc; }
  };
}

function emit(pet, name, data) {
  try {
    if (pet && pet.events && typeof pet.events.emit === 'function') pet.events.emit(name, data);
  } catch (_) { /* 面板没开着，推送失败无所谓 */ }
}

// 订阅 panel 发来的意图。回调整体包 try/catch：panel 送来什么都不该打死 tool。
function subscribe(pet, name, fn) {
  try {
    if (pet && pet.events && typeof pet.events.on === 'function') {
      pet.events.on(name, (data) => { try { fn(data); } catch (_) { /* 单次意图失败 */ } });
    }
  } catch (_) { /* 宿主没给 events 面 */ }
}

let collector = null;
let activeSdk = null;

async function activate(pet) {
  activeSdk = pet;
  collector = createCollector();
  await collector.start(pet);
  return collector;
}

// 宿主当前是 kill 子进程 + 自动取消定时器（runtime.js#deactivateRec），没有调 deactivate 的路径；
// 这里仍显式实现，既是 criteria 要求，也为宿主将来接上这个钩子留好口子。
// pet 省略时用 activate 时存下的那个 —— 宿主多半不会再传一遍。
async function deactivate(pet) {
  if (!collector) return;
  await collector.stop(pet || activeSdk);
  collector = null;
  activeSdk = null;
}

module.exports = {
  activate, deactivate, createCollector,
  isPidAlive, TICK_MS,
  SNAPSHOT_EVENT, LOCALE_EVENT, INSTALL_STATE_EVENT, INSTALL_CLAUDE_EVENT, UNINSTALL_CLAUDE_EVENT,
  INSTALL_CODEX_EVENT, UNINSTALL_CODEX_EVENT,
  JUMP_EVENT, JUMP_ERROR_TTL_MS,
  SETTINGS_STATE_EVENT, SET_SETTING_EVENT, IPC_ENABLED_KEY
};
