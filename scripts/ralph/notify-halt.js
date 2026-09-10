#!/usr/bin/env node
// Ralph 熔断告警 —— 往飞书群发消息并 @ 负责人。
//
// 为什么需要：熔断是「自动流程已经尽力、必须人工裁决」的信号。它原来只往 stdout 打一段
// 提示，而 Ralph 跑在 mac_mini 的后台，日志没人盯着——2026-08-22 实测：埋点需求 US-2
// 熔断后一直停在那儿，直到人主动来问才发现。
//
// 触发时机刻意收窄：**只在「仲裁判 UPHELD 后仍然熔断」时发**。
// 那意味着三方（自家 verify / 独立第二意见 / 第三方仲裁）已经过了一遍，
// 分歧不是误判、而是实现端两轮都没修对——这种才值得打扰人。
// 仲裁判 OVERRULED 的分歧不计 reopen，本来就到不了熔断。
//
// 用法：node notify-halt.js <storyId> <reopenCount> [worktree路径]
// 静默失败：告警发不出去绝不能影响 Ralph 自身的退出流程（它已经要停机了）。
'use strict';

const path = require('path');
const fs = require('fs');

// 复用 bug-monitor 的飞书封装（token 缓存/重试/明文凭据都在那儿，不另起一套）
const BT = path.resolve(__dirname, '../../demo/bug-monitor/bitable.js');

// 负责人 open_id。飞书的 @ 必须用 open_id，姓名 @ 不出来。
// 群成员变动时用这条查：
//   GET /im/v1/chats/<chatId>/members?page_size=50 → items[].member_id
const OWNER_OPEN_ID = process.env.RALPH_HALT_NOTIFY_OPEN_ID
  || 'ou_33ca65a2bc0c3dfbd9041c80dde2f95a';   // 姚顺宇

function tail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

async function main() {
  const storyId = process.argv[2] || '(unknown)';
  const count = process.argv[3] || '?';
  const wt = process.argv[4] || process.cwd();

  let bt;
  try { bt = require(BT); } catch (e) {
    console.error('[notify-halt] 载入飞书封装失败：' + e.message);
    return;
  }

  // 附上最近一次 codex 的判决理由：人看到消息就能判断是真缺口还是要澄清 criteria，
  // 不必先 ssh 上机器翻文件。
  const report = path.join(wt, 'scripts/ralph/.codex-acceptance/report-' + storyId + '.md');
  const arb = path.join(wt, 'scripts/ralph/.codex-acceptance/arbitration-' + storyId + '.md');
  let detail = tail(report, 6);
  if (detail) detail = '\n\n【第二意见最近的判决（节选）】\n' + detail.slice(0, 600);
  let arbLine = fs.existsSync(arb) ? '\n仲裁：UPHELD（第三方判定第二意见成立，非误判）' : '';

  const branch = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(wt, 'scripts/ralph/prd.json'), 'utf8')).branchName || '';
    } catch { return ''; }
  })();

  const text = [
    `<at user_id="${OWNER_OPEN_ID}"></at> 【Ralph 熔断，需人工裁决】`,
    '',
    `story：${storyId}（已 reopen ${count} 次，达上限）`,
    branch ? `分支：${branch}` : '',
    `worktree：${wt}`,
    arbLine,
    '',
    '三方都过了一遍仍未修对，自动流程到此为止。请判断最近这次 FAIL 是：',
    '  (a) 真实缺口 → 人工修，或澄清后重跑',
    '  (b) 超范围加码 → 驳回，把 story 标回 verificationPasses:true',
    '  (c) criteria 措辞问题 → 改 criteria 再重启',
    detail,
  ].filter(Boolean).join('\n');

  try {
    await bt.sendGroupMessage(text);
    console.log('[notify-halt] 已发飞书群并 @ 负责人');
  } catch (e) {
    // 静默降级：Ralph 正在退出，告警失败不应改变它的退出码
    console.error('[notify-halt] 发送失败（不影响 Ralph 退出）：' + e.message);
  }
}

main().catch((e) => console.error('[notify-halt] ' + e.message));
