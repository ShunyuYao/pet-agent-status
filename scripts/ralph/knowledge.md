# Ralph Codebase Knowledge — pet-agent-status

> 跨运行持续积累。实施/验证 agent 每次开始前必读。

## 项目形态（先建立正确心智模型）

- 这是**桌宠宿主的插件**，不是独立应用：入口是 `manifest.json` + `tool/index.js`（宿主
  utilityProcess 里跑，`activate(pet)` 收到 SDK 对象）+ `panel/panel.html`（宿主 BrowserWindow
  里加载，`window.pet` 由宿主 preload 注入）。**本仓库自己跑不起来 UI**，离线测试就是全部门禁。
- 宿主契约只读参考路径见 `AGENTS.md`「宿主契约」节；**不得使用 sdk-surface.js 里不存在的
  `pet.*` 方法**（panel 上下文没有 scheduler/net，tool 才有）。
- `pet.scheduler.every(ms, fn)` 是异步的（返回 Promise 的 taskId，必须 await 存 id），最小间隔
  被宿主钳到 1000ms；插件 deactivate 时宿主自动取消定时器，但自己 `setInterval` 的要自己清。
- panel↔tool 只经 `pet.events.emit/on`；事件名带 `agent-status:` 前缀防撞。

## 测试模式（本仓库的"真实通道"边界）

- hook 脚本测试：用 `fixtures/` 里的真实事件 JSON 喂 stdin（`node hooks/xxx.js < fixture.json`
  或 spawn 写 stdin），断言状态文件内容。**不许直调脚本内部函数自证**。
- 路径隔离：所有测试用 `mkdtemp` 临时目录 + `PET_AGENT_STATUS_DIR`/`PET_AS_CLAUDE_SETTINGS`
  环境变量覆盖，绝不读写真实 `~/.claude`、`~/.local/state`。
- panel DOM 测试：`jsdom`（已装在 devDependencies）加载 `panel/panel.html`，注入 mock
  `window.pet`（events.on 触发快照），断言渲染出的 DOM（行数/排序/class/文案）。
- osascript 不真跑：跳转模块设计成「生成 AppleScript 文本的纯函数 + 薄执行壳」，测试断言
  生成文本与目标 tty/应用匹配；真实聚焦冒烟由监工做。
- 时间相关逻辑（stale/idle/节流）把 `now` 作为可注入参数，测试不 sleep。

## 已知事实

- Claude Code hooks 官方事件：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
  Notification / Stop / SessionEnd（stdin 收 JSON，含 session_id/cwd 等字段）。映射表在
  PROTOCOL.md，hook 侧只写 running/waiting/done/ended 四种，推导态归采集器。
- Codex CLI 的 hooks 机制**待监工本机实测**（`fixtures/codex-hooks-facts.md`）；该文件不存在时
  US-006 不许开工（防照猫画虎写出对不上真实事件名的实现）。
  > 2026-09-10 更新：该文件与 `fixtures/codex-events/*.json` 实录夹具已由监工提供
  > （Codex CLI 0.153.4，commit abb7290），US-006 前置门**已解锁**。

## 状态文件命名铁律（US-001 返工换来的，别再踩）

- 状态目录里区分「正式状态文件」与「写入中的临时文件」**只按 `.json` 后缀**：
  正式 = `<sanitizedSessionId>.json`；临时 = `.tmp-<id>-<pid>-<rand>.tmp`（不带 `.json`）。
- **任何地方都不许用 `.tmp-` 前缀判定文件性质**。`.tmp-` 是 PROTOCOL.md 白名单
  `[A-Za-z0-9._-]` 允许的合法 sessionId 内容，不是文件类型标记 —— 靠前缀过滤会把
  `.tmp-session` 这种真会话静默吃掉（records 少一条且 unknownCount 为 0，无诊断）。
- 推论（写测试时注意）：夹具里造临时文件必须与 `writeStatus` **真实产出同形**（`.tmp` 结尾）。
  上轮缺陷之所以溜过 18 条测试，就是因为夹具造的 `.tmp-halfway.json` 是现实中不存在的形态。

