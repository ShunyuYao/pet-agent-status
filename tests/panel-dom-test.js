'use strict';
// US-004 验收测试：panel 会话列表与空态 UI。
//
// 全离线：jsdom 加载真实 panel/panel.html（不直调内部函数自证），
// window.pet 用 mock 注入，快照经 events.on 回调喂进去 —— 与生产同一条通道。
// 断言用户可观测结果（DOM 结构/class/文案/发出的事件），不断言「某函数被调用」。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PANEL_HTML = path.join(ROOT, 'panel', 'panel.html');
const html = fs.readFileSync(PANEL_HTML, 'utf8');

const agg = require(path.join(ROOT, 'lib', 'aggregate.js'));
const sf = require(path.join(ROOT, 'lib', 'state-files.js'));
const { createNodeI18n } = require(path.join(ROOT, 'lib', 'i18n.js'));
const tool = require(path.join(ROOT, 'tool', 'index.js'));
const installerLib = require(path.join(ROOT, 'lib', 'claude-hooks-installer.js'));

const T0 = 1789000000000;   // 固定基准，测试绝不用真实时钟
const t = createNodeI18n('zh-CN').t;

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n${err && err.stack}`);
  }
}

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-status-panel-'));
  tmpDirs.push(d);
  return d;
}

// ---- panel 装载壳：mock window.pet，返回可操作的句柄 ----
//
// events.on 存下回调，测试用 push(name, data) 从**宿主侧**推事件进去，
// 与 tool 的 pet.events.emit 同一条通道；emit 记流水供断言意图。
// 假 IPC 工厂：IPC 默认开，真实工厂会连本机真 socket 且吊住进程退出——测试一律注入
function fakeIpc() {
  return { start() {}, stop() {}, followingIds() { return []; }, isFollowing() { return false; }, state: 'idle' };
}
function mountPanel(opts) {
  const o = opts || {};
  const handlers = new Map();
  const emitted = [];
  const closed = [];
  const copied = [];
  const petMock = {
    events: {
      on(name, fn) { handlers.set(name, fn); },
      emit(name, data) { emitted.push({ name, data }); }
    },
    // noCopyText：模拟「宿主没有 ui.copyText」的旧宿主，验面板不炸（同 badge 的降级测法）
    ui: o.noCopyText
      ? { closePanel() { closed.push(true); } }
      : { closePanel() { closed.push(true); }, copyText(s) { copied.push(s); } }
  };
  // setPanelPinned：面板声明「非常驻」→ 宿主 blur 即关（失焦自动关闭）。
  // noSetPanelPinned 模拟没有这个 SDK 面的旧宿主，验面板不炸。
  if (!o.noSetPanelPinned) {
    petMock.ui.setPanelPinned = (v) => { if (o.onSetPanelPinned) o.onSetPanelPinned(v); };
  }
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'file://' + PANEL_HTML,
    beforeParse(win) {
      win.pet = petMock;
      // 语言由 navigator.language 决定（panel 上下文没有 process.env）
      Object.defineProperty(win.navigator, 'language', {
        value: o.language || 'zh-CN', configurable: true
      });
    }
  });
  const doc = dom.window.document;
  return {
    dom, doc, emitted, closed, copied,
    push(name, data) {
      const fn = handlers.get(name);
      assert.ok(fn, `panel 没有订阅事件 ${name}`);
      fn(data);
    },
    hasHandler: (name) => handlers.has(name),
    $: (sel) => doc.querySelector(sel),
    $$: (sel) => Array.from(doc.querySelectorAll(sel)),
    close() { dom.window.close(); }
  };
}

// 快照一律经真实 aggregate 产出（不手搓行对象）：
// 手搓的行与上游真实输出不同形，是本仓库前三次「测试绿但生产坏」的根因。
function snapshotOf(recs, over) {
  const dir = tmp();
  for (const r of recs) sf.writeStatus(r, dir);
  return agg.aggregate(sf.readSnapshots(dir),
    // 与生产同构：tool 侧注入的「无 tty 行有没有 App 落点」判定（codex 深链接 || Claude App）。
    // 不注入的话，2026-09-12「按落点过滤」会把所有 App 任务行当成点不进去而隐藏，
    // 这些用例测的却是 App 行怎么渲染——夹具必须跟生产一样给出落点判定。
    Object.assign({
      now: T0, isPidAlive: () => true, t,
      canJumpWithoutTty: (row) => require(path.join(ROOT, 'lib', 'codex-deeplink.js')).pickNavigator(row) != null
    }, over));
}
// 夹具默认**每个会话一个终端窗口**：同一个 tty 上的旧会话会被同窗顶替规则收起
// （lib/aggregate.js#supersedeSameTerminal，2026-09-12），而这些用例测的是状态推导/
// 排序/汇总，会话之间本就互相独立。要测同窗行为的用例请显式传同一个 tty。
function ttyFor(sessionId) {
  const s = String(sessionId == null ? '' : sessionId);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 900;
  return `/dev/ttys${String(h + 100)}`;
}
function rec(over) {
  const o = over || {};
  const base = {
    agent: 'claude-code', sessionId: 's', cwd: '/Users/me/projects/demo',
    pid: 4242, state: 'running', lastEvent: 'UserPromptSubmit', ts: T0
  };
  const merged = Object.assign(base, o);
  // 没显式给 tty 的话按 sessionId 各分一个窗口（见 ttyFor 注释）
  if (!('tty' in o)) merged.tty = ttyFor(merged.sessionId);
  return merged;
}

// ================= 1. 内联脚本的语法门禁 =================
// panel 是单文件（AGENTS.md：script 内联；宿主 CSP 下 file:// 的 'self' 不可靠），
// 但门禁要求 node --check 覆盖 panel 逻辑 —— 把内联 script 抠出来真跑一遍 node --check。

function inlineScript() {
  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  assert.ok(m, 'panel.html 里找不到内联 <script> 块');
  return m[1];
}

test('内联 script 通过 node --check', () => {
  const f = path.join(tmp(), 'panel-inline.js');
  fs.writeFileSync(f, inlineScript());
  execFileSync(process.execPath, ['--check', f]);   // 语法错会抛非零退出
});

// ================= 2. 无外部依赖 / 设计红线（静态） =================

// 红线禁的是「**加载**远程资源」，不是「字面上出现 URL 字符」。两处豁免各有理由，
// 且都补了「它确实没被当成加载目标」的正面断言 —— 只放进白名单不验用法，等于把守卫挖空。
const URL_ALLOWLIST = [
  'http://www.w3.org/2000/svg',                    // XML 规范要求的命名空间标识符，不是请求
  'https://github.com/ShunyuYao/pet-agent-status', // 「关于」区展示给用户看的仓库地址（纯文本 + copyText）
];

test('panel.html 零远程资源、零框架', () => {
  // 注释里也不许留 URL（criteria §2「grep 零命中」），白名单外一律零命中
  const hits = html.match(/https?:\/\/[^\s"'<>]+/g) || [];
  const remote = hits.filter((u) => !URL_ALLOWLIST.includes(u));
  assert.deepStrictEqual(remote, [], `panel.html 出现远程 URL: ${remote.join(', ')}`);
  assert.ok(!/<script[^>]+src=/i.test(html), 'panel 不得引用外部 script');
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'panel 不得引用外部样式表');
});

test('仓库地址只是展示文本，从不作为加载/导航目标', () => {
  // 光把它加进白名单证明不了安全：真正要防的是有人日后把它写成 <a href>/fetch/src。
  // 宿主 panel 窗没有 setWindowOpenHandler，<a href> 点了也打不开 —— 那是个假入口，
  // 比不做更糟，所以这里直接把「出现在任何加载/导航属性里」判为失败。
  const repo = 'https://github.com/ShunyuYao/pet-agent-status';
  const asAttr = new RegExp(`(?:href|src|action|formaction)\\s*=\\s*["']?${repo.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'i');
  assert.ok(!asAttr.test(html), '仓库地址不得出现在 href/src 等加载属性里（宿主打不开，是假入口）');
  assert.ok(!new RegExp(`fetch\\s*\\(\\s*["']${repo}`).test(html), '仓库地址不得用于 fetch');
  assert.ok(/copyText\s*\(\s*REPO_URL\s*\)/.test(html), '仓库地址应经 ui.copyText 交给用户');
});

