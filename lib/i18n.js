'use strict';
// 取词。代码里零硬编码中文，所有文案来自 locales/*.json。
// panel 上下文没有 fs，所以核心是纯函数 createI18n(catalogs)；Node 侧再包一层 loadCatalogs()。

const DEFAULT_LOCALE = 'zh-CN';

// "{n} 运行中" + {n: 3} → "3 运行中"；没给的占位符原样保留，便于发现漏传
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole));
}

// catalogs: { 'zh-CN': {...}, en: {...} }
function createI18n(catalogs, locale) {
  const table = catalogs || {};
  let current = table[locale] ? locale : DEFAULT_LOCALE;

  function t(key, params) {
    const primary = table[current];
    const fallback = table[DEFAULT_LOCALE];
    let value;
    if (primary && typeof primary[key] === 'string') value = primary[key];
    else if (fallback && typeof fallback[key] === 'string') value = fallback[key];
    // 连回落都没有：返回 key 本身，界面上一眼看得出漏词，不显示空白
    else return key;
    return interpolate(value, params);
  }

  return {
    t,
    get locale() { return current; },
    setLocale(next) { current = table[next] ? next : DEFAULT_LOCALE; return current; }
  };
}

// Node 上下文（tool/hooks）：从仓内 locales/ 读全部词表
function loadCatalogs(dir) {
  const fs = require('fs');
  const path = require('path');
  const base = dir || path.join(__dirname, '..', 'locales');
  const catalogs = {};
  let names;
  try { names = fs.readdirSync(base); } catch (_) { return catalogs; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      catalogs[name.slice(0, -'.json'.length)] = JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
    } catch (_) { /* 坏词表跳过，取词自然回落 */ }
  }
  return catalogs;
}

// 宿主没给语言时按系统环境猜；只区分中/英两档
function detectLocale(env) {
  const raw = String((env || process.env).LANG || (env || process.env).LC_ALL || '');
  return /^zh/i.test(raw) ? 'zh-CN' : (raw ? 'en' : DEFAULT_LOCALE);
}

function createNodeI18n(locale, dir) {
  return createI18n(loadCatalogs(dir), locale || detectLocale());
}

module.exports = { DEFAULT_LOCALE, interpolate, createI18n, loadCatalogs, detectLocale, createNodeI18n };
