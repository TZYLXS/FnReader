'use strict';
// 每日推荐：起点（可用时）→ 纵横 → 17K，6 小时缓存 + 磁盘兜底
const fs = require('node:fs');
const cheerio = require('cheerio');
const { request, absoluteUrl } = require('./util');

const TTL = 6 * 60 * 60 * 1000;
let cache = { at: 0, data: null };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HDRS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

function norm(list) {
  const out = [];
  const seen = new Set();
  for (const b of list) {
    const name = String((b && b.name) || '').trim();
    const url = String((b && b.url) || '').trim();
    if (!name || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      rank: out.length + 1,
      name,
      url,
      author: String(b.author || '').trim(),
      score: String(b.score || ''),
      cover: String(b.cover || ''),
    });
    if (out.length >= 30) break;
  }
  return out;
}

async function tryQidian() {
  const html = (await request('https://www.qidian.com/rank/recom/', { headers: HDRS })).body;
  if (!html || html.length < 20000) return null; // 202 反爬挑战页只有几百字节
  const $ = cheerio.load(html);
  const books = [];
  $('.book-img-text li, .rank-list li').each((i, el) => {
    const a = $(el).find('h2 a, .book-mid-info h2 a').first();
    if (!a.length) return;
    books.push({
      name: a.text().trim(),
      url: absoluteUrl('https://www.qidian.com', a.attr('href')),
      author: $(el).find('.author a, .author').first().text().trim(),
      cover: $(el).find('img').first().attr('src') || '',
    });
  });
  const list = norm(books);
  return list.length ? { source: '起点', url: 'https://www.qidian.com/rank/recom/', books: list } : null;
}

async function tryZongheng() {
  const html = (await request('https://www.zongheng.com/rank', { headers: HDRS })).body;
  if (!html || html.length < 10000) return null;
  const $ = cheerio.load(html);
  const books = [];
  $('.zh-modules-rank-book').each((i, el) => {
    const a = $(el).find('.book-rank--title-text a').first();
    const name = (a.attr('title') || a.text() || '').trim();
    const href = a.attr('href');
    if (!name || !href) return;
    books.push({
      name,
      url: absoluteUrl('https://www.zongheng.com', href),
      author: $(el).find('.auther').first().text().trim(),
      score: $(el).find('.rank-content-default__rank-text').first().text().trim(),
    });
  });
  const list = norm(books);
  return list.length ? { source: '纵横', url: 'https://www.zongheng.com/rank', books: list } : null;
}

async function try17k() {
  const html = (await request('https://www.17k.com/top/', { headers: HDRS })).body;
  if (!html || html.length < 10000) return null;
  const $ = cheerio.load(html);
  const books = [];
  $('a[href*="/book/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (!/\/book\/\d+\.html/.test(href)) return;
    const name = ($(el).attr('title') || $(el).text() || '').trim();
    if (!name || name.length > 40) return;
    books.push({ name, url: absoluteUrl('https://www.17k.com', href) });
  });
  const list = norm(books);
  return list.length ? { source: '17K', url: 'https://www.17k.com/top/', books: list } : null;
}

async function build(file, opts = {}) {
  const errors = [];

  // 1) 手机端可代理解析时，让它去抓起点（App 有 WebView，能过反爬）
  if (typeof opts.remoteRank === 'function') {
    try {
      const r = await opts.remoteRank();
      if (r && Array.isArray(r.books) && r.books.length) {
        const list = norm(r.books);
        if (list.length) {
          const data = { source: r.source || '起点（手机解析）', url: r.url || '', updatedAt: Date.now(), books: list, errors };
          cache = { at: Date.now(), data };
          try {
            fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
          } catch {
            /* ignore */
          }
          return data;
        }
      }
    } catch (e) {
      errors.push('remote: ' + e.message);
    }
  }

  for (const fn of [tryQidian, tryZongheng, try17k]) {
    try {
      const r = await fn();
      if (r && r.books.length) {
        const data = { ...r, updatedAt: Date.now(), errors };
        cache = { at: Date.now(), data };
        try {
          fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        } catch {
          /* ignore */
        }
        return data;
      }
    } catch (e) {
      errors.push(`${fn.name}: ${e.message}`);
    }
  }
  return null;
}

async function getDaily(file, opts = {}) {
  if (cache.data && Date.now() - cache.at < TTL) return { ...cache.data, cached: true };
  const fresh = await build(file, opts);
  if (fresh) return { ...fresh, cached: false };
  if (cache.data) return { ...cache.data, cached: true, stale: true };
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = { at: Date.now(), data };
      return { ...data, cached: true, stale: true };
    }
  } catch {
    /* ignore */
  }
  return { source: '', books: [], updatedAt: 0, error: '榜单暂时取不到（起点反爬，纵横/17K 也没响应）' };
}

module.exports = { getDaily };
