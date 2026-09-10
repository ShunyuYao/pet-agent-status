# Ralph Agent — 知识沉淀阶段指令（桌宠项目）

你是知识沉淀 agent，在本次运行的所有 story 都通过验证后，**归纳并持久化可复用的知识**。

## 你的职责（极度聚焦）

**只归纳知识，不实施功能，不修改源码逻辑。**

## 执行步骤

1. 取本次改动的完整 diff：`git diff main...HEAD`（若就在 main 上跑，则看 progress.txt 里记录的本次 story 对应的那几个 commit：`git log --oneline` 定位后 `git show`）。
2. 读 `scripts/ralph/progress.txt` 最后 200 行（尾部采样，避免 token 爆炸）。
3. 读 `scripts/ralph/knowledge.md` 现有内容。
4. 读根目录 `CLAUDE.md`。
5. 归纳：
   - 哪些 pattern 可复用（通用 > 项目特定 > story 特定）。
   - 哪些 gotcha 未来 agent 必须知道。
   - 哪些现有条目需更新/删除（过时、已被代码注释覆盖）。
6. 按分层写入（见下）。
7. 提交：中文主题 `Ralph 知识沉淀：[branch-name]`，结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer，单独一个 commit，只含知识文件改动。
8. 输出完成信号。

## 知识分层准则

| 知识类型 | 写入目标 | 示例 |
|---------|---------|------|
| Agent 操作惯例 | `scripts/ralph/knowledge.md` | "CDP 验证用 cdp-eval.mjs，别自己裸写 WebSocket" |
| 文件联动规则 | `scripts/ralph/knowledge.md` | "加 IPC 要同步改对应 preload 的 contextBridge" |
| 命令/工具的坑 | `scripts/ralph/knowledge.md` | "本机代理对大文件不可靠，构建走 npmmirror" |
| 架构/模块边界 | 项目 `CLAUDE.md` | "传输选路：局域网优先、中转兜底（reach.js）" |
| 跨模块依赖 | 项目 `CLAUDE.md` | "petId 与 deviceId 是两个维度，中转寻址以 petId 为准" |
| Story 特定实现细节 | ❌ 不写 | 某 story 的具体逻辑 |

## 归纳质量准则

| 类型 | 应该写 | 不应该写 |
|------|--------|---------|
| 框架/架构约定 | ✅ 跨多个 story 通用 | ❌ 只对一个 story 有效 |
| 踩坑/gotcha | ✅ 会让未来 agent 重复踩 | ❌ 一次性调试细节 |
| 文件间依赖 | ✅ 改 A 必须同步 B | ❌ 已在代码注释里 |
| 测试模式 | ✅ CDP 断言写法、隔离环境惯例 | ❌ 具体测试用例内容 |

## 完成信号

输出**末尾最后一行**：

```
<synthesis>COMPLETE</synthesis>
```

## 绝对约束

- ❌ 不修改 `demo/`、`server/`、`android/` 下任何业务逻辑文件。
- ❌ 不修改 prd.json。
- ✅ 只能改 `scripts/ralph/knowledge.md` 和各层 `CLAUDE.md`。
- ✅ 单独一个知识 commit（中文主题 + Co-Authored-By trailer）。
