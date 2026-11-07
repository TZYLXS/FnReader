'use strict';
// 搜索结果缓存：按「最终请求 URL + 请求体」做键，重复搜索直接命中
const path = require('node:path');
const crypto = require('node:crypto');
const { MiniDB } = require('./minidb');

const DATA_DIR = process.env.TRIM_PKGVAR || process.env.LEGADO_DATA || path.join(process.cwd(), 'data');
const db = new MiniDB(path.join(DATA_DIR, 'db', 'search-cache.jsonl'), {
  maxEntries: 4000,
  ttl: 24 * 3600 * 1000,
});

const HIT_TTL = 24 * 3600 * 1000; // 有结果缓存 1 天
const MISS_TTL = 10 * 60 * 1000; // 空结果只缓存 10 分钟

function keyFor(url, body) {
  return crypto.createHash('sha1').update(`v2|${url}|${body || ''}`).digest('hex');
}

/** 只留展示需要的字段，控制缓存体积 */
function slimBooks(books) {
  return books.map((b) => ({
    name: b.name,
    author: b.author,
    kind: b.kind,
    intro: String(b.intro || '').slice(0, 160),
    lastChapter: b.lastChapter,
    updateTime: b.updateTime,
    wordCount: b.wordCount,
    coverUrl: b.coverUrl,
    bookUrl: b.bookUrl,
    origin: b.origin,
    originName: b.originName,
  }));
}

function get(url, body) {
  const row = db.get(keyFor(url, body));
  if (!row || !Array.isArray(row.v)) return null;
  return row.v;
}

function set(url, body, books) {
  db.set(keyFor(url, body), slimBooks(books), books.length ? HIT_TTL : MISS_TTL);
}

module.exports = { get, set, stats: () => db.stats(), clear: () => db.clear(), db };
