# App 图标素材来源（2026-09-12）

底栏 App 启动器与会话行厂牌徽标用的三张图标，**全部从本机已安装的 .app 里抽取**，
不从网上下载（来源可追溯、与用户机器上看到的图标一致）。

| 文件 | 来源路径 | 说明 |
|---|---|---|
| `app-claude.png` | `/Applications/Claude.app/Contents/Resources/electron.icns` | 直接缩放至 78px |
| `app-codex.png` | `/Applications/ChatGPT.app/Contents/Resources/`**`icon-codex-dark-color.png`** | 直接缩放至 78px |
| `app-workbuddy.png` | `/Applications/WorkBuddy.app/Contents/Resources/icon.icns` | 直接缩放至 78px |

## ⚠️ Codex 图标踩过的坑（两次）

**Codex 的正确素材是 `icon-codex-dark-color.png`，不是 `app.icns`。**

`com.openai.codex` 这个 bundleId 解析到 `/Applications/ChatGPT.app`，而该 bundle 里有多张图：

| 文件 | 长相 | 该不该用 |
|---|---|---|
| `app.icns` | 蓝云 + **白色方底**（无圆角、四角不透明） | ❌ 首版误用 |
| `electron.icns` / `icon-chatgpt.icns` | ChatGPT 结标 | ❌ 那是 ChatGPT 不是 Codex |
| **`icon-codex-dark-color.png`** | 蓝云 + **黑色圆角底板**，四角透明 | ✅ 深色面板用这张 |
| `icon-codex-light.png` | 蓝云 + 白色圆角底板，四角透明 | 浅色背景才用 |

两次返工：
1. 先用了 `app.icns`，在深色面板上显成一块**亮白瓷砖**；
2. 于是自作主张「裁掉白边、近白转透明」——把**官方图标的底板裁没了**，
   变成一朵孤零零的云，与官方长相不符。用户指出「官方图标下面还垫着一块」才发现
   bundle 里本来就有 dark 变体。

**教训**：抽 App 图标前先 `find <App>.app -iname "*icon*"` 看全量候选，
`.icns` 只是其中一个、且常常是**主 app 的**而非子产品的；别对官方素材做二次裁剪，
"看着不对" 多半是选错了文件，不是图本身要改。

## 尺寸

源文件保持 **78px**，与本次在线设计使用的原始 App 素材一致。行徽标裁切框28pt，图片叶节点35pt；底栏裁切框32pt，图片叶节点40pt。两处均依 Figma 显示125%、偏移-12.5%，仅改变显示裁切，不擦除底板、不重新加工源像素。原先「26pt @3x / 底栏21pt」是旧稿尺寸，不能继续作为布局依据。

`tests/panel-dom-test.js` 守住原始分辨率和素材一致性；`test:figma-layout` 在真实宿主检查裁切框、图片位置、解码结果，并保存背景截图供视觉复核。

## Inter 字体

`inter-latin.woff2`：复用本机项目 `claude_code_source/cc-haha/desktop/public/fonts/inter-latin.woff2` 的原始字节。已读取字体 name/fvar 表确认 family=Inter、版本4.001（git-66647c0bb）、weight=100–900，版权属于 Inter Project Authors。项目上游为 https://github.com/rsms/inter；完整 SIL OFL 1.1 随 `Inter-OFL.txt` 分发。字体与图标同样内联到 panel，运行时无远程请求。
