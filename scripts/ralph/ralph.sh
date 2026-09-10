#!/bin/bash
# Ralph v2 — 桌宠项目三阶段自治 agent 循环。
#
# implement → verify（每个 story）→ synthesize（结尾一次）→ 本地 commit。
#
# 从 creaibo_agentic_producer 的 Ralph v2 编排器移植，桌宠适配点：
#   - JS 命令式内核 + React/TypeScript UI：按改动范围执行 node --check、构建、lint 与 tests/
#   - verify 的 dev app 是隔离 userData 的桌宠 Electron 实例（live-env.sh 建副本，
#     重置 petId 防止和真桌宠在中转服务器上打架），CDP 端口默认 9333（手工调试
#     用 9222，互不冲突）
#   - 编排器只杀自己进程组，绝不 pkill 全局 electron（本机可能有真桌宠在跑）
#   - 与其它 ralph.sh 互斥：mkdir 原子锁 scripts/ralph/.lock（按 branchName 判接管）
#   - 与 bug-monitor / 需求流水线互斥：机器级锁 ~/.deskpet-pipeline.lock
#     （demo/feature-pipeline/pipeline-lock.js，两边共用；放 $HOME 以跨 worktree 生效）
#   - 提交规范按仓库惯例：中文直述主题 + Co-Authored-By trailer
#   - finalize 把工作分支推到 remote 备份，但**绝不推 main**、不发版
#     （合并进 main 由需求流水线或人决定；发版走 release-to-feishu.sh，人来）
#
# 用法: ./ralph.sh [--tool claude|codex] [--phase implement|verify|synthesize|all] [max_iterations]
# 环境: RALPH_CDP_PORT(9333) RALPH_SKIP_APP=1 RALPH_STALL_TIMEOUT(秒,默认900)
#       RALPH_AGENT_POLL_INTERVAL(看门狗轮询秒数,默认5；runner 合同测试可缩短)
#       RALPH_MODEL_DEFAULT(agent 默认模型) — 各 story 可在 prd.json 里用 "model" 字段覆盖 implement 阶段模型
#       RALPH_MAX_REOPEN(默认2) — 单 story 被 reopen 达此次数即熔断停机(exit 2)交人工，设 0 关闭
#       RALPH_DUAL_TRACK(默认1，设0关闭) — verify 判 PASS 后跑独立第二意见；后端缺失自动退化为 no-op
#       RALPH_DUAL_TRACK_TOOL(默认codex，可选claude) — 第二轨用哪个模型；跨厂商独立性更强，故默认 codex
#       RALPH_DUAL_TRACK_MODEL(默认opus) — RALPH_DUAL_TRACK_TOOL=claude 时用哪个模型
#       RALPH_DUAL_TRACK_TIMEOUT_S(默认600) — 单次双轨调用的硬墙钟上限

set -e

TOOL="claude"
PHASE="all"
MAX_ITERATIONS=10
RALPH_MODEL_DEFAULT="${RALPH_MODEL_DEFAULT:-}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --tool) TOOL="$2"; shift 2 ;;
    --tool=*) TOOL="${1#*=}"; shift ;;
    --phase) PHASE="$2"; shift 2 ;;
    --phase=*) PHASE="${1#*=}"; shift ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then MAX_ITERATIONS="$1"; fi
      shift ;;
  esac
done

