# US-XXX — [Story 标题]

> 复制本模板为 `criteria/US-XXX.md`，按 story 删改。7 段结构是验收契约：
> verify agent 逐段执行，第 6/7 段用来对齐"什么算过、什么算假成功"。

## 1. Automated Verification (Code-Based)

- [ ] 改动涉及的每个 JS 文件 `node --check` 通过
- [ ] `node tests/<相关>-test.js` 通过（无相关离线测试则删本条）

## 2. Model-Based Verification

读相关源码逐条判断（写明看哪个文件哪个函数）：

- [ ] [具体行为断言，如：commitX 之后调用了 Y，失败路径有 UI 反馈不假成功]
- [ ] [边界条件：空值/老配置缺字段/并发]

## 3. CDP Verification（UI/交互类 story 必做）

隔离实例由 ralph.sh 起在 CDP 9333。用 `node scripts/ralph/cdp-eval.mjs '<断言>'`：

- [ ] [如：`runCommand("xxx")` 后读 DOM 确认气泡内容]
- [ ] [禁止模拟鼠标点像素]

## 4. Live End-to-End Verification（涉及持久化/中转/重启才需要）

- [ ] [如：改配置 → 查隔离 userData 的 config.json 已更新]
- [ ] [如：杀掉自起实例重启（9334 端口 + 自己的隔离副本），确认状态仍在]
- [ ] 测完：杀掉自己起的全部进程（只按记下的 PID）；teardown 自己的隔离副本

## 5. Full Test Procedure

1. [按顺序列出完整步骤]
2. ...

## 6. What a Passing Report Looks Like

```
VERIFICATION REPORT - US-XXX
node --check:        PASS
[各检查项]:          PASS
Teardown:            DONE
Overall: PASS
```

## 7. Common Failure Cases & Handling

- UI 看着成功但 userData JSON 没变 → 假成功 → FAIL。
- 只跑了语法检查、CDP/重启验证没做 → FAIL（唯一可 SKIP 的是隔离实例未就绪，且要写明）。
- 重启后状态丢失 → FAIL。
- 测试进程/隔离副本残留 → 流程未完成，清干净再报告。