## 删除粒度必须等于身份粒度（US-002 第 3 轮返工换来的）

改用户配置时，**认领用什么粒度判定，就必须用什么粒度删除**。US-002 的 `isOurs` 按
「分组内某条 command」认领，却按**整个分组**删除 —— 用户把自己的命令追加进本插件写出的
那个分组（Claude Code 的 `hooks.<Event>[].hooks` 是数组，允许一组多条，手改配置时这么干
最顺手）时，他那条会被连带抹掉且无任何提示。这是不可逆的用户配置丢失。

推论（写「不误伤」类测试时注意）：**造了「不同分组共存」的用例不等于覆盖了「同一分组共存」**。
两者是不同的容器层级，前者绿不代表后者不炸 —— 上一版正是只造了前者才让缺陷溜过 21 条测试。
凡是「只删自己的」需求，用例都要同时覆盖「兄弟容器」与「同容器内兄弟元素」两种共存形态。
另：分组里还剩用户内容时，本插件的 marker 字段要一并去掉（那组已不属于本插件）。

## 「空了就删」是错的判据，删除权来自创建归属（US-002 裁决 2 换来的）

上一条把粒度修到了**条目层**（认 command 就只删那条 command），但 uninstall 在**键层**
仍写着「摘完为空就删 key」—— 这个判据与「是谁创建的」无关，于是用户原有的
`PreCompact: []`（占位、或临时把钩子注释掉时很常见的写法）被静默删掉。
**空数组/空对象不是垃圾，是用户的配置内容**；本插件只有权收回自己造的东西。

正确判据：**能不能删 = 是不是我造的**，与「现在空不空」是两个独立条件，要同时成立。
落法是 install 时把归属显式记在自己的条目里（`createdKey` / `createdHooks`），
uninstall 读它决定收不收。两个坑：

1. **重装要沿用首次安装的归属判断**，不能按「本次安装前 key 在不在」重算 ——
   那时 key 已被上次 install 造出来，重算恒为 false，卸载就再也收不回自己造的 key，
   反向留一堆空壳（实测：装两次再卸留下 7 个空数组键）。
2. **容器归属必须显式记录，不能从子元素归属反推**。用户留一个空 `hooks: {}` 时，
   7 个事件 key 全是本插件造的，「key 全是我的 ⇒ 容器也是我的」会把用户的空容器删掉。

可迁移推论：凡是「装了要能干净卸载」的需求，判据都是**创建归属**而非**当前是否为空**；
归属信息要在创建时就落盘记下来，事后从内容形态反推一定会在某个边界上猜错。

## 展示态盖住原始态 = 下游触发器变死代码（US-003 换来的）

`aggregate` 把 `done`/`ended` 推成 `idle`（展示需要：灰、随后淡出）。`pet-link` 原本
按 `row.state` 判迁移，于是**永远等不到 `done`** —— DESIGN.md 的头号联动
「差事办完啦」在生产里一次都不会触发，是彻底的死代码。

根因：**一个字段同时承担「怎么显示」和「实际发生了什么」两个职责**。展示态是有损的
（done/ended → idle 是多对一），下游一旦需要原始语义就再也还原不回来。
修法：行里 `state`（展示态，panel 用）与 `raw`（落盘态，联动用）分开，各取所需。

可迁移推论：**派生字段覆盖原始字段时，原始值要一并带下去**，别指望下游从派生值反推
（与「归属信息要在创建时落盘」是同一类错误的两个面孔）。

写测试时的连带坑：`pet-link` 的单元用例用裸 `{state:'done'}` 造行，而 aggregate 真实
产出的是 `{state:'idle', raw:'done'}` —— **夹具与真实产出不同形**，所以 21 条联动测试
全绿也没拦住这个缺陷。这是 US-001「临时文件形态不真实」、US-002「settings.json 排版
不真实」之后的**第三次同型复发**：造行的辅助函数必须照着被测上游的真实输出造。