if [[ "$TOOL" != "claude" && "$TOOL" != "codex" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be claude|codex." >&2
  exit 1
fi
if [[ "$TOOL" == "claude" && -z "$RALPH_MODEL_DEFAULT" ]]; then
  # 用 'opus' 别名而非写死版本号：CLI 会解析成当前最新的 Opus，模型换代后不必回来改这里
  # （曾写死 claude-opus-4-8，Opus 5 发布后仍在跑旧模型）。
  RALPH_MODEL_DEFAULT="opus"
fi
if [[ "$PHASE" != "implement" && "$PHASE" != "verify" && "$PHASE" != "synthesize" && "$PHASE" != "all" ]]; then
  echo "Error: Invalid phase '$PHASE'. Must be implement|verify|synthesize|all." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_BRANCH_FILE="$SCRIPT_DIR/.last-branch"
LOCK_DIR="$SCRIPT_DIR/.lock"

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required." >&2
  exit 1
fi
if ! command -v "$TOOL" >/dev/null 2>&1; then
  echo "Error: $TOOL CLI is required for --tool $TOOL." >&2
  exit 1
fi
if [ ! -f "$PRD_FILE" ]; then
  echo "Error: $PRD_FILE not found. 先用 /prd 写 PRD、再用 /ralph skill 生成 prd.json（参考 prd.json.example）。" >&2
  exit 1
fi

# ── 启动前工作区门禁 ────────────────────────────────────────────────────────
# prd.json 的 branchName 不是自动切分支指令，只是本轮 Ralph 的身份合同。
# 若实际分支不同，继续运行会在错误分支提交、归档并接管错误的陈锁。
PRD_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
ACTUAL_BRANCH=$(git -C "$PROJECT_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
if [ -z "$PRD_BRANCH" ]; then
  echo "Error: prd.json 缺少 branchName，拒绝启动 Ralph。" >&2
  exit 1
fi
if [ -z "$ACTUAL_BRANCH" ]; then
  echo "Error: 当前 checkout 处于 detached HEAD，Ralph 必须运行在明确分支上。" >&2
  exit 1
fi
if [ "$ACTUAL_BRANCH" != "$PRD_BRANCH" ]; then
  echo "Error: prd.json branchName=${PRD_BRANCH}，实际分支=${ACTUAL_BRANCH}。请先在对应独立 worktree/分支准备并提交 Ralph 输入。" >&2
  exit 1
fi

# 完整自治 run 会创建本地提交并在 finalize 收尾，因此必须从干净工作区开始。
# 单阶段模式保留给人工诊断，允许脏工作区但明确告警。
INITIAL_STATUS=$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=all)
if [ -n "$INITIAL_STATUS" ] && [ "$PHASE" = "all" ]; then
  echo "Error: 完整 Ralph run 要求干净工作区。请先提交 Ralph 输入并移走无关改动：" >&2
  echo "$INITIAL_STATUS" >&2
  exit 1
elif [ -n "$INITIAL_STATUS" ]; then
  echo "  [ralph.sh] WARNING: 单阶段模式在脏工作区运行；不会替你收拢或提交这些改动。" >&2
fi

# ── 互斥锁 ───────────────────────────────────────────────────────────────────
# 同一 checkout 里 Ralph、bug-monitor 派发的 agent、手工 Claude / Codex 会话可能并发改代码。
# mkdir 是原子操作；锁里存 PID + branchName + 启动命令行。
# 隔离原则（2026-07-15 事故后加固）：
#   - 持锁者仍存活 → 直接退出，绝不抢占（不同 session 互不干扰的核心）。
#   - 陈锁（持锁者已死）→ 只接管「同 branchName」的陈锁；不同分支的陈锁不接管，
#     避免一个失控会话（如 Codex 自跑 `--phase all 24`）在别的会话空窗期蹭进来改错分支。
#   - RALPH_LOCK_STRICT=1 → 连同分支陈锁也不接管，发现任何锁即退出（最保守）。
LOCK_BRANCH="$PRD_BRANCH"
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    echo "$LOCK_BRANCH" > "$LOCK_DIR/branch"
    return 0
  fi
  local holder holder_branch
  holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
  holder_branch=$(cat "$LOCK_DIR/branch" 2>/dev/null || echo "unknown")
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    echo "Error: 另一个 ralph.sh 正在运行（PID ${holder}，分支 ${holder_branch}，锁 ${LOCK_DIR}）。当前分支 ${LOCK_BRANCH} 退出，不抢占。" >&2
    exit 1
  fi
  if [ "${RALPH_LOCK_STRICT:-0}" = "1" ]; then
    echo "Error: 发现锁（陈锁，持有者 ${holder:-unknown}/${holder_branch}），RALPH_LOCK_STRICT=1 下不接管，退出。" >&2
    exit 1
  fi
  if [ "$holder_branch" != "$LOCK_BRANCH" ] && [ "$holder_branch" != "unknown" ]; then
    echo "Error: 陈锁属于不同分支（${holder_branch}），当前 ${LOCK_BRANCH} 不接管，退出。请人工确认 .lock 归属后再跑。" >&2
    exit 1
  fi
  echo "  [ralph.sh] 发现同分支陈锁（持有者 ${holder:-unknown}/${holder_branch} 已退出），接管。"
  echo $$ > "$LOCK_DIR/pid"
  echo "$LOCK_BRANCH" > "$LOCK_DIR/branch"
}
release_lock() {
  if [ -f "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$LOCK_DIR"
  fi
}

# ── 启动前鉴权门禁 ─────────────────────────────────────────────────────────
# agent CLI 未登录/会话过期时，implement agent 会「0 输出、几十毫秒内失败」，
# Ralph 连续两轮无推进后熔断退出——日志里只有一句 OAuth 报错，看起来像 PRD 或
# 备料有问题，实际是环境没鉴权。2026-08-21 在 mac_mini 上真踩到：
# 交互式 claude 登录过期，但 launchd plist 里的 CLAUDE_CODE_OAUTH_TOKEN 仍有效，
# 而 token 没沿着「守护进程 → 开发段 agent → nohup ralph.sh」这三跳传下来。
#
# 这里先花 1 秒探一次，不通就带着可执行的修复指引立刻退出，
# 别浪费两轮 agent 调用去撞同一堵墙。
preflight_auth() {
  [ "${RALPH_SKIP_AUTH_CHECK:-0}" = "1" ] && return 0
  local probe
  probe=$(echo "reply with exactly: ok" | perl -e 'alarm 60; exec @ARGV' -- "$TOOL" -p 2>&1 | tail -3)
  case "$probe" in
    *"Not logged in"*|*"OAuth"*|*"authenticate"*|*"Invalid API key"*|*"credit balance"*)
      echo "Error: ${TOOL} 未鉴权或会话过期，拒绝启动（探测输出：${probe}）" >&2
      echo "       修法二选一：" >&2
      echo "         1) 交互式登录：${TOOL} login（无 GUI 的机器走 device flow）" >&2
      echo "         2) 注入令牌后重跑：export CLAUDE_CODE_OAUTH_TOKEN=<token>" >&2
      echo "            （launchd 常驻进程的 token 在对应 plist 的 EnvironmentVariables 里）" >&2
      echo "       确认已鉴权仍被拦时可用 RALPH_SKIP_AUTH_CHECK=1 跳过本检查。" >&2
      exit 1
      ;;
  esac
}

# ── 机器级流水线锁（与 bug-monitor 共用）───────────────────────────────────
# 上面那把 .lock 只挡「另一个 ralph.sh」，且在独立 worktree 里各有一份，挡不住 bug-monitor。
# 这把锁在 $HOME（跨 worktree 唯一），bug-monitor 派 agent 前也取同一把，
# 两条流水线因此不会同时改代码 / 同时起隔离 Electron（mini 只有 2 GB，起两份会吃爆）。
PIPELINE_LOCK_JS="$(cd "$SCRIPT_DIR/../.." && pwd)/demo/feature-pipeline/pipeline-lock.js"
acquire_pipeline_lock() {
  [ -f "$PIPELINE_LOCK_JS" ] || { echo "Warning: 找不到 $PIPELINE_LOCK_JS，跳过机器级互斥" >&2; return 0; }
  PIPELINE_LOCK_PID=$$ node "$PIPELINE_LOCK_JS" acquire ralph || {
    echo "Error: 另一条流水线（bug-monitor / 需求流水线）正在这台机器上跑，ralph 退出让路。" >&2
    echo "       查看持有者：node $PIPELINE_LOCK_JS status" >&2
    exit 1
  }
  PIPELINE_LOCK_HELD=1
}
release_pipeline_lock() {
  [ "${PIPELINE_LOCK_HELD:-0}" = "1" ] || return 0
  PIPELINE_LOCK_PID=$$ node "$PIPELINE_LOCK_JS" release ralph >/dev/null 2>&1 || true
  PIPELINE_LOCK_HELD=0
}

# ── verify 阶段的隔离桌宠实例（CDP） ─────────────────────────────────────────
# live-env.sh 建隔离 userData 副本（保留 AI/讯飞 key、重置 petId、剥离飞书凭据），
# 用 PET_USERDATA_DIR 起隔离 Electron + --remote-debugging-port。
# 端口默认 9333（不占手工调试的 9222）；只杀自己进程组，不动别人的实例。
RALPH_CDP_PORT="${RALPH_CDP_PORT:-9333}"
RALPH_CDP_URL="http://127.0.0.1:$RALPH_CDP_PORT"
APP_PID=""
APP_USERDATA=""

start_app() {
  # 离线 story（不碰 UI/中转）可 RALPH_SKIP_APP=1 跳过，browser 检查记 SKIP。
  if [ "${RALPH_SKIP_APP:-0}" = "1" ]; then
    echo "  [ralph.sh] RALPH_SKIP_APP=1 — 不启动桌宠实例（CDP 检查将 SKIP）。"
    return 0
  fi
  echo "  [ralph.sh] 建隔离 userData 副本..."
  APP_USERDATA=$(bash "$SCRIPT_DIR/live-env.sh" setup-path)
  echo "  [ralph.sh] 启动隔离桌宠实例：CDP $RALPH_CDP_URL, userData $APP_USERDATA"
  local had_monitor=0; [[ $- == *m* ]] && had_monitor=1
  set -m
  ( cd "$PROJECT_DIR/demo" && PET_USERDATA_DIR="$APP_USERDATA" \
      PET_E2E_TEST=1 PET_E2E_BACKGROUND=1 PET_E2E_HIDDEN=1 \
      exec npx --no-install electron . --remote-debugging-port="$RALPH_CDP_PORT" ) \
      > "$SCRIPT_DIR/app.log" 2>&1 &
  APP_PID=$!
  [[ $had_monitor -eq 0 ]] && set +m
  # ⚠️ curl 必须带 --max-time：Electron 可能「端口已 LISTEN 但不回响应」
  # （TCP 握手成功、HTTP 无限期挂起，curl -w 实测 HTTP=000）。裸 curl 没有超时，
  # 一次挂起就永远卡在这里——循环上限 30 次形同虚设，整个 Ralph 停摆。
  # 2026-08-21 实测：一个 curl 挂了 35 分钟，supervisor 报 stalled 才发现。
  for _ in $(seq 1 30); do
    if curl -s --max-time 3 -o /dev/null "$RALPH_CDP_URL/json/version" 2>/dev/null; then
      echo "  [ralph.sh] 桌宠实例就绪（PID ${APP_PID}）"
      export RALPH_CDP_PORT RALPH_CDP_URL
      export PET_E2E_USERDATA="$APP_USERDATA"
      return 0
    fi
    sleep 1
  done
  echo "  [ralph.sh] WARNING: 30s 内 CDP 未就绪 — verify agent 将 SKIP browser 检查。"
}

stop_app() {
  if [ -n "$APP_PID" ]; then
    kill -- "-$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
    APP_PID=""
  fi
  if [ -n "$APP_USERDATA" ]; then
    bash "$SCRIPT_DIR/live-env.sh" teardown "$APP_USERDATA" || true
    APP_USERDATA=""
  fi
}

# 跟踪当前 agent 的进程组，trap 时连它拉起的 electron/node 子进程一起收掉
# （残留实例会占 CDP 端口、在中转服务器上留幽灵在线状态）。
CURRENT_AGENT_PGID=""
cleanup() {
  if [ -n "$CURRENT_AGENT_PGID" ]; then
    kill -- "-$CURRENT_AGENT_PGID" 2>/dev/null || true
  fi
  stop_app
  release_lock
  release_pipeline_lock
}
trap cleanup EXIT INT TERM

preflight_auth        # 先探鉴权：没登录就别占锁让别人干等
acquire_lock
acquire_pipeline_lock

# 分支切换时重置 progress（归档在 finalize 里做）。
if [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    echo "Branch changed: $LAST_BRANCH → $CURRENT_BRANCH"
    { echo "# Ralph Progress Log"; echo "Started: $(date)"; echo "---"; } > "$PROGRESS_FILE"
  fi
fi
CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
[ -n "$CURRENT_BRANCH" ] && echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"

if [ ! -f "$PROGRESS_FILE" ]; then
  { echo "# Ralph Progress Log"; echo "Started: $(date)"; echo "---"; } > "$PROGRESS_FILE"
fi

echo "Starting Ralph v2 — Tool: $TOOL — Phase: $PHASE — Max iterations: $MAX_ITERATIONS"
echo "Project: $PROJECT_DIR"
cd "$PROJECT_DIR"

# 给监工留一个「当前 run 在哪」的持久指针。
# 监工原本靠 `pgrep ralph.sh` 反查工作目录，没进程就 exit 0 连体检都不跑——
# 而熔断（exit 2 停机等人工）恰恰就是「没进程」，于是监工在最该介入的时刻必然失明。
# 2026-08-22 实测：17:19 熔断，监工 17:26 那轮打「没有活着的 ralph.sh —— 本轮不做任何事」，
# 而 exited-with-pending 正是 SUPERVISOR.md 里写明的「最重要的信号」。
# 这个文件写在主仓库（监工的固定落脚点），内容是本 run 的工作目录（可能是 worktree）。
# 不删除：留着让监工在 run 结束后仍能定位到最后一次 run；下一次启动会覆盖。
RALPH_MAIN_REPO="$(git -C "$PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's/\/\.git$//')"
if [ -n "$RALPH_MAIN_REPO" ] && [ -d "$RALPH_MAIN_REPO/scripts/ralph" ]; then
  printf '%s\n' "$PROJECT_DIR" > "$RALPH_MAIN_REPO/scripts/ralph/.ralph-current-run" 2>/dev/null || true
fi

# 用指定指令文件跑一次 agent，带 stall 看门狗。stdout 回显 agent 最终文本（供 OUTPUT=$()）。
run_claude() {
  local INSTRUCTION_FILE="$1"
  local PHASE_NAME="${2:-unnamed}"
  local STALL_TIMEOUT="${3:-900}"   # 日志无增长判卡死的秒数；RALPH_STALL_TIMEOUT 可全局覆盖
  STALL_TIMEOUT="${RALPH_STALL_TIMEOUT:-$STALL_TIMEOUT}"
  local AGENT_POLL_INTERVAL="${RALPH_AGENT_POLL_INTERVAL:-5}"

  local LOG_DIR="$SCRIPT_DIR/logs"
  mkdir -p "$LOG_DIR"
  local LOG_FILE="$LOG_DIR/${PHASE_NAME}.jsonl"
  # phase 名会在新的 Ralph 进程中从 implement-1/verify-1 重新计数。
  # 启动子进程前先刷新 mtime，避免父看门狗在重定向发生前读到上次 run 的旧日志并误杀。
  : > "$LOG_FILE"
  touch "$LOG_FILE"

  # 模型：RALPH_AGENT_MODEL 单次覆盖，否则用默认。Codex 留空时使用 CLI 当前默认模型。
  local AGENT_MODEL="${RALPH_AGENT_MODEL:-$RALPH_MODEL_DEFAULT}"
  echo "  [ralph.sh] Agent tool/model: $TOOL/${AGENT_MODEL:-default}" >&2

  # 独立进程组（monitor mode），便于整组收尸。
  local had_monitor=0; [[ $- == *m* ]] && had_monitor=1
  set -m
  local FINAL_FILE="$LOG_DIR/${PHASE_NAME}.final.txt"
  local AGENT_INPUT="$INSTRUCTION_FILE"
  rm -f "$FINAL_FILE"
  if [[ "$TOOL" == "codex" ]]; then
    AGENT_INPUT="$LOG_DIR/${PHASE_NAME}.prompt.txt"
    {
      echo "你正在受控 Ralph 子回合中执行当前 phase。禁止再次运行 scripts/ralph/ralph.sh，禁止启动嵌套 Ralph；其余职责严格遵循下方项目指令。"
      echo "当实施阶段需要提交 story 时，Codex 模式的 trailer 使用：Co-Authored-By: OpenAI Codex <noreply@openai.com>；此规则覆盖下方 Claude 专用 trailer。"
      echo
      cat "$INSTRUCTION_FILE"
    } > "$AGENT_INPUT"
    if [[ -n "$AGENT_MODEL" ]]; then
      codex --dangerously-bypass-approvals-and-sandbox exec --json \
        -C "$PROJECT_DIR" -m "$AGENT_MODEL" -o "$FINAL_FILE" \
        < "$AGENT_INPUT" > "$LOG_FILE" 2>&1 &
    else
      codex --dangerously-bypass-approvals-and-sandbox exec --json \
        -C "$PROJECT_DIR" -o "$FINAL_FILE" \
        < "$AGENT_INPUT" > "$LOG_FILE" 2>&1 &
    fi
  else
    claude --dangerously-skip-permissions --print \
      --model "$AGENT_MODEL" \
      --output-format stream-json --verbose \
      < "$INSTRUCTION_FILE" > "$LOG_FILE" 2>&1 &
  fi
  local CLAUDE_PID=$!
  [[ $had_monitor -eq 0 ]] && set +m
  CURRENT_AGENT_PGID="$CLAUDE_PID"

  # macOS 无 timeout/gtimeout：纯 bash 看门狗，按日志 mtime 判 stall。
  while kill -0 "$CLAUDE_PID" 2>/dev/null; do
    sleep "$AGENT_POLL_INTERVAL"
    local last_mod now
    last_mod=$(stat -f %m "$LOG_FILE" 2>/dev/null || echo 0)
    now=$(date +%s)
    if (( now - last_mod > STALL_TIMEOUT )); then
      echo "  [ralph.sh] Agent stalled (${STALL_TIMEOUT}s no output), killing PG $CLAUDE_PID" >&2
      kill -- "-$CLAUDE_PID" 2>/dev/null || kill "$CLAUDE_PID" 2>/dev/null || true
      sleep 2
      kill -9 -- "-$CLAUDE_PID" 2>/dev/null || true
      wait "$CLAUDE_PID" 2>/dev/null
      CURRENT_AGENT_PGID=""
      return 1
    fi
  done
  wait "$CLAUDE_PID"
  local EXIT_CODE=$?
  CURRENT_AGENT_PGID=""
  if [[ "$TOOL" == "codex" ]]; then
    cat "$FINAL_FILE" 2>/dev/null || true
  else
    jq -r 'select(.type == "result") | .result // empty' "$LOG_FILE" 2>/dev/null
  fi
  return $EXIT_CODE
}

all_stories_done() {
  jq '(.userStories | length) as $total | [.userStories[] | select(.passes == true and .verificationPasses == true)] | length == $total' "$PRD_FILE" 2>/dev/null
}

# 还有 story 需要「实施」（passes:false）
has_impl_work() {
  [ "$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null)" -gt 0 ]
}
# 有 story 已实施完但还没「验证过」（passes:true 且 verificationPasses:false）
has_verify_work() {
  [ "$(jq '[.userStories[] | select(.passes == true and .verificationPasses == false)] | length' "$PRD_FILE" 2>/dev/null)" -gt 0 ]
}
# 已通过验证的 story 计数 —— 用于判断本轮是否推进了进度（防空转熔断）
passed_count() {
  jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo 0
}

# verify FAIL 表示实现合同尚未满足。把 story 放回 implement 队列；否则它会一直保持
# passes:true && verificationPasses:false，下一轮只会重复 verify，永远没有修复机会。
reopen_story_for_implementation() {
  local STORY_ID="$1" TMP_PRD
  TMP_PRD=$(mktemp)
  jq --arg id "$STORY_ID" \
    '(.userStories[] | select(.id == $id) | .passes) = false |
     (.userStories[] | select(.id == $id) | .verificationPasses) = false' \
    "$PRD_FILE" > "$TMP_PRD" && mv "$TMP_PRD" "$PRD_FILE"
}

# ── Reopen 熔断（防镀金 / 防范围爬升）────────────────────────────────────────
# 一个 story 反复被打回（implement 声称完成 → verify/dual-track FAIL 它）通常不是
# 代码真坏，而是验收端在往上爬范围 —— 同源 Creaibo 项目的 US-003 就是这样在 4 次
# reopen 里累积了一整套超范围的 Electron 关闭握手，最终被人工回退。空转熔断（连续 2
# 轮无净推进）抓不住这种情况：镀金迭代每轮都在"推进"（verify FAIL→implement 加码→
# 更严的 bar 上 PASS），passed_count 一直在涨。所以要按 story 记 reopenCount，超过阈值
# 就停机交人工，而不是让验收端继续发明更严的契约。设 0 关闭。
RALPH_MAX_REOPEN="${RALPH_MAX_REOPEN:-2}"

# 给一个"声称完成后又被 FAIL"的 story 的 reopenCount +1，回显新值（缺字段从 0 起）。
bump_reopen() {
  local STORY_ID="$1" TMP_PRD
  TMP_PRD=$(mktemp)
  jq --arg id "$STORY_ID" \
    '(.userStories[] | select(.id == $id) | .reopenCount) |= ((. // 0) + 1)' \
    "$PRD_FILE" > "$TMP_PRD" && mv "$TMP_PRD" "$PRD_FILE"
  jq -r --arg id "$STORY_ID" \
    '.userStories[] | select(.id == $id) | .reopenCount // 0' "$PRD_FILE" 2>/dev/null
}

# reopenCount >= 阈值 → 停机交人工。反复在 implement↔verify 之间弹跳这么多次，
# 意味着 criteria 含糊或验收端在加码，再自动跑一轮也修不好，exit 2 让人裁决。
check_reopen_circuit_breaker() {
  local STORY_ID="$1" COUNT="$2"
  [[ "$RALPH_MAX_REOPEN" -le 0 ]] && return 0
  if (( COUNT >= RALPH_MAX_REOPEN )); then
    echo ""
    echo "==============================================================="
    echo "  [ralph.sh] 熔断：$STORY_ID 已被 reopen $COUNT 次"
    echo "  [ralph.sh] （上限 RALPH_MAX_REOPEN=${RALPH_MAX_REOPEN}）。停机交人工裁决。"
    echo "==============================================================="
    echo "  一个 story 声称完成后反复验证失败，通常是 criteria 含糊或验收端在往上爬"
    echo "  范围（镀金），不是再跑一轮自动迭代能修好的。请人工判断最近这次 FAIL 是："
    echo "    (a) 真实缺口 —— 那就让实现端修；"
    echo "    (b) 超范围加码 —— 那就驳回验收端的要求，把 story 标回 verificationPasses:true；"
    echo "    (c) criteria 措辞问题 —— 那就澄清 criteria 再重启。"
    echo ""
    echo "  过目："
    echo "    scripts/ralph/progress.txt（$STORY_ID 最近的验证报告 + 范围外观察）"
    echo "    scripts/ralph/criteria/$STORY_ID.md（这次 FAIL 的要求在范围内吗？）"
    echo "    scripts/ralph/.codex-acceptance/report-$STORY_ID.md（若跑过双轨）"
    echo ""
    # 发飞书 @ 负责人。熔断意味着「自动流程已尽力，必须人工介入」，而 Ralph 跑在
    # mac_mini 后台、日志没人盯——2026-08-22 实测：US-2 熔断后一直停着，直到人主动来问
    # 才发现。告警失败不改变退出码（它本来就要停机了）。
    if [ "${RALPH_HALT_NOTIFY:-1}" != "0" ]; then
      # node 不在 launchd/非交互 ssh 的 PATH 里，回落到已知安装位置
      local NODE_BIN
      NODE_BIN="$(command -v node 2>/dev/null || echo "$HOME/.local/bin/node")"
      "$NODE_BIN" "$SCRIPT_DIR/notify-halt.js" "$STORY_ID" "$COUNT" "$PROJECT_DIR" 2>&1 | sed 's/^/  /' || true
    fi
    exit 2
  fi
}

# ── 双轨验证（Codex 独立第二意见）────────────────────────────────────────────
# 每次自家 verify agent 判 PASS，就对同一 story 跑一次独立 Codex 核实再采信 ——
# 完整规程见 .claude/skills/dual-track-test/SKILL.md（正常是人工触发的；这里在 story
# 粒度接进循环：一 story = 一次 PASS = 一次 Codex，坏 story 立刻暴露而不是埋在多 story
# 阶段末尾）。cx 不可用时退化为 no-op，绝不阻塞循环 —— 双轨是加分闸，不是硬依赖。
DUAL_TRACK_DIR="$SCRIPT_DIR/.codex-acceptance"
RALPH_DUAL_TRACK="${RALPH_DUAL_TRACK:-1}"   # 设 0 全局关闭双轨

# 第二轨用哪个模型跑：claude（默认）| codex。
# 2026-08-19 曾因 mac_mini 的 Codex 额度耗尽临时改默认为 claude（额度耗尽时双轨会
# 每次静默退化成 no-op——看日志像「跑过了」，实际一条独立意见都没拿到）。
# 2026-08-20 额度恢复，改回 codex：**跨厂商的独立性强于同模型家族**，
# claude 作第二轨存在共模盲区（同一家模型、同一套项目文档，可能犯同一个错）。
# 额度再次耗尽时用 RALPH_DUAL_TRACK_TOOL=claude 切回，两个后端共用同一份 prompt
# 与 <verdict>PASS|FAIL</verdict> 解析，切换不改判据。
#
# ⚠️ 用 claude 跑第二轨时，独立性弱于 Codex：同一模型家族、同一套项目文档，
# 存在共模盲区（两边可能犯同一个错）。缓解手段是**开新会话 + 只读 + 喂一手材料**
# （criteria/PRD 原文，不喂自家 verify 的结论），让它自己反推验收维度而不是复核别人的答案。
# 这仍不等价于跨厂商的独立性——把它当「第二双眼睛」，不当「跨厂商交叉验证」。
RALPH_DUAL_TRACK_TOOL="${RALPH_DUAL_TRACK_TOOL:-codex}"

dual_track_available() {
  [[ "$RALPH_DUAL_TRACK" == "0" ]] && return 1
  case "$RALPH_DUAL_TRACK_TOOL" in
    # cx 是 zsh 交互别名（alias cx='codex --dangerously-bypass-approvals-and-sandbox'），
    # 在 ralph.sh 的非交互 bash 里看不到 —— 直接探底层 codex 二进制。
    codex)  command -v codex  >/dev/null 2>&1 ;;
    claude) command -v claude >/dev/null 2>&1 ;;
    *) echo "  [ralph.sh] 双轨：未知的 RALPH_DUAL_TRACK_TOOL='$RALPH_DUAL_TRACK_TOOL'（应为 claude|codex），跳过。" >&2; return 1 ;;
  esac
}

