'use strict';
// 宠物脚下的折叠徽标（宿主 pet.badge.* SDK，experimental 档）。
//
// 数据全部取自现成的 aggregate summary —— **协议零改动**（PRD US-B03 的验收点）：
//   waiting → warning 段、running → primary 段、done → success 段，
//   宿主限死最多 2 段（BADGE_MAX_SEGMENTS），按 waiting > running > done 优先级取前两个
//   非零状态填满两段——waiting 恒排最左（与面板 waiting 置顶同精神），done 只在有空位时上榜
//   （2026-09-11 真机缺陷：原来只映射 waiting/running，「2 运行中 + 2 已完成」时徽标只有一段，
//   第二个名额空着，done 却永远没资格显示）。
// 没有会话时 clear，不留空徽标。
//
// 三条边界，都对着真实教训：
//   ① **宿主不支持要静默降级**：徽标是 0.19.0 才有的能力，老宿主上 pet.badge 是 undefined，
//      直接调用会抛异常打死整轮 tick（面板也跟着没了）。守卫 + 只告警一次。
//   ② **变化才发**：tick 是 2s 一轮，每轮都 set 等于每 2s 一次跨进程 IPC 且宿主每次重渲染。
//      指纹比对后只在真变化时发。
//   ③ **失败不重试风暴**：set 返回 false（名额被别的插件占着/参数被拒）时记住，
//      同一份内容不反复试；内容变了才再试一次。

const CLICK_OPEN_PANEL = 'openPanel';

/**
 * summary → segments。tone 是语义 token（宿主决定画成什么颜色），text ≤4 字符。
 * @returns {Array<{tone:string,text:string}>|null} null = 没有可显示的东西
 */
// 宿主允许同屏的段数上限（runtime.js BADGE_MAX_SEGMENTS，超了整条 set 被拒）
const MAX_SEGMENTS = 2;

// 无会话时的「常驻空徽标」：1 段 muted + 空文本。
//
// 为什么不是返回 null（0.11.0 反转，docs/design-launcher-proposal.md 改动①）：
// 徽标是宠物脚下**唯一**的会话入口，整个不渲染＝用户失去入口，且宠物脚下突然空一块
// 也显得功能坏了。改成收缩为「只剩一个 chevron」的最小胶囊（宿主侧空文本段不画点、
// 不画字，视觉上只剩 clickable 带来的 chevron）。
//
// 为什么是 1 段而不是 0 段：宿主 `normalizeBadgeSegments` 明确拒 `length < 1`
// （runtime.js），空数组整条 set 被拒。但它对 `text` **只校验长度上限、不校验非空**，
// 故空字符串合法 —— 这是读宿主源码确认的，不是猜的。
const IDLE_SEGMENTS = [{ tone: 'muted', text: '' }];

function segmentsFor(summary) {
  // 连 summary 都没有（首轮/读坏）：仍给常驻空徽标，入口不消失
  if (!summary) return IDLE_SEGMENTS.slice();
  // 优先级即数组顺序：waiting 是唯一「挡着用户」的状态，眼睛先扫到的位置留给它；
  // running 次之；done 只是「刚办完」的余韵，有空位才显示
  const candidates = [
    ['warning', Number(summary.waiting) || 0],
    ['primary', Number(summary.running) || 0],
    ['success', Number(summary.done) || 0]
  ];
  const segs = candidates
    .filter(([, n]) => n > 0)
    .slice(0, MAX_SEGMENTS)
    .map(([tone, n]) => ({ tone, text: clip(n) }));
  return segs.length ? segs : IDLE_SEGMENTS.slice();
}

// 宿主限死每段 ≤4 字符；真有 10000 个会话也不至于让整条 set 被拒
function clip(n) {
  return n > 999 ? '999+' : String(n);
}

function createBadgeLink() {
  let lastKey = null;      // 上次成功投出去的内容指纹（null = 当前无徽标）
  let rejectedKey = null;  // 被宿主拒绝过的内容指纹，同内容不再重试
  let warned = false;      // 宿主不支持只告警一次

  function supported(pet) {
    return !!(pet && pet.badge && typeof pet.badge.set === 'function' && typeof pet.badge.clear === 'function');
  }

  /**
   * 吃一轮快照的 summary，按需更新徽标。
   * @returns {Promise<'set'|'clear'|'skip'|'unsupported'|'rejected'>} 供测试与诊断
   */
  async function onSummary(summary, pet) {
    if (!supported(pet)) {
      if (!warned) {
        warned = true;
        // 老宿主装新插件是正常场景，不是错误——面板功能完全不受影响，只是没有徽标。
        // 诊断日志走英文常量：仓库红线要求中文只许在 locales/*.json（用户可见文案才走 i18n，
        // 这条只进控制台、不上屏，故不进词表）。
        try { console.log('[agent-status] host does not support pet.badge; skipping badge (panel unaffected)'); } catch (_) { /* 无 console 也不能炸 */ }
      }
      return 'unsupported';
    }
    const segments = segmentsFor(summary);
    const key = segments ? JSON.stringify(segments) : null;
    if (key === lastKey) return 'skip';          // ② 变化才发
    if (key !== null && key === rejectedKey) return 'skip';  // ③ 同内容不重试

    try {
      // 0.11.0 起 segmentsFor 恒返回非空（常驻空徽标），这条分支在 onSummary 路径上
      // 已走不到；留作防御——若日后有人改回返回 null，行为仍是「清掉」而不是崩。
      // 插件停用时的真正撤销走 dispose()。
      if (key === null) {
        await pet.badge.clear();
        lastKey = null;
        rejectedKey = null;
        return 'clear';
      }
      const ok = await pet.badge.set({ segments, onClick: CLICK_OPEN_PANEL });
      if (ok === false) {
        // 名额被别的插件占着，或参数被拒。不改 lastKey：内容再变时还会试一次。
        rejectedKey = key;
        return 'rejected';
      }
      lastKey = key;
      rejectedKey = null;
      return 'set';
    } catch (_) {
      // 宿主侧任何异常都不能打死 tick（面板要继续更新）
      return 'rejected';
    }
  }

  // 插件停用时主动撤：宿主虽有兜底清除，但正常路径自己收干净才对
  async function dispose(pet) {
    if (!supported(pet)) return;
    try { await pet.badge.clear(); } catch (_) { /* 宿主已经在拆了 */ }
    lastKey = null;
    rejectedKey = null;
  }

  return { onSummary, dispose };
}

module.exports = { createBadgeLink, segmentsFor, CLICK_OPEN_PANEL };
