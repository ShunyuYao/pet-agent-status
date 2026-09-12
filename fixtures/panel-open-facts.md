# 面板打开等待与开合按钮排查（2026-09-12）

## 已复现并修复：打开后等待下一轮快照

旧实现每 2000ms 推送一次快照。tool 激活时虽然立即采集，但 panel 是之后才创建的
renderer，没有接到之前的推送，也没有主动取数。打开后 `ready=false`，列表和空态都隐藏。

隔离真宿主中，在一次推送刚到后关窗重开，旧代码实测：1870ms 才显示会话；文档已加载时
DOM 为 `{rows:0,empty:false}`。修复后同一路径实测 134ms，首个检查点已经有会话。
该数值是本机样本，不是跨机器性能承诺。

修复只用既有 events SDK：panel 挂完所有监听并画完占位后发送 `agent-status:panel-ready`，
tool 回放内存中的最新快照、接入状态、App 启动器和设置状态。不增加轮询、不额外扫描磁盘，
不重复触发宠物提醒，也不把缓存持久化。采集尚未完成时不回放虚假的空态。

验证：

- `tests/panel-bootstrap-test.js`：采集发生在开窗之前，停住定时器、让后续读取失败，再挂载
  真 panel，仍立即显示已有行；覆盖重复开窗、后续状态更新、真实空态和冷启动。
- `tests/e2e/panel-open-e2e.js`：隐藏隔离宿主、真实徽标 DOM 点击和 panel 事件桥；在轮询
  空档重开，700ms 内必须显示夹具会话。另验普通徽标开/关和面板关闭按钮。
- 相关 `dismiss-e2e.js` / `waiting-accuracy-e2e.js` 通过 `with-terminal-fixture.js` 跑真宿主。
  fixture 只隔离进程表与原生 Terminal 执行，并断言真实 tool 输出的完整 AppleScript 指向
  `/dev/ttys999`。不将此测试表述成「原生终端跳转通过」。

直接使用日常终端跑旧 dismiss 用例时，行内报 `spawnSync osascript ETIMEDOUT`；不是首帧
回放导致的 DOM 回归。旧 waiting 用例在无 tty 环境下会因会话没有落点而不显示，故夹具使用
现成的 `PET_AS_TTY` / `PET_AS_PS_OUTPUT` 覆盖。两者均不改变产品实现。

## 尚未复现：用户描述的再次点击刷新而不收起

此问题本轮未改。隐藏实例中，真实徽标 DOM 连点能正常开/关；不能据此宣称真实鼠标也正常。

只读宿主代码显示：`openPanel` 已存在窗口时会关闭；panel 又通过 `setPanelPinned(false)`
要求失焦自动关闭。因此「原生 blur 先关闭 → click 再到达 → 新建窗口」是待验证的可能路径。

取证限制：徽标在 `pet-overlay.html` 独立浮层，不在 `demo/index.html`；CDP 合成鼠标输入和
`Page.bringToFront` 没有稳定触发所需的原生窗口 blur。`document.hasFocus()` 也不能单独作为
BrowserWindow 已失焦的证据。可见实验未得到用户描述的确定复现，不保留假绿的焦点断言。

项目规定修 bug 先复现、宿主仓只读。本轮未修改宿主、未取消失焦关闭、未加猜测性的延时。