# 按所选后端拼出「只读、单轮、把判决写进 $2」的命令。
# 两个后端都必须：只读（不许改文件/提交）、独立会话（不继承自家 verify 的上下文）、
# 判决格式统一为 <verdict>PASS|FAIL</verdict>，这样下游解析只有一套。
dual_track_cmd() {
  local PROMPT_FILE="$1" OUT_FILE="$2"
  case "$RALPH_DUAL_TRACK_TOOL" in
    codex)
      # -o 只在最后一次性写入，运行中该文件不存在（别拿它判活）。
      printf '%s\0' codex --dangerously-bypass-approvals-and-sandbox exec \
        -C "$PROJECT_DIR" -o "$OUT_FILE"
      ;;
    claude)
      # 独立第二意见必须开新会话：不带 -r/--session-id，避免继承实施/验证 agent 的上下文。
      # 工具面收到只读集合（不给 Edit/Write/NotebookEdit），从机制上挡住「验证者顺手改代码
      # 让断言变绿」——这正是第二轨要防的失败模式。stdout 即判决，由调用方重定向进 OUT_FILE。
      printf '%s\0' claude -p --model "${RALPH_DUAL_TRACK_MODEL:-opus}" \
        --allowed-tools 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Bash(node --check:*),Bash(cat:*),Bash(ls:*)' \
        --permission-mode acceptEdits
      ;;
  esac
}