## 实录夹具的字面值不许抄进断言（US-002 裁决 2 顺带发现）

`fixtures/claude-code-events/*.json` 由监工用真实会话实录回填，`session_id`/`cwd`
会随重录而变。测试若把某次录制的 `fx-sess-001` 之类字面值抄进断言，换一份实录就红，
**且红的原因与被测行为无关**（本轮开工时 claude-hook-test 与 claude-installer-test
就各有一处这样的陈旧断言在红）。断言一律从夹具现读（`fixtureOf(name).session_id`）。

另注：目前 6 份是同一次实录（同一 session_id），`notification-permission.json` 仍是
早期合成样例（那次冒烟没触发权限提示），**会话 id 与其余 6 份不同**。凡需要「同一会话
连续多事件」的用例，别直接混用这 7 份夹具 —— 会写出两个状态文件。测试里已加一条
「实录夹具 session_id 一致」的漂移守卫，重录后先看它。

## 传给宿主的「名字」必须来自宿主的合法集合（US-003 裁决换来的）

`pet.playAnim(name)` 的 name 不是自由字符串。宿主消费端（`demo/renderer.js`）写的是
`if (s==='wake') {...} else if (ANIM[s] || STATE_FALLBACK[s]) setState(s);`
—— **两个集合都不命中就什么都不做，无告警、无异常、无回落**。所以名字写错的代价不是
报错，是「插件这边一切正常、真机上什么都不发生」。US-003 首版写的
`'receive-message'` 就是这样：DESIGN.md 的头号联动 done→动画，一次都没播过。

合法全集（`lib/pet-link.js` 的 `HOST_ANIM_STATES` 存了只读快照）：
ANIM 键来自 `character-registry.js` 的 `STATE_DIR_NAME`（idle/walk/sleep/wake/speak/
send/drag/unread/edgehide/peek/unpeek/greet/dropempty/dropfull），
`STATE_FALLBACK`（renderer.js）额外含 think。**只要在 ANIM 里宿主就会播**；
同时在 STATE_FALLBACK 里的（unread/greet 之外还有 send/drag 等）多一层保险：
角色包缺该套素材时能回落。选 `unread`（未读信息）是因为语义正是「收到消息」。

**为什么 122 条测试拦不住**：mock pet 只记「playAnim 被调用了」，不校验参数 ——
正是 AGENTS.md 门禁明令禁止的「断言某函数被调用」。断言调用次数与顺序，锁不住
「这个名字宿主认不认」。修法是把宿主合法集合写进测试常量做白名单断言，
且**用例要观察真实传参**（从 mock 的调用记录里取 arg 校验），不是比对常量自己。

可迁移推论：**凡是把字符串交给宿主/外部系统去查表的地方**（动作名、事件名、
状态名），都要在仓内存一份合法集合快照并写成断言。判据是「外部认不认」，
不是「我方调没调」—— 后者恒真，前者才载重。这是「测试绿 ≠ 生产有效」的第四次复发
（前三次都是夹具形态不真实，这次是参数取值不真实）。

写这类白名单断言时注意别过度收紧：US-003 本轮一度把「必须在 STATE_FALLBACK 里」
也升成硬门槛，结果把 verify 报告点名认可的次选 `greet` 判红了 —— 而 `greet` 在
ANIM 里，宿主照样播。**门槛要卡在宿主真正的判定条件上**（在不在 ANIM/STATE_FALLBACK），
额外的加分项（有没有替身）只作记录，不作门禁。

## 同步的测试壳跑 async 用例 = 把红的显示成绿的（US-005 换来的）

前 6 个测试文件的 `test(name, fn)` 壳是同步的（`try { fn() } catch`）。US-005 的端到端
用例需要 `await collector.start()`，照抄那个壳之后，**async 用例的断言失败变成未捕获
rejection，在汇总行之后才炸** —— 屏幕先打「48 passed」再打堆栈，退出码虽然非 0，
但肉眼读输出会以为全绿。这不是少测几条，是显示反了。