test('DESIGN.md token 色值逐个出现在 panel.html', () => {
  const tokens = [
    '#2A2E39',                    // Ink 面板底
    '#3D7EFF',                    // Primary 蓝
    '#8FB5FF',                    // running 副行浅蓝
    '#F2994A',                    // Warning 橙
    '#27AE60',                    // Success 绿
    '#EB5757',                    // Danger 红
    '#9AA0AC',                    // Gray
    'rgba(255,255,255,.06)',      // 行底 6%
    'rgba(242,153,74,.13)',       // waiting 行底 橙 13%
    '#D97757',                    // Claude 徽标底
    '#0D0D0D',                    // Codex 徽标底
    'rgba(255,255,255,.18)'       // Codex 徽标描边 18%
  ];
  for (const token of tokens) {
    assert.ok(html.includes(token), `DESIGN.md token ${token} 未出现在 panel.html`);
  }
  assert.ok(/border:1\.5px solid/.test(html), 'waiting 行 1.5px 描边缺失');
});

test('DESIGN.md 尺寸：徽标 26 圆角 8 / 角标 13 / 项目名 13 / 副行 11 / 状态点 8 / 行圆角 12', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  // 选择器要锚在行首，否则 `body{...}` 会先命中 `html,body{height:100%}` 那条
  const ruleOf = (sel) => {
    const m = css.match(new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm'));
    assert.ok(m, `找不到 CSS 规则 ${sel}`);
    return m[1];
  };
  const badge = ruleOf('.badge');
  assert.ok(/width:26px/.test(badge) && /height:26px/.test(badge), '徽标不是 26×26');
  assert.ok(/border-radius:8px/.test(badge), '徽标圆角不是 8');
  const form = ruleOf('.form-badge');
  assert.ok(/width:13px/.test(form) && /height:13px/.test(form), '形态角标不是 13×13');
  assert.ok(/font-size:13px/.test(ruleOf('.project')), '项目名字号不是 13');
  assert.ok(/font-size:11px/.test(ruleOf('.subline')), '副行字号不是 11');
  assert.ok(/font-size:11px/.test(ruleOf('.time')), '时间字号不是 11');
  const dot = ruleOf('.dot');
  assert.ok(/width:8px/.test(dot) && /height:8px/.test(dot), '状态点不是 8px');
  assert.ok(/border-radius:12px/.test(ruleOf('.row')), '会话行圆角不是 12');
  assert.ok(/border-radius:20px/.test(ruleOf('body')), '面板圆角不是 20');
  assert.ok(/width:320px/.test(ruleOf('body')), '面板宽度不是 320');
  assert.ok(/padding:14px/.test(ruleOf('body')), '面板内边距不是 14');
  assert.ok(/gap:8px/.test(ruleOf('.list')), '行距不是 8');
  assert.ok(/font-size:16px/.test(ruleOf('.title')), '面板标题字号不是 16');
  // 底栏 0.11.0 由提示文字改成 App 启动器，度量改钉这三条（设计稿 Figma 第 ⑤ 区 C1）
  const appBtn = ruleOf('.app-btn');
  assert.ok(/width:34px/.test(appBtn) && /height:34px/.test(appBtn), 'App 图标不是 34×34');
  assert.ok(/border-radius:9px/.test(appBtn), 'App 图标圆角不是 9');
  const appRow = ruleOf('.applauncher-row');
  assert.ok(/justify-content:center/.test(appRow), 'App 图标必须水平居中');
  assert.ok(/gap:14px/.test(appRow), 'App 图标间距不是 14');
  assert.ok(/font-size:12\.5px/.test(ruleOf('.install-btn')), '主按钮字号不是 12.5');
  assert.ok(/border-radius:10px/.test(ruleOf('.install-btn')), '主按钮圆角不是 10');
});

// ---- 2026-09-12 用户对照 Figma 提出的三处不一致 ----

test('头部 ⚙ 与 ✕ 同尺寸同样式（设计稿无 ⚙，补入时不得比 ✕ 大一圈）', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const ruleOf = (sel) => {
    const m = css.match(new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm'));
    assert.ok(m, `找不到 CSS 规则 ${sel}`);
    return m[1];
  };
  // 两个钮共用一条规则（.icon-btn）才不会再漂：分开写两份迟早又各调各的
  const btn = ruleOf('.icon-btn');
  assert.ok(/width:22px/.test(btn) && /height:22px/.test(btn), '两个头部钮的命中区必须同为 22×22');
  assert.ok(/color:var\(--gray\)/.test(btn), '图标色应为设计稿的 #9AA0AC（--gray）');
  // 图标用 SVG 而不是字符：⚙(U+2699) 与 ✕(U+2715) 的字形度量差一大截，
  // 同样 font-size 下看起来仍然一大一小——这正是用户看到的现象。
  const svgRule = ruleOf('.icon-btn svg');
  assert.ok(/width:13px/.test(svgRule) && /height:13px/.test(svgRule), '两个图标必须同为 13×13（设计稿 ✕ 13px）');
  const p = mountPanel();
  const gear = p.$('#gear'); const close = p.$('#close');
  assert.ok(gear.classList.contains('icon-btn') && close.classList.contains('icon-btn'),
    '⚙ 与 ✕ 必须走同一条 .icon-btn 规则');
  assert.ok(gear.querySelector('svg') && close.querySelector('svg'), '两个钮都必须是 SVG 图标，不是字符');
  assert.ok(gear.getAttribute('title') && gear.getAttribute('aria-label'),
    '⚙ 是本插件设置的唯一入口，必须有 title/aria-label');
  assert.ok(close.getAttribute('title') && close.getAttribute('aria-label'));
  p.close();
});

test('App 形态角标是设计稿的窗口图形，不是字符占位（Figma 7:25）', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', snapshotOf([
    rec({ sessionId: 'cli1', tty: '/dev/ttys001' }),
    rec({ sessionId: 'app1', agent: 'codex', threadId: '01a08a1d-4f63-7e30-af03-48ae77b414b5', form: 'app', tty: null })
  ]));
  const formOf = (id) => p.$(`.row[data-session-id="${id}"] .form-badge`);
  // CLI 档保持设计稿的 `>_` 文本
  assert.strictEqual(formOf('cli1').dataset.form, 'cli');
  assert.strictEqual(formOf('cli1').textContent, '>_');
  // App 档：窗口图形由两个子元素画出（外框 + 顶部标题栏），且不含任何文字
  const app = formOf('app1');
  assert.strictEqual(app.dataset.form, 'app');
  assert.strictEqual(app.textContent, '', 'App 角标不得再用 ▭ 之类的字符占位');
  assert.ok(app.querySelector('.win-frame'), '缺少窗口外框');
  assert.ok(app.querySelector('.win-bar'), '缺少窗口标题栏横条');
  p.close();
});

test('角标底色/描边对齐设计稿（#2A2E39 底 + #3A3F4C 描边、圆角 4.5、图标白色）', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const m = css.match(/^\.form-badge\s*\{([\s\S]*?)\}/m);
  assert.ok(m, '找不到 .form-badge 规则');
  const form = m[1];
  assert.ok(/border-radius:4\.5px/.test(form), '角标圆角应为 4.5');
  assert.ok(/#3A3F4C|#3a3f4c/.test(form), '角标缺少设计稿的 #3A3F4C 描边');
  assert.ok(/color:#fff|color:#FFF/.test(form), '角标文字/图形应为白色（旧实现是灰色）');
});

test('头部恒单行：标题与汇总胶囊都不换行（两段汇总时也不许挤成两行）', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  // 设计稿头部是一行（Figma 2:3 高 19）。汇总胶囊显两段时（waiting+running）内容变宽，
  // 没有 nowrap 就会把「Agent 会话」和胶囊里的字一起折断——真宿主截图实拍到过。
  assert.ok(/^\.title\{[^}]*white-space:nowrap/m.test(css), '标题必须 nowrap');
  assert.ok(/^\.summary\{[^}]*white-space:nowrap/m.test(css), '汇总胶囊必须 nowrap');
  assert.ok(/^\.topbar\{[^}]*flex-wrap:nowrap/m.test(css), '头部不许换行');
  // 宽度不够时该让胶囊自己收（省略号），而不是把标题或按钮挤走
  assert.ok(/^\.summary\{[^}]*min-width:0/m.test(css) && /^\.summary\{[^}]*overflow:hidden/m.test(css),
    '胶囊要能收缩并裁剪，避免撑爆头部');
});

test('失焦即关：面板一挂载就向宿主声明非常驻（点空白处自动关闭）', () => {
  const pinCalls = [];
  const p = mountPanel({ onSetPanelPinned: (v) => pinCalls.push(v) });
  assert.deepStrictEqual(pinCalls, [false],
    '必须且只需声明一次 setPanelPinned(false)——宿主据此在 blur 时关掉面板');
  p.close();
});