# ── 第三方仲裁（双轨分歧时的裁判）──────────────────────────────────────────
#
# 自家 verify 说 PASS、第二轨说 FAIL 时，谁对？原来的做法是默认第二轨对（bump reopen），
# 两次分歧就熔断停机。但第二轨完全可能误判，于是「窄缺口 → 熔断 → 等人」反复发生。
#
# 仲裁者的定位是**裁判，不是第三次验收**：它不重跑测试、不自己推一遍验收，
# 只回答一个问题——「第二轨指出的那条缺口，在 criteria 的原文语义下是否真的成立」。
# 判决二选一：
#   UPHELD    第二轨对 → 走返工路径（bump reopen，下一轮 verify+双轨自然复核）
#   OVERRULED 第二轨误判 → 放行，不计 reopen，且不再回头问第二轨（代码没变，只会循环）
#
# 独立性：必须用与第二轨**不同**的后端。第二轨是 codex 时仲裁用 claude，反之亦然；
# 两者相同就没有第三方可言（同模型家族的共模盲区）。
# 保守原则：不可用、超时、无定论一律返回 INCONCLUSIVE，由调用方按 FAIL 处理——
# 宁可多返工一轮，也不能因为仲裁本身故障把真缺口放过去。
RALPH_ARBITRATION="${RALPH_ARBITRATION:-1}"        # 设 0 关闭仲裁，回到旧行为
ARBITRATION_TIMEOUT_S="${RALPH_ARBITRATION_TIMEOUT_S:-600}"

