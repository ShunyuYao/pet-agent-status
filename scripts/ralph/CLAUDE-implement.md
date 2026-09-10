# Ralph Agent — 实施阶段指令（pet-agent-status 插件仓）

你是自主编码 agent，负责 **pet-agent-status 桌宠插件** 的功能实施。

## 启动前必读

1. `scripts/ralph/knowledge.md`（背景知识，含项目心智模型与测试模式）。
2. `scripts/ralph/progress.txt`（当前进度）。
3. `scripts/ralph/prd.json` → 最高优先级 `passes: false` 的 story；顶层 `prdSource` 指向的 PRD。
4. 该 story 的 `verificationNotes` 非空时**先读懂失败原因再动手**。
5. 根目录 `AGENTS.md`（三条红线 + 质量门禁）与 `PROTOCOL.md`、`DESIGN.md`（权威规格）。

## 你的任务

每轮只实施一个 story：

1. 读 story 的 `criteriaFile`，把每条验收先落成测试再写实现（照需求做功能的硬规矩）。
2. 实施（写代码 + 测试）。
3. 质量门禁：改过的 JS 全 `node --check`；`for t in tests/*-test.js; do node "$t"; done` 全绿。
4. commit：中文直述主题 + story 编号前缀 + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；
   只提交本 story 相关文件。
5. 更新 prd.json 该 story `passes: true`；追加 progress.txt。

## 关键约束

- **三条红线**（AGENTS.md）：插件形态（只走 manifest + pet.* + 披露过的 Node 能力）/
  设计（以 DESIGN.md 为准，含 docs/design/*.png 对照）/ 协议（PROTOCOL.md schema:1）。
- **宿主仓只读**：绝不修改 `/Users/shunyu/projects/desktop_pet/桌宠测试版` 下任何文件。
- 测试全离线：不联网、不起 Electron、不读写真实 `~/.claude`/`~/.codex`/`~/.local/state`
  （一律 mkdtemp + 环境变量覆盖）。真实通道边界见 knowledge.md「测试模式」。
- US-006 依赖 `fixtures/codex-hooks-facts.md`（监工实测提供）；文件不存在时跳过该 story
  （在 progress.txt 写明 BLOCKED 原因），转做其它 `passes:false` story，都没有就正常结束本轮。
- 不发版、不 push、不动宿主。临时进程用完自杀（按自己记的 PID）。

## 进度与完成信号

progress.txt 追加格式与完成信号同通用约定：完成一个 story 后输出末尾最后一行
`<story_completed>US-XXX</story_completed>`。