test('旧宿主没有 setPanelPinned 时面板照常工作（能力缺失不炸）', () => {
  const p = mountPanel({ noSetPanelPinned: true });
  p.push('agent-status:snapshot', snapshotOf([rec({ sessionId: 'a' })]));
  assert.strictEqual(p.$$('.row').length, 1, '缺这个 SDK 面时面板仍要正常渲染');
  p.close();
});

// ---- 内联副本 vs 仓内资源：漂移即红 ----
// 「内联一份、文件一份」是两个副本，没有守卫早晚各说各话（本仓库已栽过三次同型跟头）。

function svgPathOf(file) {
  const svg = fs.readFileSync(path.join(ROOT, 'assets', file), 'utf8');
  assert.ok(/viewBox="0 0 24 24"/.test(svg), `${file} viewBox 不是 0 0 24 24`);
  const paths = svg.match(/<path[^>]*\bd="([^"]+)"/g) || [];
  assert.strictEqual(paths.length, 1, `${file} 应为单 path（Simple Icons 原形）`);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), `${file} 不得引用远程资源`);
  return svg.match(/<path[^>]*\bd="([^"]+)"/)[1];
}

function appIconDataUri(file) {
  return 'data:image/png;base64,' +
    fs.readFileSync(path.join(ROOT, 'assets', file)).toString('base64');
}

test('徽标资源存在且 panel 内联副本与之逐字一致', () => {
  const claude = svgPathOf('claude.svg');
  const openai = svgPathOf('openai.svg');
  assert.ok(html.includes(claude), 'panel 内联的 Claude path 与 assets/claude.svg 不一致');
  assert.ok(html.includes(openai), 'panel 内联的 OpenAI path 与 assets/openai.svg 不一致');
});