arbiter_tool() {
  # 与第二轨错开；两个后端只有 claude/codex 两种，直接取对侧。
  case "$RALPH_DUAL_TRACK_TOOL" in
    codex)  echo claude ;;
    claude) echo codex ;;
    *)      echo "" ;;
  esac
}

run_arbitration() {
  local STORY_ID="$1"
  [ "$RALPH_ARBITRATION" = "0" ] && { echo "DISABLED"; return 0; }

  local TOOL REPORT CRITERIA_FILE ACCEPTANCE_JSON PROMPT_FILE OUT_FILE ARB_MD
  TOOL=$(arbiter_tool)
  [ -n "$TOOL" ] || { echo "INCONCLUSIVE"; return 0; }
  command -v "$TOOL" >/dev/null 2>&1 || { echo "INCONCLUSIVE"; return 0; }

  REPORT="$DUAL_TRACK_DIR/report-$STORY_ID.md"
  [ -f "$REPORT" ] || { echo "INCONCLUSIVE"; return 0; }

  CRITERIA_FILE=$(jq -r --arg id "$STORY_ID" '.userStories[] | select(.id == $id) | .criteriaFile // empty' "$PRD_FILE" 2>/dev/null)
  ACCEPTANCE_JSON=$(jq -r --arg id "$STORY_ID" '.userStories[] | select(.id == $id) | .acceptanceCriteria // [] | map("- " + .) | join("\n")' "$PRD_FILE" 2>/dev/null)
  PROMPT_FILE="$DUAL_TRACK_DIR/arbitration-prompt-$STORY_ID.txt"
  OUT_FILE="$DUAL_TRACK_DIR/arbitration-last-$STORY_ID.txt"
  ARB_MD="$DUAL_TRACK_DIR/arbitration-$STORY_ID.md"
  rm -f "$OUT_FILE"

  {
    echo "你是 story $STORY_ID 的**仲裁者**。两方对同一份代码给出了相反结论："
    echo "  · 实施方的验证 agent 判：PASS"
    echo "  · 独立第二意见（${RALPH_DUAL_TRACK_TOOL}）判：FAIL"
    echo ""
    echo "你的任务**不是重做一遍验收**，而是只回答一个问题："
    echo "  第二意见指出的那条缺口，在下面 acceptance criteria 的**原文语义**下是否真的成立？"
    echo ""
    echo "判据（这几条决定你的判决）："
    echo "  1. 缺口指向的要求，是否真的写在 criteria 里？（不在 = 越界要求 = OVERRULED）"
    echo "  2. 若写着，代码现状是否真的不满足？自己去读代码求证，别只信报告的转述。"
    echo "  3. 该要求是否属于本 story 范围？（属于别的 story 或后续迭代 = OVERRULED）"
    echo "  4. 是否只是措辞/风格偏好，而非可观测的行为差异？（是 = OVERRULED）"
    echo ""
    echo "⚠️ 不要因为「报告写得详细/有证据」就采信。也不要因为「想让流程往前走」就 OVERRULED。"
    echo "只按 criteria 原文判。拿不准时判 UPHELD（保守：宁可多返工一轮，也不放过真缺口）。"
    echo ""
    echo "禁止修改任何文件、禁止 commit、禁止起 electron、禁止运行 ralph.sh。只读核实。"
    echo ""
    echo "===== acceptance criteria（一手材料，判据以此为准）====="
    echo "$ACCEPTANCE_JSON"
    if [ -n "$CRITERIA_FILE" ] && [ -f "$PROJECT_DIR/$CRITERIA_FILE" ]; then
      echo ""
      echo "===== $CRITERIA_FILE ====="
      cat "$PROJECT_DIR/$CRITERIA_FILE"
    fi
    echo ""
    echo "===== 第二意见（${RALPH_DUAL_TRACK_TOOL}）的 FAIL 报告 ====="
    cat "$REPORT"
    echo ""
    echo "===== 输出要求 ====="
    echo "先写不超过 15 行的裁决理由（逐条对应上面 4 条判据），最后单独一行输出判决："
    echo "<arbitration>UPHELD</arbitration> 或 <arbitration>OVERRULED</arbitration>"
  } > "$PROMPT_FILE"

  echo "  [ralph.sh] 仲裁：双轨分歧，请 ${TOOL} 做第三方裁决（${STORY_ID}）..." >&2

  local RC=0
  case "$TOOL" in
    codex)
      perl -e "alarm $ARBITRATION_TIMEOUT_S; exec @ARGV" -- \
        codex --dangerously-bypass-approvals-and-sandbox exec -C "$PROJECT_DIR" -o "$OUT_FILE" \
        < "$PROMPT_FILE" >/dev/null 2>&1 || RC=$?
      ;;
    claude)
      perl -e "alarm $ARBITRATION_TIMEOUT_S; exec @ARGV" -- \
        claude -p --model "${RALPH_ARBITRATION_MODEL:-opus}" \
        --allowed-tools 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Bash(node --check:*),Bash(cat:*),Bash(ls:*)' \
        --permission-mode acceptEdits \
        < "$PROMPT_FILE" > "$OUT_FILE" 2>/dev/null || RC=$?
      ;;
  esac

  if [ $RC -ne 0 ] || [ ! -s "$OUT_FILE" ]; then
    echo "  [ralph.sh] 仲裁：${TOOL} 失败或无输出（rc=$RC）—— 保守按 FAIL 处理。" >&2
    echo "INCONCLUSIVE"; return 0
  fi

  cp "$OUT_FILE" "$ARB_MD" 2>/dev/null || true
  if grep -q "<arbitration>OVERRULED</arbitration>" "$OUT_FILE"; then
    echo "OVERRULED"
  elif grep -q "<arbitration>UPHELD</arbitration>" "$OUT_FILE"; then
    echo "UPHELD"
  else
    echo "INCONCLUSIVE"
  fi
}

