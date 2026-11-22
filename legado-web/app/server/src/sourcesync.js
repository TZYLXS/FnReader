'use strict';
// 书源双向同步：以 lastUpdateTime（毫秒）大的为准，相等时服务端优先
const { normalizeSource } = require('./books');

function tsOf(src) {
  const t = Number(src && src.lastUpdateTime);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function byUrl(store) {
  const map = new Map();
  for (const s of store.sources || []) map.set(s.bookSourceUrl, s);
  return map;
}

/** 书源类型：统一成 Legado 的数字枚举（0 文本 / 1 音频 / 2 图片 / 3 漫画） */
function normType(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(3, Math.trunc(v)));
  const text = String(v == null ? '' : v).trim();
  if (/^\d+$/.test(text)) return Math.max(0, Math.min(3, Number(text)));
  if (/音频|audio/i.test(text)) return 1;
  if (/图片|image|photo/i.test(text)) return 2;
  if (/漫画|comic|manga/i.test(text)) return 3;
  return 0;
}

function normBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  return false;
}

const RULE_KEYS = ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'];
function hasRules(src) {
  return RULE_KEYS.some((k) => src && src[k] && typeof src[k] === 'object' && Object.keys(src[k]).length > 0);
}
/** 出口统一：类型/布尔规范化 + 过滤明显坏源（无规则且无时间戳） */
function outgoing(src) {
  const out = { ...src };
  out.bookSourceType = normType(src.bookSourceType);
  out.enabledCookieJar = normBool(src.enabledCookieJar);
  out.enabledExplore = normBool(src.enabledExplore);
  out.enabled = src.enabled !== false;
  return out;
}
function usable(src) {
  return tsOf(src) > 0 || hasRules(src);
}

/**
 * 合并客户端推上来的书源
 * @param {object} store
 * @param {{updated?:Array, deleted?:Array, since?:number}} body
 * @returns {{applied:number, skipped:number, pull:Array, pullDeleted:Array, serverTime:number}}
 */
function mergeSources(store, body = {}) {
  const now = Date.now();
  const map = byUrl(store);
  const pull = [];
  const pullDeleted = [];
  let applied = 0;
  let skipped = 0;

  const updated = Array.isArray(body.updated) ? body.updated : [];
  const deleted = Array.isArray(body.deleted) ? body.deleted : [];

  const wipe = store.config && store.config.sourcesWipe;
  const wipeAt = Number(wipe && wipe.at) || 0;
  // 协议/尾斜杠差异不算不同源（http/https 各写一遍的源很常见）
  const keyOf = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  const wiped = new Set((Array.isArray(wipe && wipe.urls) ? wipe.urls : []).map(keyOf));

  for (const inc of updated) {
    if (!inc || !inc.bookSourceUrl) continue;
    // 服务端已整体清空：客户端手里的旧源（时间戳不超过擦除点）不允许回填
    // 擦除点之后没改过的源一律不允许回填（即使不在 urls 列表里，避免列表不完整时被重新灌回）
    if (wipeAt && (tsOf(inc) || 0) <= wipeAt) {
      skipped++;
      continue;
    }
    const cur = map.get(inc.bookSourceUrl);
    const incTs = tsOf(inc) || now; // 客户端没带时间就当作刚改
    if (!cur) {
      const created = { ...normalizeSource(inc), lastUpdateTime: incTs };
      store.saveSources([...store.sources, created]);
      map.set(created.bookSourceUrl, created);
      applied++;
      continue;
    }
    const curTs = tsOf(cur);
    if (incTs > curTs) {
      Object.assign(cur, normalizeSource(inc), { lastUpdateTime: incTs });
      applied++;
    } else if (incTs < curTs) {
      // 服务端确实更新：回传，客户端应覆盖本地
      skipped++;
      pull.push(cur);
    } else {
      // 时间戳相同：视为同一版本，不回传，避免客户端整行 REPLACE 覆盖本地字段
      skipped++;
    }
  }

  for (const del of deleted) {
    // 客户端有两种写法：["url", ...] 和 [{bookSourceUrl, lastUpdateTime}]。
    // 字符串没有时间戳，按“现在就删”处理，否则手机端的删除会静默丢失。
    const url = typeof del === 'string' ? del : (del && del.bookSourceUrl);
    if (!url) continue;
    const cur = map.get(url);
    if (!cur) {
      skipped++;
      continue;
    }
    const delTs = typeof del === 'string' ? now : (tsOf(del) || now);
    if (delTs >= tsOf(cur)) {
      const kept = store.sources.filter((s) => s.bookSourceUrl !== url);
      store.saveSources(kept);
      map.delete(url);
      applied++;
    } else {
      skipped++;
      pull.push(cur);
    }
  }

  store.saveSources(store.sources);

  // 服务端这边比客户端新（或 since 之后有变化）的，回给客户端
  const since = Number(body.since) || 0;
  const pullUrls = new Set(pull.map((s) => s.bookSourceUrl));
  if (since) {
    for (const s of store.sources) {
      if (pullUrls.has(s.bookSourceUrl)) continue;
      if (tsOf(s) <= since) continue; // 严格大于 since 才算更新
      if (!usable(s)) continue;
      pull.push(s);
    }
  }
  // 擦除纪元：把被清掉的源作为删除项下发，客户端据此清本地
  if (wipeAt) {
    for (const url of wiped) pullDeleted.push({ bookSourceUrl: url, lastUpdateTime: wipeAt });
  }

  // 分页：一次最多 500 条，客户端拿 nextSince 继续拉
  pull.sort((a, b) => tsOf(a) - tsOf(b));
  let nextSince = since;
  let truncated = false;
  if (pull.length > 500) {
    pull.length = 500;
    truncated = true;
  }
  for (const s of pull) nextSince = Math.max(nextSince, tsOf(s));
  const out = pull.map(outgoing);

  return {
    applied,
    skipped,
    pull: out,
    pullDeleted,
    serverTime: now,
    nextSince,
    wipe: wipeAt || 0,
    truncated,
  };
}

/** 拉取 since 之后变化的书源（增量） */
function pullSince(store, since) {
  const ts = Number(since) || 0;
  const all = (store.sources || []).filter((s) => tsOf(s) > ts && usable(s));
  all.sort((a, b) => tsOf(a) - tsOf(b));
  const out = all.slice(0, 500);
  let nextSince = ts;
  for (const s of out) nextSince = Math.max(nextSince, tsOf(s));
  const wipe = store.config && store.config.sourcesWipe;
  const wipeAt = Number(wipe && wipe.at) || 0;
  const deleted = wipeAt && Array.isArray(wipe.urls)
    ? wipe.urls.map((u) => ({ bookSourceUrl: u, lastUpdateTime: wipeAt }))
    : [];
  return {
    sources: out.map(outgoing),
    deleted,
    serverTime: Date.now(),
    nextSince: Math.max(nextSince, wipeAt || 0),
    wipe: wipeAt || 0,
    truncated: all.length > out.length,
  };
}

module.exports = { mergeSources, pullSince };