test('panel 内联词表与 locales/*.json 逐键一致', () => {
  const script = inlineScript();
  const m = script.match(/var CATALOGS = (\{[\s\S]*?\n  \});/);
  assert.ok(m, '找不到内联词表 CATALOGS');
  // eslint 式解析：内联词表是纯对象字面量，用 Function 求值会踩 CSP 红线，
  // 改用 JSON 化的等价读法 —— 只取形如 'key': '值' 的行，够做逐键比对。
  const inlineCatalogs = { 'zh-CN': {}, en: {} };
  let current = null;
  for (const line of m[1].split('\n')) {
    const head = line.match(/^\s*('zh-CN'|en):\s*\{/);
    if (head) { current = head[1].replace(/'/g, ''); continue; }
    const kv = line.match(/^\s*'([\w.]+)':\s*(['"])([\s\S]*?)\2,?\s*$/);
    if (kv && current) inlineCatalogs[current][kv[1]] = kv[3];
  }
  for (const loc of ['zh-CN', 'en']) {
    const disk = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${loc}.json`), 'utf8'));
    const keys = Object.keys(inlineCatalogs[loc]);
    assert.ok(keys.length >= 10, `${loc} 内联词表只解析出 ${keys.length} 条，解析失效`);
    for (const key of keys) {
      assert.strictEqual(inlineCatalogs[loc][key], disk[key],
        `${loc} 的 ${key} 与 locales/${loc}.json 不一致`);
    }
  }
});

test('panel 文案全部经取词，无游离硬编码中文', () => {
  const script = inlineScript();
  // 把内联词表整段挖掉，剩下的脚本里再出现中文字符串字面量就是硬编码
  const body = script.replace(/var CATALOGS = \{[\s\S]*?\n  \};/, '');
  const stripped = body
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const hits = stripped.match(/(['"])[^'"\n]*[一-龥][^'"\n]*\1/g) || [];
  assert.deepStrictEqual(hits, [], `脚本里有硬编码中文: ${hits.join(' | ')}`);
});

// ================= 3. jsdom DOM 验收 =================

test('5 行快照：行数 / waiting 置顶且带描边 class / 各行状态 class / 汇总胶囊', () => {
  // 乱序喂入，排序由 aggregate 定（panel 只按数组顺序渲染）
  const snap = snapshotOf([
    rec({ sessionId: 'r-old', state: 'running', project: 'blog', ts: T0 - 30 * 1000 }),
    rec({ sessionId: 'd-1', state: 'done', project: 'relay-server', ts: T0 - 3 * 60 * 1000 }),
    rec({ sessionId: 'w-1', state: 'waiting', project: 'pet-account', ts: T0 - 32 * 1000 }),
    rec({ sessionId: 'e-1', state: 'running', project: 'broken', pid: 999999, ts: T0 - 90 * 1000 }),
    rec({ sessionId: 'r-new', state: 'running', project: 'desktop_pet', ts: T0 - 5 * 1000 })
  ], { isPidAlive: (pid) => pid !== 999999 });

  // 快照里必须真有这五种态，否则下面的断言是空转
  assert.deepStrictEqual(
    snap.rows.map((r) => r.state).sort(),
    ['done', 'error', 'running', 'running', 'waiting']
  );

  const p = mountPanel();
  p.push('agent-status:snapshot', snap);

  const rows = p.$$('.row');
  assert.strictEqual(rows.length, 5, '渲染行数与快照行数不符');
  assert.strictEqual(rows[0].dataset.sessionId, 'w-1', 'waiting 行没排在最前');
  assert.ok(rows[0].classList.contains('is-waiting'), 'waiting 行缺橙描边 class');
  // 顺序与 class 逐行照抄快照（panel 不得自己排序/改判）
  assert.deepStrictEqual(
    rows.map((el) => el.dataset.sessionId),
    snap.rows.map((r) => r.sessionId)
  );
  rows.forEach((el, i) => {
    assert.ok(el.classList.contains('state-' + snap.rows[i].state),
      `第 ${i} 行状态 class 与快照的 ${snap.rows[i].state} 不符`);
  });
  // 非 waiting 行不得误戴描边
  assert.strictEqual(p.$$('.row.is-waiting').length, 1);

  assert.strictEqual(p.$('#summary').hidden, false, '有运行中会话时汇总胶囊应显示');
  // 胶囊最多两段，waiting > running > done：本快照 1 waiting + 2 running + 1 done，
  // done 让位（与徽标两段上限同一条取舍规则）
  const parts = p.$$('#summary .summary-part');
  assert.strictEqual(parts.length, 2, '胶囊应显示两个状态段');
  assert.ok(parts[0].classList.contains('is-waiting'), '第一段应是 waiting');
  assert.strictEqual(parts[0].textContent, '1 等待批准');
  assert.ok(parts[1].classList.contains('is-running'), '第二段应是 running');
  assert.strictEqual(parts[1].textContent, '2 运行中');
  assert.strictEqual(p.$('#empty').hidden, true, '有会话时不应显示空态');
  p.close();
});

// 2026-09-11 真机缺陷（用户截图）：2 运行中 + 2 已完成时，胶囊只显示「2 运行中」，
// 已完成不见踪影。修复后第二个名额给 done。
test('汇总胶囊：运行中 + 已完成同屏显示（done 占第二段）', () => {
  const snap = snapshotOf([
    rec({ sessionId: 'r1', state: 'running', ts: T0 - 30 * 1000 }),
    rec({ sessionId: 'r2', state: 'running', ts: T0 - 60 * 1000 }),
    rec({ sessionId: 'd1', state: 'done', ts: T0 - 60 * 1000 }),
    rec({ sessionId: 'd2', state: 'done', ts: T0 - 2 * 60 * 1000 })
  ]);
  assert.strictEqual(snap.summary.running, 2);
  assert.strictEqual(snap.summary.done, 2, '前置：summary 必须带 done 计数');

  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  const parts = p.$$('#summary .summary-part');
  assert.strictEqual(parts.length, 2);
  assert.ok(parts[0].classList.contains('is-running'));
  assert.strictEqual(parts[0].textContent, '2 运行中');
  assert.ok(parts[1].classList.contains('is-done'), '已完成必须占据第二段');
  assert.strictEqual(parts[1].textContent, '2 已完成');
  p.close();
});

test('汇总胶囊：只有已完成时单独显示绿段', () => {
  const snap = snapshotOf([rec({ sessionId: 'd1', state: 'done', ts: T0 - 60 * 1000 })]);
  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  assert.strictEqual(p.$('#summary').hidden, false, '有已完成会话时胶囊应显示');
  const parts = p.$$('#summary .summary-part');
  assert.strictEqual(parts.length, 1);
  assert.ok(parts[0].classList.contains('is-done'));
  assert.strictEqual(parts[0].textContent, '1 已完成');
  p.close();
});

test('副行文案与颜色 class 跟随状态（含 unknown 不显示为完成）', () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'w', state: 'waiting', ts: T0 }), dir);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  const snap = agg.aggregate(sf.readSnapshots(dir), { now: T0, isPidAlive: () => true, t });

  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  const byId = {};
  for (const el of p.$$('.row')) byId[el.dataset.sessionId] = el;

  assert.strictEqual(byId.w.querySelector('.subline').textContent, t('state.waiting'));
  assert.ok(byId.w.classList.contains('state-waiting'));

  const unknown = byId.broken;
  assert.ok(unknown, '损坏文件应有一行 unknown');
  assert.ok(unknown.classList.contains('state-unknown'));
  assert.strictEqual(unknown.querySelector('.subline').textContent, t('state.unknown'));
  assert.notStrictEqual(unknown.querySelector('.subline').textContent, t('state.done'),
    'unknown 绝不能显示为已完成');
  p.close();
});

test('running 行显 mm:ss，done 行显相对时间', () => {
  const snap = snapshotOf([
    // 2 分 40 秒：必须小于 STALE_UNKNOWN_MS（3 分钟），否则新规则会把它判成 unknown ——
    // 「running 超过 3 分钟没心跳就不再宣称正在跑」是 2026-09-11 修的真机缺陷，不是这里要绕开的。
    rec({ sessionId: 'run', state: 'running', ts: T0 - (2 * 60 + 40) * 1000 }),
    rec({ sessionId: 'fin', state: 'done', ts: T0 - 2 * 60 * 1000 })
  ]);
  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  const timeOf = (id) => p.$(`.row[data-session-id="${id}"] .time`).textContent;
  assert.strictEqual(timeOf('run'), '02:40', 'running 行时间不是 mm:ss');
  assert.strictEqual(timeOf('fin'), t('time.minutesAgo', { n: 2 }), 'done 行时间不是相对时间');
  p.close();
});

test('厂牌徽标：Claude 陶土底 SVG / Codex 与 WorkBuddy 用真实彩色 App 图标，角标区分 CLI 与 App', () => {
  const snap = snapshotOf([
    rec({ sessionId: 'c', agent: 'claude-code', ts: T0 }),
    rec({ sessionId: 'x', agent: 'codex', ts: T0 - 1000 }),
    // WorkBuddy 行的 sessionId 必须是 UUID 形态：深链接 workbuddy://chat/<uuid> 只接受
    // 合法 UUID（lib/codex-deeplink.js 的防注入白名单），脏 id 拿不到落点，
    // 2026-09-12「按落点过滤」起会整行隐藏——夹具要和生产同构。
    rec({ sessionId: '2f5c1e90-0b7a-4f3d-9a11-7c6d5e4b3a21', agent: 'workbuddy', form: 'app', tty: null, ts: T0 - 2000 })
  ]);
  const p = mountPanel();
  p.push('agent-status:snapshot', snap);

  const badgeOf = (id) => p.$(`.row[data-session-id="${id}"] .badge`);
  assert.ok(badgeOf('c').classList.contains('is-claude'));
  assert.ok(badgeOf('x').classList.contains('is-codex'));
  // Claude 主图标是仓内官方 SVG 的 path，不是字母占位
  assert.strictEqual(badgeOf('c').querySelector('svg path').getAttribute('d'), svgPathOf('claude.svg'));
  // Codex 2026-09-12 改用**真实蓝色 Codex App 图标**：黑白 OpenAI 星标是 ChatGPT 的厂牌标，
  // 不是 Codex 这个产品的长相，用户按图标认产品会认错。
  const cxImg = badgeOf('x').querySelector('img');
  assert.ok(cxImg, 'Codex 徽标必须是 img（真实彩色图标），不再是单色 SVG');
  assert.strictEqual(cxImg.getAttribute('src'), appIconDataUri('app-codex.png'),
    'Codex 徽标必须用 assets/app-codex.png（与底栏启动器同一张图）');
  assert.strictEqual(badgeOf('x').querySelector('svg'), null,
    'Codex 不该再有单色 OpenAI SVG');
  // WorkBuddy：栅格产品图（内联 data URI），不是 SVG path 也不是字母占位
  const WB = '2f5c1e90-0b7a-4f3d-9a11-7c6d5e4b3a21';
  assert.ok(badgeOf(WB).classList.contains('is-workbuddy'));
  const wbImg = badgeOf(WB).querySelector('img');
  assert.ok(wbImg, 'WorkBuddy 徽标必须是 img');
  assert.ok(wbImg.getAttribute('src').startsWith('data:image/png;base64,'), '图必须内联（零远程资源红线）');
  assert.strictEqual(badgeOf(WB).querySelector('svg'), null);
  // 形态角标：CLI（>_）与 App 各归各
  assert.strictEqual(badgeOf('c').querySelector('.form-badge').dataset.form, 'cli');
  assert.strictEqual(badgeOf('c').querySelector('.form-badge').textContent, '>_');
  assert.strictEqual(badgeOf(WB).querySelector('.form-badge').dataset.form, 'app');
  p.close();
});

test('空态：三要素 + 未接入显蓝色主按钮，Codex 是真次入口（US-006 落地）', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0, waiting: 0, total: 0, unknown: 0 } });

  assert.strictEqual(p.$('#empty').hidden, false, '无会话时应显示空态');
  assert.strictEqual(p.$('#list').hidden, true);
  assert.strictEqual(p.$('#summary').hidden, true, '零运行中时汇总胶囊应隐藏');
  assert.strictEqual(p.$('#empty-title').textContent, t('empty.title'));
  assert.strictEqual(p.$('#empty-desc1').textContent, t('empty.desc1'));
  assert.strictEqual(p.$('#empty-desc2').textContent, t('empty.desc2'));

  const install = p.$('#install-claude');
  assert.strictEqual(install.hidden, false, '未接入应显示一键接入主按钮');
  assert.strictEqual(install.textContent, t('empty.installClaude'));
  assert.strictEqual(p.$('#installed').hidden, true);
  assert.strictEqual(p.$('#uninstall-claude').hidden, true);

  // US-006 之前这里是「即将支持」灰字（禁假入口）；US-006 落地后它必须是真按钮 ——
  // 点了确实会写 ~/.codex/hooks.json。留着灰字才是这时候的假入口（功能有了却没入口）。
  const codex = p.$('#install-codex');
  assert.strictEqual(codex.hidden, false, '未接入 Codex 时应显示 Codex 接入次入口');
  assert.strictEqual(codex.textContent, t('empty.installCodex'));
  assert.strictEqual(codex.tagName, 'BUTTON', 'US-006 落地后 Codex 入口必须是真按钮');
  assert.strictEqual(p.$('#codex-installed').hidden, true);
  assert.strictEqual(p.$('#uninstall-codex').hidden, true);
  // 未接入时不提信任：那是接入之后才需要做的事
  assert.strictEqual(p.$('#codex-trust').hidden, true);
  p.close();
});

test('空态：Codex 已接入 → 已接入 ✓ + 移除 + 信任提示；与 Claude 各自独立翻面', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });
  // 只装了 Codex，没装 Claude —— 两档必须各显各的，不能被对方的状态带着走
  p.push('agent-status:install-state', { claude: false, codex: true });

  assert.strictEqual(p.$('#install-codex').hidden, true, '已接入不该再显示 Codex 接入按钮');
  assert.strictEqual(p.$('#codex-installed').hidden, false);
  assert.strictEqual(p.$('#codex-installed').textContent, t('empty.codexInstalled'));
  assert.strictEqual(p.$('#uninstall-codex').hidden, false);
  assert.strictEqual(p.$('#uninstall-codex').textContent, t('empty.uninstallCodex'));
  // facts §hook trust：installer 不代写 hooks.state，所以必须显式告诉用户去点 Trust，
  // 否则钩子装好了 Codex 也不会跑，用户只会觉得插件坏了
  assert.strictEqual(p.$('#codex-trust').hidden, false, '接入 Codex 后必须提示信任步骤');
  assert.strictEqual(p.$('#codex-trust').textContent, t('empty.codexTrust'));
  // Claude 那档不受影响
  assert.strictEqual(p.$('#install-claude').hidden, false, 'Codex 已接入不该把 Claude 也标成已接入');
  assert.strictEqual(p.$('#installed').hidden, true);
  p.close();
});

test('点 Codex 接入 → 发 agent-status:install-codex 意图（panel 不自己改配置）', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });
  p.$('#install-codex').dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(p.emitted.map((e) => e.name), ['agent-status:install-codex']);
  p.close();
});

test('点移除 Codex 钩子 → 发 agent-status:uninstall-codex 意图', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });
  p.push('agent-status:install-state', { claude: false, codex: true });
  p.$('#uninstall-codex').dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(p.emitted.map((e) => e.name), ['agent-status:uninstall-codex']);
  p.close();
});

test('空态：已接入 → 已接入 ✓ + 移除钩子，主按钮收起', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });
  p.push('agent-status:install-state', { claude: true });

  assert.strictEqual(p.$('#install-claude').hidden, true, '已接入不该再显示接入按钮');
  assert.strictEqual(p.$('#installed').hidden, false);
  assert.strictEqual(p.$('#installed').textContent, t('empty.installed'));
  assert.strictEqual(p.$('#uninstall-claude').hidden, false);
  assert.strictEqual(p.$('#uninstall-claude').textContent, t('empty.uninstall'));
  p.close();
});

test('点一键接入 → 发 agent-status:install-claude 意图（panel 不自己改配置）', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });
  p.$('#install-claude').dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(p.emitted.map((e) => e.name), ['agent-status:install-claude']);
  p.close();
});

test('点移除钩子 → 发 agent-status:uninstall-claude 意图', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });
  p.push('agent-status:install-state', { claude: true });
  p.$('#uninstall-claude').dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(p.emitted.map((e) => e.name), ['agent-status:uninstall-claude']);
  p.close();
});

test('点会话行 → 发 agent-status:jump{sessionId}', () => {
  // canJump 由 tool 注入（判定在 lib/terminal-jump.js）；能跳的行才是可点态，见 US-005
  const snap = snapshotOf([
    rec({ sessionId: 'aaa', project: 'alpha', ts: T0 }),
    rec({ sessionId: 'bbb', project: 'beta', ts: T0 - 1000 })
  ], { canJump: () => true });
  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  p.$('.row[data-session-id="bbb"]').dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(p.emitted.length, 1);
  assert.strictEqual(p.emitted[0].name, 'agent-status:jump');
  // 载荷来自 jsdom realm，原型不同 realm，deepStrictEqual 会因原型不等而红 —— 逐字段比
  assert.deepStrictEqual(Object.keys(p.emitted[0].data), ['sessionId']);
  assert.strictEqual(p.emitted[0].data.sessionId, 'bbb');
  p.close();
});

// 2026-09-11 用户需求二：「可能已中断」点一下让它消失。error 行常连终端归属都判不出
// （canJump=false），原来根本不绑点击——可收起的行（canDismiss）也要是可点态，
// 点击同样发 jump 意图，收不收由 tool 按状态裁决（panel 不自己判语义）。
test('canDismiss 行即使不能跳转也可点：点击发 jump 意图', () => {
  const snap = snapshotOf([
    rec({ sessionId: 'err', state: 'running', ts: T0 - 90 * 1000, pid: 999999 }),
    rec({ sessionId: 'run', state: 'running', ts: T0 - 5000 })
  ], { isPidAlive: (pid) => pid !== 999999, canJump: () => false });
  const byId = Object.fromEntries(snap.rows.map((r) => [r.sessionId, r]));
  assert.strictEqual(byId.err.state, 'error', '前置：应有 error 行');
  assert.strictEqual(byId.err.canJump, false, '前置：终端归属判不出');
  assert.strictEqual(byId.err.canDismiss, true, '前置：行带 canDismiss 标志');

  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  const errEl = p.$('.row[data-session-id="err"]');
  assert.ok(errEl.classList.contains('can-dismiss'), 'error 行应有可点态 class（手型）');
  errEl.dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(p.emitted.length, 1, '点击应发出意图');
  assert.strictEqual(p.emitted[0].name, 'agent-status:jump');
  assert.strictEqual(p.emitted[0].data.sessionId, 'err');
  // 对照：running 且不能跳的行仍不可点（不给点了没反应的假入口）
  const runEl = p.$('.row[data-session-id="run"]');
  assert.ok(!runEl.classList.contains('can-jump') && !runEl.classList.contains('can-dismiss'),
    'running 不可跳的行不该有可点态');
  runEl.dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(p.emitted.length, 1, '点它不该发意图');
  p.close();
});

test('快照带 jumpError → 该行下方渲染 Danger 色行内错误条', () => {
  const snap = snapshotOf([
    rec({ sessionId: 'ok', project: 'alpha', ts: T0 }),
    rec({ sessionId: 'bad', project: 'beta', ts: T0 - 1000 })
  ]);
  // US-005 经快照回推：给失败那一行挂 jumpError
  const reason = t('jump.unavailable');
  snap.rows.find((r) => r.sessionId === 'bad').jumpError = reason;

  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  const bars = p.$$('.jump-error');
  assert.strictEqual(bars.length, 1, '只有出错那一行该有错误条');
  assert.strictEqual(bars[0].dataset.sessionId, 'bad');
  assert.strictEqual(bars[0].textContent, reason);
  // 紧跟在出错行之后（DESIGN.md「该行下方」）
  assert.strictEqual(bars[0].previousElementSibling.dataset.sessionId, 'bad');
  // Danger 色由 .jump-error 规则给（色值断言在静态 token 那条）
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const rule = css.match(/\.jump-error\s*\{([^}]*)\}/)[1];
  assert.ok(/color:var\(--danger\)/.test(rule), '行内错误条不是 Danger 色');
  p.close();
});

test('快照更新会替换旧行，不叠加', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', snapshotOf([rec({ sessionId: 'a', ts: T0 })]));
  assert.strictEqual(p.$$('.row').length, 1);
  p.push('agent-status:snapshot', snapshotOf([
    rec({ sessionId: 'a', ts: T0 }), rec({ sessionId: 'b', ts: T0 - 1000 })
  ]));
  assert.strictEqual(p.$$('.row').length, 2, '第二次快照后行数应为 2，不是累加');
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });
  assert.strictEqual(p.$$('.row').length, 0);
  assert.strictEqual(p.$('#empty').hidden, false, '会话清空后应回到空态');
  p.close();
});

test('英文环境走 en 词表', () => {
  const p = mountPanel({ language: 'en-US' });
  p.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });
  const en = createNodeI18n('en').t;
  assert.strictEqual(p.$('#title').textContent, en('panel.title'));
  assert.strictEqual(p.$('#empty-title').textContent, en('empty.title'));
  assert.strictEqual(p.$('#install-claude').textContent, en('empty.installClaude'));
  p.close();
});

test('locale 以 renderer 的 navigator.language 为准，并把真实语言回报给 tool', () => {
  // 2026-09-11 真机缺陷反转：原来是「快照（tool）说了算」，但 tool 跑在宿主 fork 的
  // utilityProcess 里，那里的 LANG 不代表界面语言——中文用户因此看到整块英文面板。
  // renderer 的 navigator.language 才是权威；面板不再被 tool 覆盖，而是发事件纠正 tool。
  const p = mountPanel({ language: 'zh-CN' });
  const before = p.$('#title').textContent;
  p.push('agent-status:snapshot', Object.assign({}, snapshotOf([]), { locale: 'en' }));
  assert.strictEqual(p.$('#title').textContent, before,
    '标题应保持 renderer 语言，不被 tool 的猜测覆盖');
  const report = p.emitted.find((e) => e.name === 'agent-status:locale');
  assert.ok(report, '应把真实 locale 回报给 tool');
  assert.strictEqual(report.data.locale, 'zh-CN');
  p.close();
});

test('tool 真的把 locale 随快照发出来（不是 panel 自说自话）', () => {
  const emitted = [];
  const petSide = {
    events: { on() {}, emit: (name, data) => emitted.push({ name, data }) },
    pet: { bubble() {}, playAnim() {} }
  };
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'a', ts: T0 }), dir);
  const c = tool.createCollector({ dir, locale: 'zh-CN', now: () => T0, isPidAlive: () => true, createCodexIpc: fakeIpc , threadTitles: { lookup: () => null }, terminalTitles: { lookup: () => null }, rolloutActivity: { activeThreads: () => new Map() }, workbuddySource: { tick: () => {} } });
  c.tick(petSide);
  const snap = emitted.find((e) => e.name === tool.SNAPSHOT_EVENT).data;
  assert.strictEqual(snap.locale, 'zh-CN', 'tool 没把 locale 随快照下发');
  // 契约仍是 {rows, summary}（裁决3），locale 是附加字段
  assert.ok(Array.isArray(snap.rows) && snap.summary);
});

test('面板标题取自词表', () => {
  const p = mountPanel();
  assert.strictEqual(p.$('#title').textContent, t('panel.title'));
  // 原「底部提示」断言随 0.11.0 底栏改版删除：那行字已被 App 启动器取代
  // （docs/design-launcher-proposal.md）。启动器自己的断言见下方「底栏 App 启动器」节。
  p.close();
});

test('✕ 走 pet.ui.closePanel（panel 上下文有这个面）', () => {
  const p = mountPanel();
  p.$('#close').dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(p.closed.length, 1);
  p.close();
});

test('没有 window.pet 也不炸（宿主未注入时面板仍可打开）', () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file://' + PANEL_HTML });
  const doc = dom.window.document;
  assert.strictEqual(doc.getElementById('empty').hidden, false, '裸开面板应落在空态');
  assert.strictEqual(doc.getElementById('title').textContent.length > 0, true);
  dom.window.close();
});

// ================= 4. panel 意图 → tool 侧真有人接（防死代码） =================
//
// 上面几条只证明「按钮发出了意图」。意图没人接的话按钮照样一点反应都没有 ——
// 本仓库已经栽过一次同型（US-003 的 done→动画因名字对不上而从未触发）。
// 这里把两侧接起来跑真链路：panel 发意图 → tool 收 → 真改临时 settings.json → 回推接入态。

// 双向桥：panel 的 emit 喂给 tool 的 on，tool 的 emit 喂给 panel 的 on
// —— 与生产里宿主 events 总线的行为等价（同名事件互通）。
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n${err && err.stack}`);
  }
}

const pending = testAsync('端到端：点接入 → tool 真写 settings.json → 面板翻成「已接入 ✓」', async () => {
  const dir = tmp();
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }, null, 2));

  const toolHandlers = new Map();
  let panel = null;
  // tool 侧的 pet mock：events.on 收 panel 意图，events.emit 直接投递回 panel
  const petToolSide = {
    events: {
      on(name, fn) { toolHandlers.set(name, fn); },
      emit(name, data) { if (panel && panel.hasHandler(name)) panel.push(name, data); }
    },
    pet: { bubble() {}, playAnim() {} },
    scheduler: { every: async () => 'task-1', cancel: async () => {} }
  };

  // panel 侧的 pet mock：emit 转投 tool 的 handler
  const collector = tool.createCollector({ dir, settingsFile, now: () => T0, isPidAlive: () => true, createCodexIpc: fakeIpc , threadTitles: { lookup: () => null }, terminalTitles: { lookup: () => null }, rolloutActivity: { activeThreads: () => new Map() }, workbuddySource: { tick: () => {} } });

  panel = mountPanel();
  // 把 panel 的 emit 接到 tool 上（mountPanel 的 mock 只记流水，这里补上转发）
  const origEmitted = panel.emitted;
  panel.dom.window.pet.events.emit = (name, data) => {
    origEmitted.push({ name, data });
    const fn = toolHandlers.get(name);
    if (fn) fn(data);
  };

  await collector.start(petToolSide);
  panel.push('agent-status:snapshot', { rows: [], summary: { running: 0 } });

  // 初始：未接入
  assert.strictEqual(installerLib.isInstalled({ settingsFile }), false);
  assert.strictEqual(panel.$('#install-claude').hidden, false);

  // 点接入 → 真落盘 + 面板翻面
  panel.$('#install-claude').dispatchEvent(new panel.dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(installerLib.isInstalled({ settingsFile }), true,
    '点了接入但 settings.json 没被真正写入 —— 意图没人接');
  assert.strictEqual(panel.$('#installed').hidden, false, '面板没翻成已接入');
  assert.strictEqual(panel.$('#install-claude').hidden, true);

  // 用户原有配置原样保留（US-002 的铁律，这条链路也得守）
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(after.model, 'opus');

  // 点移除 → 真摘除 + 面板翻回去
  panel.$('#uninstall-claude').dispatchEvent(new panel.dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(installerLib.isInstalled({ settingsFile }), false,
    '点了移除但钩子还在');
  assert.strictEqual(panel.$('#install-claude').hidden, false, '面板没翻回未接入');
  assert.strictEqual(panel.$('#installed').hidden, true);

  await collector.stop(petToolSide);
  panel.close();
});

test('panel 与 tool 的事件名常量逐字一致（两份副本的漂移守卫）', () => {
  const script = inlineScript();
  const pairs = [
    ['EV_SNAPSHOT', tool.SNAPSHOT_EVENT],
    ['EV_INSTALL_STATE', tool.INSTALL_STATE_EVENT],
    ['EV_INSTALL_CLAUDE', tool.INSTALL_CLAUDE_EVENT],
    ['EV_UNINSTALL_CLAUDE', tool.UNINSTALL_CLAUDE_EVENT]
  ];
  for (const [name, expected] of pairs) {
    const m = script.match(new RegExp(`var ${name} = '([^']+)';`));
    assert.ok(m, `panel 里找不到常量 ${name}`);
    assert.strictEqual(m[1], expected, `${name} 与 tool 侧不一致`);
  }
  // 跳转事件名 tool 侧还没有（US-005），先锁住 panel 这一侧的取值
  assert.ok(/var EV_JUMP = 'agent-status:jump';/.test(script));
});

// ---- 收尾 ----
// 上面唯一一条异步用例跑完再收尾，否则临时目录先被删、结果先被打印
pending.then(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\n${failures.length} failed / ${passed} passed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed`);
});

test('focus 行渲染 is-focus 标记（且只有一行）', () => {
  const dir = tmp();
  sf.writeStatus(rec({ sessionId: 'w', state: 'waiting', ts: T0 }), dir);
  sf.writeStatus(rec({ sessionId: 'r', state: 'running', ts: T0 }), dir);
  const snap = agg.aggregate(sf.readSnapshots(dir), { now: T0, isPidAlive: () => true, t });
  const p2 = mountPanel();
  p2.push('agent-status:snapshot', snap);
  const focused = p2.$$('.row.is-focus');
  assert.strictEqual(focused.length, 1, 'is-focus 有且只有一行');
  assert.strictEqual(focused[0].dataset.sessionId, 'w', 'focus 应是 waiting 行');
  p2.close();
});

// ================= 5. 设置视图（US-8 设置面板） =================

test('⚙ 打开设置：列表/空态隐藏、设置组可见；再点回列表', () => {
  const snap = snapshotOf([rec({ sessionId: 'a', state: 'running', ts: T0 })]);
  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  assert.strictEqual(p.$('#settings').hidden, true, '初始设置视图应隐藏');
  p.$('#gear').dispatchEvent(new p.dom.window.Event('click'));
  assert.strictEqual(p.$('#settings').hidden, false);
  assert.strictEqual(p.$('#list').hidden, true, '设置打开时列表要藏');
  assert.strictEqual(p.$('#empty').hidden, true);
  // 设置打开期间快照照常进来，不许把列表顶回来
  p.push('agent-status:snapshot', snap);
  assert.strictEqual(p.$('#list').hidden, true, '快照到达不该顶掉设置视图');
  p.$('#gear').dispatchEvent(new p.dom.window.Event('click'));
  assert.strictEqual(p.$('#settings').hidden, true);
  assert.strictEqual(p.$('#list').hidden, false, '关掉设置要回列表');
  p.close();
});

test('设置视图带「关于」区：展示仓库地址与 Star 号召', () => {
  const p = mountPanel();
  p.$('#gear').dispatchEvent(new p.dom.window.Event('click'));
  assert.strictEqual(p.$('#about').hidden, false, '设置视图里应有「关于」区');
  assert.strictEqual(p.$('#about-url').textContent,
    'https://github.com/ShunyuYao/pet-agent-status', '仓库地址要原样展示，用户能照抄');
  assert.ok(/Star/i.test(p.$('#about-star').textContent), '应有 Star 号召文案');
  // 「关于」属于设置视图，不该在列表态露出来
  p.$('#gear').dispatchEvent(new p.dom.window.Event('click'));
  assert.strictEqual(p.$('#settings').hidden, true);
  p.close();
});

test('点「复制地址」→ 经 ui.copyText 把仓库地址交给用户，按钮翻成已复制', () => {
  const p = mountPanel();
  p.$('#gear').dispatchEvent(new p.dom.window.Event('click'));
  const btn = p.$('#about-copy');
  assert.strictEqual(btn.textContent, '复制地址');
  btn.dispatchEvent(new p.dom.window.Event('click'));
  // 断言用户可观测结果：剪贴板真收到了地址 + 按钮给了确认反馈
  assert.deepStrictEqual(p.copied, ['https://github.com/ShunyuYao/pet-agent-status']);
  assert.strictEqual(btn.textContent, '已复制 ✓');
  assert.ok(btn.classList.contains('is-done'));
  p.close();
});

test('宿主没有 ui.copyText 时点复制不炸，也不谎报「已复制」', () => {
  // 假成功比失败更糟：用户以为地址在剪贴板里，粘出来是别的东西。
  const p = mountPanel({ noCopyText: true });
  p.$('#gear').dispatchEvent(new p.dom.window.Event('click'));
  const btn = p.$('#about-copy');
  btn.dispatchEvent(new p.dom.window.Event('click'));
  assert.strictEqual(btn.textContent, '复制地址', '没真复制就不该翻成「已复制」');
  assert.ok(!btn.classList.contains('is-done'));
  p.close();
});

test('英文环境下「关于」区走 en 词表', () => {
  const p = mountPanel({ language: 'en-US' });
  p.$('#gear').dispatchEvent(new p.dom.window.Event('click'));
  assert.strictEqual(p.$('#about-label').textContent, 'About this plugin');
  assert.ok(/star/i.test(p.$('#about-star').textContent));
  assert.strictEqual(p.$('#about-copy').textContent, 'Copy link');
  p.close();
});

test('IPC 开关默认勾选；settings-state 到达后以 tool 为准并显示连接状态', () => {
  const p = mountPanel();
  assert.strictEqual(p.$('#ipc-toggle').checked, true, '默认开');
  p.push('agent-status:settings-state', { codexIpcEnabled: true, ipcState: 'ready' });
  assert.strictEqual(p.$('#ipc-status').textContent, '已连接');
  assert.ok(p.$('#ipc-status').classList.contains('is-ready'));
  p.push('agent-status:settings-state', { codexIpcEnabled: true, ipcState: 'disabled' });
  assert.ok(p.$('#ipc-status').classList.contains('is-disabled'), '停用态要橙色警示');
  p.push('agent-status:settings-state', { codexIpcEnabled: false, ipcState: 'off' });
  assert.strictEqual(p.$('#ipc-toggle').checked, false, 'tool 说关就是关');
  assert.strictEqual(p.$('#ipc-status').textContent, '已关闭');
  p.close();
});

test('拨动 IPC 开关 → 发 set-setting 意图（改配置的活在 tool 侧）', () => {
  const p = mountPanel();
  const toggle = p.$('#ipc-toggle');
  toggle.checked = false;
  toggle.dispatchEvent(new p.dom.window.Event('change'));
  const intents = p.emitted.filter((e) => e.name === 'agent-status:set-setting');
  assert.strictEqual(intents.length, 1);
  // 载荷对象诞生在 jsdom realm，deepStrictEqual 会因原型不同挂掉 —— 逐字段断言
  assert.strictEqual(intents[0].data.key, 'codexIpcEnabled');
  assert.strictEqual(intents[0].data.value, false);
  p.close();
});

test('设置视图的钩子按钮走同一批接入意图事件，接入态随 install-state 翻面', () => {
  const p = mountPanel();
  p.$('#gear').dispatchEvent(new p.dom.window.Event('click'));
  // 未接入：两厂牌都显接入按钮
  p.push('agent-status:install-state', { claude: false, codex: false });
  assert.strictEqual(p.$('#set-claude-install').hidden, false);
  assert.strictEqual(p.$('#set-codex-install').hidden, false);
  assert.strictEqual(p.$('#set-codex-trust').hidden, true, '没装不提 Trust');
  p.$('#set-claude-install').dispatchEvent(new p.dom.window.Event('click'));
  assert.ok(p.emitted.some((e) => e.name === 'agent-status:install-claude'), '设置里的接入按钮是死的');
  // 已接入：翻成「已接入 ✓」+ 移除入口 + Codex Trust 提示
  p.push('agent-status:install-state', { claude: true, codex: true });
  assert.strictEqual(p.$('#set-claude-install').hidden, true);
  assert.strictEqual(p.$('#set-claude-installed').hidden, false);
  assert.strictEqual(p.$('#set-codex-remove').hidden, false);
  assert.strictEqual(p.$('#set-codex-trust').hidden, false, '装了必须提 Trust（facts §hook trust）');
  p.$('#set-codex-remove').dispatchEvent(new p.dom.window.Event('click'));
  assert.ok(p.emitted.some((e) => e.name === 'agent-status:uninstall-codex'));
  p.close();
});

test('App 任务行渲染：窗口形角标 + 可点（深链接入口）', () => {
  const CID = '01a08a1d-4f63-7e30-af03-48ae77b414b5';
  const snap = snapshotOf([rec({
    sessionId: CID, agent: 'codex', form: 'app', cwd: '', project: 'Codex App',
    tty: null, pid: null, state: 'running', lastEvent: 'ipc:queued-followups-changed',
    source: 'ipc', threadId: CID, ts: T0
  })], { canJump: () => false,
    canJumpWithoutTty: (row) => require(path.join(ROOT, 'lib', 'codex-deeplink.js')).pickNavigator(row) != null });
  const p = mountPanel();
  p.push('agent-status:snapshot', snap);
  const row = p.$('.row');
  assert.ok(row, 'App 行没渲染');
  assert.strictEqual(row.querySelector('.form-badge').dataset.form, 'app');
  assert.ok(row.classList.contains('can-jump'), 'App 行该是可点态（深链接）');
  row.dispatchEvent(new p.dom.window.Event('click'));
  const jumps = p.emitted.filter((e) => e.name === 'agent-status:jump');
  assert.strictEqual(jumps.length, 1);
  assert.strictEqual(jumps[0].data.sessionId, CID);
  p.close();
});

// ================= US-9 会话标题渲染（快照经真实 aggregate 产出） =================

test('有 title 的行主标签显示标题，目录名转 tooltip；无 title 回落 project', () => {
  const p = mountPanel();
  const snap = snapshotOf([
    rec({ sessionId: 'wt', title: '修一下登录页的报错' }),
    rec({ sessionId: 'nt', cwd: '/Users/me/projects/demo2' })
  ]);
  p.push(tool.SNAPSHOT_EVENT, snap);
  const labels = {};
  for (const el of p.$$('.row')) {
    labels[el.dataset.sessionId] = el.querySelector('.project');
  }
  assert.strictEqual(labels.wt.textContent, '修一下登录页的报错', '主标签应是会话标题');
  assert.strictEqual(labels.wt.title, 'demo', '有标题时目录名转 tooltip');
  assert.strictEqual(labels.nt.textContent, 'demo2', '无标题回落项目目录名');
  assert.strictEqual(labels.nt.title, '', '回落态没有多余 tooltip');
  p.close();
});

test('titleFor 注入链贯通：解析出的线程标题渲染进行主标签', () => {
  const p = mountPanel();
  const snap = snapshotOf(
    [rec({ sessionId: 'ct', agent: 'codex', threadId: '01a08a1d-4f63-7e30-af03-48ae77b414b5', title: '兜底名' })],
    { titleFor: () => '查找 Codex 宠物多会话管理' }
  );
  p.push(tool.SNAPSHOT_EVENT, snap);
  assert.strictEqual(p.$('.row .project').textContent, '查找 Codex 宠物多会话管理');
  p.close();
});

// ---- 按落点过滤：隐藏了几条要如实说出来（2026-09-12）----
// 会话凭空消失比多显示一行更糟——用户会以为插件坏了。
// 0.12.0 起底栏换成了 App 启动器（设计有意为之，见 docs/design-launcher-proposal.md），
// 这条说明改挂在列表下方的独立一行 #hidden-note：只有真藏了东西时才出现。

test('有被隐藏的后台会话时，列表下方如实说明条数', () => {
  const p = mountPanel();
  const snap = snapshotOf([
    rec({ sessionId: 'term', tty: '/dev/ttys001', ts: T0 }),
    rec({ sessionId: 'bg1', tty: null, ts: T0 }),      // Ralph 形态：无 tty 无 App 落点
    rec({ sessionId: 'bg2', tty: null, ts: T0 }),
  ]);
  assert.strictEqual(snap.summary.hiddenNoTarget, 2, '前置：应当隐藏两条');
  p.push('agent-status:snapshot', snap);
  const note = p.$('#hidden-note');
  assert.ok(note && !note.hidden, '藏了东西就该有说明行');
  assert.ok(/2/.test(note.textContent), `要说出条数，实际: ${note.textContent}`);
  assert.ok(/后台|隐藏|跳/.test(note.textContent), `要说清为什么，实际: ${note.textContent}`);
  p.close();
});

test('没有被隐藏的会话时不出现说明行（不平白多一句话）', () => {
  const p = mountPanel();
  p.push('agent-status:snapshot', snapshotOf([rec({ sessionId: 'term', tty: '/dev/ttys001', ts: T0 })]));
  assert.strictEqual(p.$('#hidden-note').hidden, true);
  p.close();
});

test('英文环境下隐藏说明也走词表', () => {
  const p = mountPanel({ language: 'en' });
  p.push('agent-status:snapshot', snapshotOf([
    rec({ sessionId: 'term', tty: '/dev/ttys001', ts: T0 }),
    rec({ sessionId: 'bg1', tty: null, ts: T0 }),
  ]));
  const txt = p.$('#hidden-note').textContent;
  assert.ok(/1/.test(txt) && /[A-Za-z]/.test(txt) && !/后台/.test(txt), `实际: ${txt}`);
  p.close();
});

// ---- 底栏 App 启动器（0.11.0，docs/design-launcher-proposal.md）----
// 输入一律是 tool 侧真实事件载荷经 pet.events 送进来，不直调面板内部函数。

test('启动器：装了的 App 渲染成可点图标，顺序即载荷顺序', () => {
  const p = mountPanel();
  p.push(tool.APPS_EVENT, { apps: [
    { id: 'claude', bundleId: 'com.anthropic.claudefordesktop', name: 'Claude', running: false },
    { id: 'codex', bundleId: 'com.openai.codex', name: 'Codex', running: false },
    { id: 'workbuddy', bundleId: 'com.workbuddy.workbuddy', name: 'WorkBuddy', running: false }
  ] });
  assert.strictEqual(p.$('#applauncher').hidden, false, '有 App 时底栏要显示');
  const btns = p.$$('.app-btn');
  assert.deepStrictEqual(btns.map((b) => b.dataset.appId), ['claude', 'codex', 'workbuddy']);
  assert.ok(btns.every((b) => b.tagName === 'BUTTON'), '必须是真按钮（键盘可达）');
  // 素材断言要问「是哪张图」而不是「有没有图」（AGENTS.md 设计红线 2026-09-12 教训）：
  // 底栏必须是**真实彩色 App 图标**（PNG data URI），不是会话行那套单色厂牌 SVG。
  for (const b of btns) {
    const img = b.querySelector('img');
    assert.ok(img, `${b.dataset.appId} 应当用 <img> 渲染真实 App 图标`);
    assert.ok(/^data:image\/png;base64,/.test(img.getAttribute('src')),
      `${b.dataset.appId} 图标必须是内联 PNG data URI（真 App 图标），实际: ${String(img.getAttribute('src')).slice(0, 30)}`);
    assert.strictEqual(b.querySelector('svg'), null,
      `${b.dataset.appId} 不该用单色厂牌 SVG —— 那是会话行徽标的画法，不是设计稿里的底栏图标`);
  }
  p.close();
});

test('启动器：三个 App 的图标各不相同（不是同一张图顶替）', () => {
  const p = mountPanel();
  p.push(tool.APPS_EVENT, { apps: [
    { id: 'claude', name: 'Claude', running: false },
    { id: 'codex', name: 'Codex', running: false },
    { id: 'workbuddy', name: 'WorkBuddy', running: false }
  ] });
  const srcs = p.$$('.app-btn img').map((i) => i.getAttribute('src'));
  assert.strictEqual(new Set(srcs).size, 3, '三个图标必须是三张不同的图');
  assert.ok(srcs.every((s) => s.length > 500), '图标 data URI 不该是空壳/占位');
  p.close();
});

test('启动器：一个都没装 → 整条底栏 hidden（连分隔线，不留占位文案）', () => {
  const p = mountPanel();
  p.push(tool.APPS_EVENT, { apps: [] });
  assert.strictEqual(p.$('#applauncher').hidden, true);
  assert.strictEqual(p.$$('.app-btn').length, 0);
  // 反向守「别偷偷加一句占位文案」：底栏容器里不该出现任何可见文字
  assert.strictEqual(p.$('#applauncher').textContent.trim(), '');
  p.close();
});

test('启动器：没装的那个不出现（不是灰按钮）', () => {
  const p = mountPanel();
  p.push(tool.APPS_EVENT, { apps: [
    { id: 'claude', name: 'Claude', running: false },
    { id: 'workbuddy', name: 'WorkBuddy', running: false }
  ] });
  assert.deepStrictEqual(p.$$('.app-btn').map((b) => b.dataset.appId), ['claude', 'workbuddy']);
  assert.strictEqual(p.$('.app-btn.is-codex'), null, 'Codex 没装就不该有节点');
  p.close();
});

test('启动器：running 的那个带绿点，其余没有', () => {
  const p = mountPanel();
  p.push(tool.APPS_EVENT, { apps: [
    { id: 'claude', name: 'Claude', running: true },
    { id: 'codex', name: 'Codex', running: false }
  ] });
  assert.ok(p.$('.app-btn.is-claude .app-run-dot'), 'running 的要有绿点');
  assert.strictEqual(p.$('.app-btn.is-codex .app-run-dot'), null, '没跑的不该有绿点');
  p.close();
});

test('启动器：点击发 open-app 意图，只带 appId（不带 bundleId）', () => {
  const p = mountPanel();
  p.push(tool.APPS_EVENT, { apps: [
    { id: 'claude', bundleId: 'com.anthropic.claudefordesktop', name: 'Claude', running: false }
  ] });
  p.$('.app-btn.is-claude').dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
  const ev = p.emitted.filter((e) => e.name === tool.OPEN_APP_EVENT);
  assert.strictEqual(ev.length, 1, '应发一条打开意图');
  // 载荷是 jsdom realm 里造的对象，原型与本 realm 不同 → deepStrictEqual 恒假
  // （已实测确认是跨 realm 原型差异，不是产品缺陷）。逐字段断言，且这样更能钉住
  // 真正在意的那条：**除 appId 外不许多带任何键**，尤其不许带 bundleId。
  assert.strictEqual(ev[0].data.appId, 'claude');
  assert.deepStrictEqual(Object.keys(ev[0].data), ['appId'],
    '只带 appId —— bundleId 由 tool 侧从登记表取，渲染进程说了不算');
  p.close();
});

test('启动器：重复推送不叠加节点（每次重画）', () => {
  const p = mountPanel();
  const payload = { apps: [{ id: 'claude', name: 'Claude', running: false }] };
  p.push(tool.APPS_EVENT, payload);
  p.push(tool.APPS_EVENT, payload);
  p.push(tool.APPS_EVENT, payload);
  assert.strictEqual(p.$$('.app-btn').length, 1);
  p.close();
});

test('启动器：从有到无会收起底栏（App 被卸载的路径）', () => {
  const p = mountPanel();
  p.push(tool.APPS_EVENT, { apps: [{ id: 'claude', name: 'Claude', running: false }] });
  assert.strictEqual(p.$('#applauncher').hidden, false);
  p.push(tool.APPS_EVENT, { apps: [] });
  assert.strictEqual(p.$('#applauncher').hidden, true, '装的 App 没了要收起，不能留空带');
  p.close();
});

test('启动器：坏载荷（缺 apps / 非数组）不炸，按空处理', () => {
  const p = mountPanel();
  for (const bad of [undefined, {}, { apps: null }, { apps: 'nope' }]) {
    assert.doesNotThrow(() => p.push(tool.APPS_EVENT, bad), '坏载荷不许把面板打死');
    assert.strictEqual(p.$('#applauncher').hidden, true);
  }
  p.close();
});

test('App 启动器图标：panel 内联 data URI 与 assets/app-*.png 逐字节一致', () => {
  // 同「内联副本 vs 仓内资源」纪律：两份副本没守卫早晚各说各话。
  for (const [appId, file] of [
    ['claude', 'app-claude.png'],
    ['codex', 'app-codex.png'],
    ['workbuddy', 'app-workbuddy.png']
  ]) {
    const expected = 'data:image/png;base64,' +
      fs.readFileSync(path.join(ROOT, 'assets', file)).toString('base64');
    assert.ok(html.includes(expected),
      `panel 内联的 ${appId} 图标与 assets/${file} 不一致（改了图要同步内联副本）`);
  }
});

test('App 图标分辨率足够 Retina（≥78px：行徽标 26pt @3x）', () => {
  // 2026-09-12 教训：首版做成 42px —— 那是照「底栏 21pt @2x」算的，
  // 但同一张图还要给**行徽标 26pt** 用，@2x 就要 52px、@3x 要 78px，
  // 于是在行徽标上被放大 1.24 倍，肉眼可见发糊。
  // Codex 更惨：42px 那张还裁掉了 28% 白边，有效分辨率只剩约 30px。
  // 逐字节守卫（内联副本 vs assets/）对「两边一样糊」恒真，测不出这个问题，故单列一条。
  const MIN = 78;
  for (const file of ['app-claude.png', 'app-codex.png', 'app-workbuddy.png']) {
    const buf = fs.readFileSync(path.join(ROOT, 'assets', file));
    // PNG IHDR：宽高是第 16–23 字节的两个大端 uint32
    assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', `${file} 不是 PNG`);
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    assert.ok(w >= MIN && h >= MIN,
      `${file} 分辨率 ${w}×${h} 不足 ${MIN}px —— 行徽标 26pt @3x 会被放大发糊`);
  }
});