# 对刚被自家 verify 判 PASS 的单个 story 跑第二轨。PASS / 各种退化路径（工具缺失、
# 出题失败、调用报错、无判决）一律 return 0 且不动 prd.json —— 双轨绝不因基础设施故障
# 把真 PASS 翻成假 FAIL。只有解析到真实 FAIL 时才请第三方仲裁：
#   OVERRULED           → 记 note、维持通过、不计 reopen
#   UPHELD/INCONCLUSIVE → 记 note、**放回 implement 队列**、bump reopen、查熔断
run_dual_track_verify() {
  local STORY_ID="$1"
  if ! dual_track_available; then
    echo "  [ralph.sh] 双轨：${RALPH_DUAL_TRACK_TOOL} 不可用（或 RALPH_DUAL_TRACK=0），跳过 $STORY_ID 的独立核实。"
    return 0
  fi

  mkdir -p "$DUAL_TRACK_DIR"
  local PRD_SOURCE CRITERIA_FILE ACCEPTANCE_JSON PROMPT_FILE OUT_FILE
  PRD_SOURCE=$(jq -r '.prdSource // empty' "$PRD_FILE" 2>/dev/null)
  CRITERIA_FILE=$(jq -r --arg id "$STORY_ID" '.userStories[] | select(.id == $id) | .criteriaFile // empty' "$PRD_FILE" 2>/dev/null)
  ACCEPTANCE_JSON=$(jq -r --arg id "$STORY_ID" '.userStories[] | select(.id == $id) | .acceptanceCriteria // [] | map("- " + .) | join("\n")' "$PRD_FILE" 2>/dev/null)
  PROMPT_FILE="$DUAL_TRACK_DIR/verify-prompt-$STORY_ID.txt"
  OUT_FILE="$DUAL_TRACK_DIR/last-$STORY_ID.txt"
  rm -f "$OUT_FILE" "$DUAL_TRACK_DIR/report-$STORY_ID.md"

  {
    echo "你是 story $STORY_ID 的独立验收核实者。这段代码不是你写的。禁止修改任何产品源文件"
    echo "（demo/**、server/**、android/**）。禁止运行 ralph.sh、禁止起 electron、禁止 commit、"
    echo "禁止发版、禁止 pkill 全局进程。你只做只读核实：可以读文件、跑只读命令"
    echo "（node --check、git show/diff/log、grep、node -e 断言）。不得执行任何会修改仓库或启动长驻进程的命令。"
    echo ""
    echo "一手材料（权威——先读这些，从中形成你自己对意图的理解，不要只勾一份清单）："
    if [ -n "$PRD_SOURCE" ] && [ -f "$PROJECT_DIR/$PRD_SOURCE" ]; then
      echo "- ${PRD_SOURCE}（读覆盖 $STORY_ID 的章节）"
    fi
    if [ -n "$CRITERIA_FILE" ] && [ -f "$SCRIPT_DIR/$(basename "$CRITERIA_FILE")" ]; then
      echo "- scripts/ralph/$CRITERIA_FILE"
    fi
    echo "- docs/react-migration-plan.md 的三条红线（A 插件系统零改动 / B 命令式内核保留 /"
    echo "  C 穿透判定桥接）——迁移类 story 必查这三条有没有被破坏。"
    echo ""
    echo "本 story 的验收项（来自 prd.json，供参考——但先从一手材料的意图反推，别只对这份清单）："
    echo "$ACCEPTANCE_JSON"
    echo ""
    echo "我们自家的 implement+verify agent 已把这个 story 标 passes:true, verificationPasses:true。"
    echo "你的职责是独立第二意见，不是盖章——主动找一手材料暗示、但可能被漏测的缺口。"
    echo "可用 'git log --oneline -20' + 'git show <sha>' 定位本 story 的提交。"
    echo ""
    echo "范围尺子（判 FAIL 前必读）：FAIL 只用于'本 story criteria 明确要求、但代码/测试没做到'。"
    echo "不用于镀金或'还能更健壮'。具体："
    echo "- 你能想到但本 story criteria 没要求的更严做法，不是 FAIL。记成范围外观察并 PASS。"
    echo "- 属于另一个 story 的真实缺口（尤其依赖后续 story 才提供的前置条件），不是本 story 的 FAIL。"
    echo "  归属到对应 US-RXX 并 PASS。"
    echo "- criteria 措辞含糊时取最小自洽解释，不取最大化解释；建议人工澄清，别用你的严格解释去 FAIL。"
    echo "- 例外：三条红线是每个主桌宠 story 的固有验收维度，红线被破坏是真 FAIL，不算超范围。"
    echo "本循环没有'驳回超范围'的反向机制，只有'打回重做'。你若每次都往上爬范围，实现端会把地基"
    echo "story 打磨成镀金（Creaibo US-003 就这样在 4 次 reopen 里累积了超范围的关闭握手，后被人工回退）。"
    echo "同一 story 被 reopen >=$RALPH_MAX_REOPEN 次会触发熔断停机交人工——别把预算花在 criteria 之外的要求上。"
    echo ""
    echo "跑相关的 node --check / criteria 指定的离线测试并记录退出码。"
    echo "把简短报告追加到 $DUAL_TRACK_DIR/report-$STORY_ID.md：你对意图的理解、判断、发现的缺口。"
    echo ""
    echo "你输出的**最后一行**必须且只能是下面之一："
    echo "<verdict>PASS</verdict>"
    echo "<verdict>FAIL</verdict>"
    echo "FAIL 时报告须写明具体哪条不满足、为什么，落在一手材料陈述的意图上。"
  } > "$PROMPT_FILE"

  echo "  [ralph.sh] 双轨：对 $STORY_ID 跑独立 ${RALPH_DUAL_TRACK_TOOL} 验证..."
  # macOS 无 timeout/gtimeout：手工硬墙钟上限，卡死的第二轨绝不阻塞主循环。
  # Codex 的 -o 文件只在最后写，没有中途进度可轮询，flat cap 是唯一且够用的做法。
  local DUAL_TRACK_TIMEOUT_S="${RALPH_DUAL_TRACK_TIMEOUT_S:-600}"
  local had_monitor=0; [[ $- == *m* ]] && had_monitor=1
  # 命令由 dual_track_cmd 按后端产出（NUL 分隔，避免参数里的空格被二次切分）。
  local -a DT_CMD=()
  while IFS= read -r -d '' _arg; do DT_CMD+=("$_arg"); done < <(dual_track_cmd "$PROMPT_FILE" "$OUT_FILE")
  set -m
  if [[ "$RALPH_DUAL_TRACK_TOOL" == "claude" ]]; then
    # claude -p 把判决写到 stdout，这里重定向进 OUT_FILE（Codex 那边由 -o 负责）。
    ( cd "$PROJECT_DIR" && exec "${DT_CMD[@]}" < "$PROMPT_FILE" > "$OUT_FILE" 2>/dev/null ) &
  else
    ( exec "${DT_CMD[@]}" < "$PROMPT_FILE" >/dev/null 2>&1 ) &
  fi
  local CODEX_PID=$!
  [[ $had_monitor -eq 0 ]] && set +m
  CURRENT_AGENT_PGID="$CODEX_PID"
  local waited=0
  while kill -0 "$CODEX_PID" 2>/dev/null; do
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -ge "$DUAL_TRACK_TIMEOUT_S" ]; then
      echo "  [ralph.sh] 双轨：${RALPH_DUAL_TRACK_TOOL} 超 ${DUAL_TRACK_TIMEOUT_S}s（${STORY_ID}），杀掉 —— 不因基础设施故障阻塞。"
      kill -TERM -- "-$CODEX_PID" 2>/dev/null || kill -TERM "$CODEX_PID" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$CODEX_PID" 2>/dev/null || kill -KILL "$CODEX_PID" 2>/dev/null || true
      wait "$CODEX_PID" 2>/dev/null || true
      CURRENT_AGENT_PGID=""
      return 0
    fi
  done
  set +e
  wait "$CODEX_PID"
  local CODEX_EXIT_CODE=$?
  set -e
  CURRENT_AGENT_PGID=""
  if [ "$CODEX_EXIT_CODE" -ne 0 ]; then
    echo "  [ralph.sh] 双轨：${RALPH_DUAL_TRACK_TOOL} 调用报错（${STORY_ID}）—— 不因基础设施故障阻塞。"
    return 0
  fi
  if [ ! -s "$OUT_FILE" ]; then
    echo "  [ralph.sh] 双轨：${RALPH_DUAL_TRACK_TOOL} 无输出（${STORY_ID}）—— 不因基础设施故障阻塞。"
    return 0
  fi

  if grep -q "<verdict>PASS</verdict>" "$OUT_FILE"; then
    echo "  [ralph.sh] 双轨：${RALPH_DUAL_TRACK_TOOL} PASS（${STORY_ID}，与自家 verify 一致）。"
    return 0
  elif grep -q "<verdict>FAIL</verdict>" "$OUT_FILE"; then
    # 不自动翻转 verificationPasses。Codex FAIL 是第二意见不是裁判，与自家 verify 分歧，
    # 两边都可能错（Creaibo 2026-07-14 实测：一次 Codex FAIL 是误判，漏了 criteria 里的
    # 语义作用域注记）。每次 FAIL 都自动翻转会悄悄把没问题的 story 重跑，烧迭代追分歧。
    # 记进 verificationNotes（追加不覆盖，留给人工/后续 run），bump reopen 触发熔断检查。
    echo "  [ralph.sh] 双轨：${RALPH_DUAL_TRACK_TOOL} FAIL（${STORY_ID}）—— 与自家 verify 的 PASS 分歧。"

    # 分歧不直接计入 reopen，先请第三方仲裁（2026-08-22 用户定）。
    # 原来的做法是「记 note + bump reopen」，等于把每次分歧都当成 codex 对：
    # 两轮就打满上限熔断停机，而 codex 完全可能误判（Creaibo 2026-07-14 实测过一次）。
    # 实测代价：积分需求 US-1 就是这样在窄缺口上熔断，5 个 story 只做完 1 个。
    local ARB
    ARB=$(run_arbitration "$STORY_ID")
    if [ "$ARB" = "OVERRULED" ]; then
      # 仲裁认定 codex 误判 → 放行，不 bump reopen。
      # ⛔ 刻意不再跑一轮 codex 复核：代码没变，同样的判据只会给出同样的 FAIL，
      # 于是又触发仲裁——这正是「老是循环」的成因。codex 复核的前提是代码变了，
      # 而 UPHELD 分支走返工，下一轮的 verify + 双轨自然会复核。
      local TMP_OK NOTE_OK
      TMP_OK=$(mktemp)
      NOTE_OK="双轨 ${RALPH_DUAL_TRACK_TOOL} FAIL 但第三方仲裁判定为误判（$(date -u +%Y-%m-%dT%H:%M:%SZ)）：见 .codex-acceptance/arbitration-$STORY_ID.md"
      jq --arg id "$STORY_ID" --arg note "$NOTE_OK" \
        '(.userStories[] | select(.id == $id) | .verificationNotes) as $old |
         (.userStories[] | select(.id == $id) | .verificationNotes) =
           (if ($old // "") == "" then $note else ($old + " | " + $note) end)' \
        "$PRD_FILE" > "$TMP_OK" && mv "$TMP_OK" "$PRD_FILE"
      echo "  [ralph.sh] 仲裁：OVERRULED —— 判定 ${RALPH_DUAL_TRACK_TOOL} 误判，$STORY_ID 维持通过，不计 reopen。"
      return 0
    fi
    # UPHELD 或仲裁不可用/无定论 → 保守走原路径（记账 + bump reopen）。
    # 仲裁失败时必须保守：宁可多返工一轮，也不能把真缺口放过去。
    echo "  [ralph.sh] 仲裁：${ARB} —— 按 ${RALPH_DUAL_TRACK_TOOL} 的 FAIL 处理。"
    echo "  [ralph.sh]   报告：$DUAL_TRACK_DIR/report-$STORY_ID.md"
    local TMP_PRD NOTE
    TMP_PRD=$(mktemp)
    NOTE="双轨 ${RALPH_DUAL_TRACK_TOOL} FAIL（$(date -u +%Y-%m-%dT%H:%M:%SZ)，仲裁=${ARB}）：见 .codex-acceptance/report-$STORY_ID.md"
    jq --arg id "$STORY_ID" --arg note "$NOTE" \
      '(.userStories[] | select(.id == $id) | .verificationNotes) as $old |
       (.userStories[] | select(.id == $id) | .verificationNotes) =
         (if ($old // "") == "" then $note else ($old + " | " + $note) end)' \
      "$PRD_FILE" > "$TMP_PRD" && mv "$TMP_PRD" "$PRD_FILE"

    # 真的把 story 放回 implement 队列 —— 这是 2026-08-23 修的一个致命漏洞：
    # 原来这里只写 note + bump reopen，**不动 passes/verificationPasses**，理由是
    # 「Codex FAIL 是第二意见不是裁判，两边都可能错，交人工」。那个理由在**没有仲裁**的
    # 年代成立；加了第三方仲裁后，UPHELD 就是裁判已经判了「缺口是真的」，再不动状态，
    # 12 行之后的 all_stories_done 立刻看到全绿 → finalize → 归档收尾，把一个**已知有真
    # 缺口**的 story 当成完成品交付。实测：credits-transactions-ledger 的 US-2 就这样被
    # 误结（监工发现后人工回改 prd.json 才拦住）。
    #
    # 必须同时清 passes（而不是只清 verificationPasses）：只清后者的话 story 会回到
    # verify 队列，而自家 verify 上一轮刚判过 PASS、代码一个字没变，只会再判一次 PASS
    # → 再仲裁 → 再 UPHELD，两轮打满熔断。UPHELD 的语义是「去改代码」，对应的动作
    # 就是 reopen_story_for_implementation。
    #
    # 仲裁 INCONCLUSIVE（不可用/超时/无定论）也走这条：保守优先，宁可多返工一轮。
    reopen_story_for_implementation "$STORY_ID"
    echo "  [ralph.sh] $STORY_ID 已放回 implement 队列（仲裁=${ARB}，下一轮修复）。"

    local REOPENS
    REOPENS=$(bump_reopen "$STORY_ID")
    echo "  [ralph.sh] $STORY_ID reopen 计数：$REOPENS/${RALPH_MAX_REOPEN}（双轨 FAIL）。"
    check_reopen_circuit_breaker "$STORY_ID" "$REOPENS"
    return 0
  else
    echo "  [ralph.sh] 双轨：Codex 无可解析判决（${STORY_ID}）—— 不阻塞在无定论的独立核实上。"
    return 0
  fi
}

# Finalize: synthesize → 本地 commit → 推工作分支备份。刻意不推 main、不发版
# （发版由人跑 release-to-feishu.sh）。
finalize() {
  echo ""
  echo "  [ralph.sh] All stories done. Running synthesize phase..."
  echo "---------------------------------------------------------------"
  run_claude "$SCRIPT_DIR/CLAUDE-synthesize.md" "synthesize" 600 || true

  # 归档本次 run（knowledge.md 刻意不归档，原地累积）。
  local BRANCH_NAME DATE FOLDER_NAME ARCHIVE_FOLDER ARCHIVE_REL
  BRANCH_NAME=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$BRANCH_NAME" ]; then
    DATE=$(date +%Y-%m-%d)
    FOLDER_NAME=$(echo "$BRANCH_NAME" | sed 's|^ralph/||')
    ARCHIVE_REL="scripts/ralph/archive/$DATE-$FOLDER_NAME"
    ARCHIVE_FOLDER="$PROJECT_DIR/$ARCHIVE_REL"
    if [ ! -d "$ARCHIVE_FOLDER" ]; then
      echo "  [ralph.sh] Archiving run to $ARCHIVE_FOLDER..."
      mkdir -p "$ARCHIVE_FOLDER"
      [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
      [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
      [ -d "$SCRIPT_DIR/criteria" ] && cp -r "$SCRIPT_DIR/criteria" "$ARCHIVE_FOLDER/"
      [ -d "$SCRIPT_DIR/logs" ] && cp -r "$SCRIPT_DIR/logs" "$ARCHIVE_FOLDER/"
    else
      echo "  [ralph.sh] Archive already exists: $ARCHIVE_FOLDER (skipping)"
    fi
  fi

  # finalize 只允许收拢 Ralph 自己的状态、知识和本轮归档。产品源码若仍有未提交
  # 改动，说明 story 没有按合同完成提交；必须停机交人工，绝不再用 git add -A 吞掉。
  local UNEXPECTED_PATHS=""
  while IFS= read -r changed_path; do
    [ -z "$changed_path" ] && continue
    case "$changed_path" in
      scripts/ralph/prd.json|scripts/ralph/progress.txt|scripts/ralph/knowledge.md|CLAUDE.md) ;;
      "$ARCHIVE_REL"|"$ARCHIVE_REL"/*) ;;
      *) UNEXPECTED_PATHS="${UNEXPECTED_PATHS}${changed_path}"$'\n' ;;
    esac
  done < <({ git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u)

  if [ -n "$UNEXPECTED_PATHS" ]; then
    echo "Error: Ralph finalize 发现未提交的非 Ralph 状态文件，拒绝自动提交：" >&2
    printf '%s' "$UNEXPECTED_PATHS" >&2
    echo "请人工审查并处理后再继续；本轮不会 push 或发版。" >&2
    return 1
  fi

  local STATE_FILE
  for STATE_FILE in scripts/ralph/prd.json scripts/ralph/progress.txt scripts/ralph/knowledge.md CLAUDE.md; do
    [ -e "$STATE_FILE" ] && git add -- "$STATE_FILE"
  done
  if [ -n "$ARCHIVE_FOLDER" ] && [ -d "$ARCHIVE_FOLDER" ]; then
    git add -- "$ARCHIVE_FOLDER"
  fi
  if ! git diff --cached --quiet; then
    echo "  [ralph.sh] Committing Ralph state and archive (local only)..."
    local FINAL_TRAILER="Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
    if [[ "$TOOL" == "codex" ]]; then
      FINAL_TRAILER="Co-Authored-By: OpenAI Codex <noreply@openai.com>"
    fi
    git commit -m "$(printf 'Ralph 收尾：%s 状态与归档\n\n%s' "$(jq -r '.branchName // "ralph-run"' "$PRD_FILE")" "$FINAL_TRAILER")"
  fi

  # 把工作分支推到 remote 备份（2026-08-22 加）。
  #
  # 「只 commit 不 push」会把几小时的产出锁死在一台机器的本地 git 里：同日实测，
  # 出 PRD agent 提交但没推的 PRD 被另一处 git reset --hard 连带抹掉，靠 reflog 才捞回来
  # ——reflog 会过期，而 Ralph 一轮的产出比一份 PRD 大得多。
  #
  # ⚠️ 只推**工作分支**，绝不推 main：合并进 main 仍然是需求流水线（或人）的决定，
  # 那里有仲裁缺口检查、冲突 abort 等闸门。推分支只是备份 + 让另一台机器能看到，
  # 不改变「谁有权合并」。
  # 推失败（无 remote / 网络 / 权限）只告警不改变退出码——本地 commit 已经完成，
  # 备份失败不该让一轮成功的 run 报错。
  if [ "${RALPH_PUSH_BRANCH:-1}" != "0" ]; then
    local CUR_BRANCH
    CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ -n "$CUR_BRANCH" ] && [ "$CUR_BRANCH" != "main" ] && [ "$CUR_BRANCH" != "HEAD" ]; then
      for r in origin github; do
        if git remote get-url "$r" >/dev/null 2>&1; then
          if git push -u "$r" "$CUR_BRANCH" 2>/dev/null; then
            echo "  [ralph.sh] 分支已备份到 $r/$CUR_BRANCH"
          else
            echo "  [ralph.sh] ⚠️ 推 $r 失败（本地 commit 已完成，不影响本轮结果）" >&2
          fi
        fi
      done
    else
      echo "  [ralph.sh] ⚠️ 当前在 '$CUR_BRANCH'，跳过分支备份（绝不推 main）" >&2
    fi
  fi

  echo ""
  echo "  [ralph.sh] 停在工作分支 — 不推 main、不发版（by design）。"
  echo "  [ralph.sh] 人工过目：git log --oneline; git diff main...HEAD"
  echo "  [ralph.sh] 发版走：cd demo && ./release-to-feishu.sh（版本号规则见 CLAUDE.md，先问用户）"

  echo ""
  echo "  [ralph.sh] Ralph v2 completed all stories (local commit only)."
  exit 0
}

# 单阶段模式（手工/调试用）。
if [[ "$PHASE" == "implement" ]]; then
  run_claude "$SCRIPT_DIR/CLAUDE-implement.md" "implement-single" 900 || true
  exit 0
fi
if [[ "$PHASE" == "verify" ]]; then
  start_app
  run_claude "$SCRIPT_DIR/CLAUDE-verify.md" "verify-single" 600 || true
  exit 0
fi
if [[ "$PHASE" == "synthesize" ]]; then
  run_claude "$SCRIPT_DIR/CLAUDE-synthesize.md" "synthesize-single" 600 || true
  exit 0
fi

# 完整流程。隔离 Electron 在每次 verify 前按当前 HEAD 新起，避免 implement 修改
# main.js 后仍验证运行开始时的旧主进程。
STALL_ROUNDS=0   # 连续「没推进任何 story」的轮数，用于空转熔断
for i in $(seq 1 "$MAX_ITERATIONS"); do
  # 闸一（治本）：每轮开头先判是否还有活。全绿 → 立即收尾并停，不再空转起 agent。
  if [ "$(all_stories_done)" = "true" ]; then
    echo ""
    echo "  [ralph.sh] 所有 story 已实施并验证通过 —— 无剩余工作，停止循环。"
    finalize
    exit 0
  fi

  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS"
  echo "==============================================================="

  PASSED_BEFORE=$(passed_count)

  # 闸一续：未验证 story 优先，不在验证缺口上继续堆叠新实施。
  # 没有待验证 story 时，才启动下一个 implement agent。
  if has_verify_work; then
    echo "  [ralph.sh] [implement] 存在已实施未验证 story，优先重试 verify，跳过新实施。"
  elif has_impl_work; then
    # 预判下一个 story（与 implement agent 相同规则：最高优先级 passes:false），取其 model 字段。
    NEXT_STORY_MODEL=$(jq -r '[.userStories[] | select(.passes == false)] | sort_by(.priority) | (.[0].model // empty)' "$PRD_FILE" 2>/dev/null || true)
    echo "  [ralph.sh] [implement] 尚有待实施 story，启动 implement agent…"
    OUTPUT=$(RALPH_AGENT_MODEL="${NEXT_STORY_MODEL:-$RALPH_MODEL_DEFAULT}" run_claude "$SCRIPT_DIR/CLAUDE-implement.md" "implement-$i" 900) || true
    echo "  [ralph.sh] Implement agent finished."
  else
    echo "  [ralph.sh] [implement] 无待实施 story，跳过 implement。"
  fi

  # 闸二（补 verify 触发）：不再只靠 agent 输出的 <story_completed> 标记；
  # 只要存在「已实施未验证」的 story，就跑 verify —— 修复「passes:true 但 verify 从不触发」的漏洞。
  if has_verify_work; then
    # 取本轮待验证的 story id（最高优先级的 passes:true && verificationPasses:false），
    # 供 reopen 计数与双轨验证按 story 粒度记账。
    VERIFY_STORY_ID=$(jq -r '[.userStories[] | select(.passes == true and .verificationPasses == false)] | sort_by(.priority) | .[0].id // empty' "$PRD_FILE" 2>/dev/null)
    echo ""
    echo "  [ralph.sh] [verify] 存在已实施未验证的 story（${VERIFY_STORY_ID}），启动 verify agent…"
    echo "---------------------------------------------------------------"
    stop_app
    start_app
    VERIFY_OUTPUT=$(run_claude "$SCRIPT_DIR/CLAUDE-verify.md" "verify-$i" 600) || true
    echo "  [ralph.sh] Verify agent finished."
    if echo "$VERIFY_OUTPUT" | grep -q "<verification>FAIL</verification>"; then
      echo "  [ralph.sh] 本轮有验证 FAIL —— 下一轮 implement 修复。"
      if [ -n "$VERIFY_STORY_ID" ]; then
        reopen_story_for_implementation "$VERIFY_STORY_ID"
        REOPENS=$(bump_reopen "$VERIFY_STORY_ID")
        echo "  [ralph.sh] $VERIFY_STORY_ID reopen 计数：$REOPENS/${RALPH_MAX_REOPEN}（verify FAIL）。"
        check_reopen_circuit_breaker "$VERIFY_STORY_ID" "$REOPENS"
      fi
    elif echo "$VERIFY_OUTPUT" | grep -q "<verification>PASS</verification>"; then
      echo "  [ralph.sh] 本轮验证通过 —— 跑双轨独立核实。"
      # 双轨只在自家 verify 判 PASS 后跑；第二轨 FAIL 交第三方仲裁，仲裁 UPHELD 才把
      # story 放回 implement 队列（见 run_dual_track_verify 说明）。
      [ -n "$VERIFY_STORY_ID" ] && run_dual_track_verify "$VERIFY_STORY_ID" || true
    else
      echo "  [ralph.sh] verify agent 未产出 PASS/FAIL 判决 —— 下一轮重试。"
    fi
  fi

  # 全绿则立即收尾并停（不必等到下一轮开头）。
  if [ "$(all_stories_done)" = "true" ]; then
    echo ""
    echo "  [ralph.sh] 全部 story 通过验证 —— 收尾并停止。"
    finalize
    exit 0
  fi

  # 闸三（防呆熔断）：本轮 passes 计数没变化 = 没推进任何 story。连续 2 轮无推进则熔断，
  # 避免 agent 卡住时硬烧到 MAX 次（例如 verify 反复 FAIL 而 implement 修不动）。
  PASSED_AFTER=$(passed_count)
  if [ "$PASSED_AFTER" -le "$PASSED_BEFORE" ]; then
    STALL_ROUNDS=$((STALL_ROUNDS + 1))
    echo "  [ralph.sh] 本轮未推进任何 story（stall $STALL_ROUNDS/2）。"
    if [ "$STALL_ROUNDS" -ge 2 ]; then
      echo ""
      echo "  [ralph.sh] 连续 2 轮无推进 —— 判定卡死，熔断退出（避免空转烧额度）。"
      echo "  [ralph.sh] 请查 $PROGRESS_FILE 看卡在哪。"
      exit 1
    fi
  else
    STALL_ROUNDS=0
  fi

  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all stories."
echo "Check $PROGRESS_FILE for status."
exit 1