修法：用例排队后串行 `await`（`for (const {name,fn} of queue) { await fn() }`）。
写新测试文件时若含 async 用例，别照抄旧壳。

## 注入点悄悄回落到真实实现，比不支持注入更坏（US-005 换来的）

`tool` 的注入判据写成 `typeof d.psTree === 'function'`，测试注的却是**数组**
（被注入方 `terminal-jump` 数组和函数都吃）。类型对不上 → 注入被**静默忽略** →
端到端用例实际去 spawn 了真实 `ps`。本机恰好真有终端进程，部分断言还歪打正着地绿了。

正确做法二选一：注入点两种形态都收，或类型不符时**抛错**。悄悄回落是最坏的一档 ——
测试看起来在用夹具，其实在碰真环境，夹具改什么都不影响结果（断言恒真的又一种形态）。

顺带的正面做法：「测试没真跑外部命令」要**观测**而非声明 —— `node -r` 预加载补丁把
`child_process` 的入口全包一层，命中禁跑的命令就抛，再把整套测试跑一遍。
补丁自身也要反证一次（直接调一次被禁的命令，确认真抛）。

## 反证必须连「改坏动作真生效了」一起确认（US-006 换来的）

「改坏实现看断言是否转红」是本项目验断言非恒真的标准手法，但它有个静默失败模式：
**perl/sed 没匹配上时，实现根本没被改坏，看到的"仍绿"是假信号**，很容易被读成
「实现有额外韧性」而放过一条恒真断言。US-006 的备份用例正是这样差点溜过 ——
先 grep 确认那行 short-circuit 确实已从源码里消失，才认定问题在测试而不在实现。

那条断言恒真的根因也值得记：序列排成 `install ×2 → uninstall → install`，
而 **uninstall 已把文件还原回原文**，此时就算刷新备份，复制的也是一模一样的字节。
**要验「A 不该覆盖 B」，必须让动作发生在 A 与 B 确实不同的那一刻**；
序列末尾状态与初始状态相同的用例，天然不具备区分能力。

## 断言的前提自己要先成立（US-006 换来的）

hook 在管道里跑时 `tty` 必为 null（协议明写「拿不到为 null」），
拿这样一条记录去断言 `canJump === true` 是在验一个不成立的前提 —— 红了不是实现的错。
修法不是把 tty 硬造进 hook 产出（那就是「夹具与真实产出不同形」的第四次复发），
而是：端到端用例让断言**跟着实际产出走**（`canJump === (tty != null)`，pty 下也成立），
另立一条用带 tty 的记录把该链路无条件跑通。**环境相关的量不要写死期望值，
要么跟着实际走，要么另造一个前提确实成立的用例。**

## 「同构的第二份」提取共用内核，别抄（US-006 换来的）

Codex 的 `hooks.json` 与 Claude 的 `settings.json` hooks 段结构同构。抄一份 250 行
过来最省事，但那 250 行背着 US-002 **四轮返工**换来的三条不变量（备份首份不覆盖 /
摘除粒度=command / 删键判据是创建归属）—— 抄 = 把三条 fork 成两份，改一处漏一处，
且新的那份从没被那四轮检验过。正确做法是提取 `createInstaller(spec)` 把差异参数化。

判据：**既有那份的公开 API 一字不改，既有测试原样全绿**，就是重构没走样的证据
（US-006 提取后 Claude 侧 203 条测试零改动通过）。做不到这点说明抽象抽错了。

## 「落地前显示即将支持」的反面：落地后还留着灰字才是假入口（US-006 换来的）

DESIGN.md 写「US-006 落地前显示『即将支持』灰字，禁止假入口」，US-004 据此写了条
「Codex 必须是灰字非按钮」的测试。US-006 落地后**这条测试必须跟着翻面** ——
功能有了却不给入口，同样是假入口（用户看到「即将支持」会以为没做）。
可迁移推论：**带「某 story 落地前/后」条件的验收项，是一份到期要改的契约**，
后续 story 实施时要主动去翻它，别看到红了就以为自己写坏了。
