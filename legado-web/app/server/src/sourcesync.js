'use strict';
// 书源双向同步：以 lastUpdateTime（毫秒）大的为准，相等时服务端优先

function tsOf(src) {
  const t = Number(src && src.lastUpdateTime);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function byUrl(store) {
  const map = new Map();
  for (const s of store.sources || []) map.set(s.bookSourceUrl, s);
  return map;
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

  for (const inc of updated) {
    if (!inc || !inc.bookSourceUrl) continue;
    const cur = map.get(inc.bookSourceUrl);
    const incTs = tsOf(inc) || now; // 客户端没带时间就当作刚改
    if (!cur) {
      const created = { ...inc, lastUpdateTime: incTs };
      store.saveSources([...store.sources, created]);
      map.set(created.bookSourceUrl, created);
      applied++;
      continue;
    }
    const curTs = tsOf(cur);
    if (incTs > curTs) {
      Object.assign(cur, inc, { lastUpdateTime: incTs });
      applied++;
    } else {
      skipped++;
      pull.push(cur);
    }
  }

  for (const del of deleted) {
    const url = del && del.bookSourceUrl;
    if (!url) continue;
    const cur = map.get(url);
    if (!cur) {
      skipped++;
      continue;
    }
    const delTs = tsOf(del) || now;
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
  for (const s of store.sources) {
    if (pullUrls.has(s.bookSourceUrl)) continue;
    if (since && tsOf(s) <= since) continue;
    if (!since) continue;
    pull.push(s);
  }

  return {
    applied,
    skipped,
    pull,
    pullDeleted,
    serverTime: now,
    truncated: pull.length > 500,
  };
}

/** 拉取 since 之后变化的书源（增量） */
function pullSince(store, since) {
  const ts = Number(since) || 0;
  const out = [];
  for (const s of store.sources || []) {
    if (!ts || tsOf(s) > ts) out.push(s);
  }
  return { sources: out, serverTime: Date.now(), truncated: out.length > 500 };
}

module.exports = { mergeSources, pullSince };
