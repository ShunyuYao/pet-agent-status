'use strict';
// 宠物脚下的折叠徽标（宿主 pet.badge.* SDK，experimental 档）。
//
// 数据全部取自现成的 aggregate summary —— **协议零改动**（PRD US-B03 的验收点）：
//   waiting → warning 段、running → primary 段，waiting 恒排最左（与面板 waiting 置顶同精神）。
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
function segmentsFor(summary) {
  if (!summary) return null;
  const segs = [];
  const waiting = Number(summary.waiting) || 0;
  const running = Number(summary.running) || 0;
  // waiting 恒排最左：它是唯一「挡着用户」的状态，眼睛先扫到的位置留给它
  if (waiting > 0) segs.push({ tone: 'warning', text: clip(waiting) });
  if (running > 0) segs.push({ tone: 'primary', text: clip(running) });
  return segs.length ? segs : null;
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
