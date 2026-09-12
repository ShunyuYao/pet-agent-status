# 子进程 agent 会话实录（2026-09-12）

问题（用户）：面板里好像混进了"子任务 / 子进程 agent"的会话；从跳转和任务的角度看
它们都不该显示。先查清楚**到底是什么在产生这些行**，再决定怎么过滤。

## 1. 先排除：Task 工具的 subagent **不会**产生行

实测：在本会话里 spawn 一个 `general-purpose` subagent，让它跑 `sleep 20` + 一条命令，
全程 29 秒、2 次工具调用。状态目录**零新增**（subagent 自己数也是 43 个，与开跑前一致）。

原因：subagent 不是独立会话，没有自己的 `session_id`，也不触发 `SessionStart`；
它的工具调用走父会话的 hook（`SubagentStop` 是另一个事件，本插件没挂）。
subagent 的转录落在 `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`，
`meta.json` 里只有 `agentType` / `toolUseId` / `spawnDepth`，没有 session id。

**结论：subagent 这条路本来就是干净的，不用管。**

## 2. 真正的来源：某个 agent 在自己的 Bash 工具里起的 `claude` 子进程

历史记录里抓到的两条（本会话昨天做 E2E 时自己造的）：

```
09-11T16:08 claude-code ended tty=/dev/ttys018 pid=99593 pet-as-empty-live2 ""
09-11T16:08 claude-code ended tty=/dev/ttys018 pid=99593 pet-as-empty-live2 "只回复 ok"
```

它们是 `claude -p …` 跑在本会话的 Bash 工具里产生的**独立会话**（独立 sessionId → 独立一行）。
两处害处：

- **跳不过去**：`tty=/dev/ttys018` 与 `pid=99593` **都是父会话的**——子进程没有自己的终端，
  tty 是继承来的，`resolveAgentPid`（取父链上第一个有 tty 的祖先）也就取到了父会话的 claude。
  点这一行会跳到父会话的终端窗口，那里根本没有这个子会话。
- **不是用户在跟的任务**：结束时照样计进「刚办完」汇总、进徽标、让宠物喊一声。

同类还有脚本起的无头会话，例如 `tty=null pid=52390 project=obcnyk4gy8g471r7u22k`、
title「你是 AI 中台的会议 action 提取器…」——那是 meeting2task 流水线里的一步。
**这一类不在本次过滤范围**（它们的父进程是脚本不是 claude），见 §5。

## 3. 进程树实录（判据来源）

探针 hook 打印 `ps -eo pid=,ppid=,tty=,comm=` 的父链。

**嵌套（`claude -p` 跑在本会话 Bash 工具里）**：

```
CLAUDECODE=1  CLAUDE_CODE_ENTRYPOINT=sdk-cli
  74691(ppid=74690,tty=??) claude          ← 子会话自己
  74690(ppid=74682,tty=??) timeout
  74682(ppid=99593,tty=??) /bin/zsh        ← 父会话的 Bash 工具
  99593(ppid=9762,tty=ttys018) claude      ← 父会话  ★第二个 claude
   9762 -zsh → 9760 /usr/bin/login → 9758 iTermServer-3.6.11 → 1 launchd
```

**交互式终端会话**（同一份实录的上半截）：

```
CLAUDECODE=1  CLAUDE_CODE_ENTRYPOINT=cli
  99593(tty=ttys018) claude → -zsh → login → iTermServer → launchd   ← 只有一个 claude
```

判据定为：**祖先链上除自己这个 claude 外还有第二个 claude = 子进程会话**。

## 4. 一个会致命的假阳性：Claude Desktop App

App 会话的链是 `内嵌 CLI → Claude Helper(NodeService) → Claude(主进程)`：

- 内嵌 CLI：`…/claude-code/<ver>/claude.app/Contents/MacOS/claude`（basename **小写** claude）
- App 主进程：`/Applications/Claude.app/Contents/MacOS/Claude`（basename **大写** Claude）

**匹配若不区分大小写，App 主进程会被当成"第二个 claude"，刚做完的 App 会话支持会整个失效。**
所以比对的是 comm 的 basename 且**区分大小写**（`tests/nested-session-test.js` 有一条
专门守这个，并反向断言夹具里确实存在会被大小写不敏感误命中的祖先）。

## 5. 本次**不**过滤的两类（留给用户定夺）

- **脚本起的无头会话**（Ralph 循环、bug 监控、meeting2task 流水线）：父进程是 shell/python
  而非 claude，链上只有一个 claude，按本判据仍会显示。它们同样跳不过去（tty=null），
  但也可能正是用户想盯的长任务，语义上不属于"子任务"，故不擅自过滤。
- **`CLAUDE_CODE_ENTRYPOINT`**：交互式是 `cli`、`-p` 是 `sdk-cli`。它区分的是"有没有界面"
  而不是"是不是子进程"——顶层的 `claude -p` 也会是 sdk-cli。要不要把所有无头会话一并
  隐藏，是上一条的同一个决定，等用户拍板再动。

## 6. 方向性保守（fail-open）

ps 读不出来、链上找不到自己、npm 安装形态（comm 是 `node` 匹配不到 claude）——
一律当作**不是**子进程会话，照常显示。漏掉一条子进程会话只是噪音；
错删一条用户真在跟的会话是丢信息。

## 7. 活体验证（真机，非夹具）

- 在本会话 Bash 工具里跑真实 `claude -p "运行 echo hello 然后回复 done"`（走改后的 hook、
  隔离状态目录）：跑完整轮、退出码 0，状态目录 **[]** —— 一条都没落。
- 同一个 hook 喂顶层进程表：照常落盘 `state=running`、带 title 与 since。
- 本会话（真交互式）自己的行全程健在。
