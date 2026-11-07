'use strict';
// 详情页简介补全
//   1) 优先用自有书源按书名精确匹配（书名未经混淆，最可靠）
//   2) 兜底晋江：其书名为字体混淆，仅在"搜索结果唯一"时采用，并标注来源
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { request } = require('./util');

const CACHE_TTL = 7 * 24 * 3600 * 1000;
let cacheFile = '';
let cache = null;

function init(dataDir) {
  cacheFile = path.join(dataDir, 'intro-cache.json');
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    cache = {};
  }
}

function persist() {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function norm(s) {
  return String(s || '')
    .replace(/[\s《》「」『』·・:：,，.。!！?？'"“”‘’()（）\[\]【】-]/g, '')
    .toLowerCase();
}

function clean(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从自有书源里找同名书的简介：书名可校验，最可靠 */
async function fromSources(name, author, searchFn, opts = {}) {
  const target = norm(name);
  const authorKey = norm(author);
  const books = await searchFn(name, 6);
  // 书名常带「（全集）」「1：地球往事」之类的后缀，用包含关系匹配
  const scored = books
    .map((b) => {
      const n = norm(b.name);
      let score = n === target ? 0 : n.includes(target) || target.includes(n) ? 1 : 9;
      if (score === 9) return null;
      // 长度差太大视为不同书
      const ratio = Math.min(n.length, target.length) / Math.max(n.length, target.length, 1);
      if (ratio < 0.45) return null;
      return { b, score: score + (1 - ratio) };
    })
    .filter(Boolean)
    .sort((x, y) => x.score - y.score);
  const candidates = scored.map((x) => x.b);
  if (!candidates.length) return null;
  // 作者能对上优先，其次简介最长的
  candidates.sort((a, b) => {
    const am = authorKey && norm(a.author) === authorKey ? 1 : 0;
    const bm = authorKey && norm(b.author) === authorKey ? 1 : 0;
    if (am !== bm) return bm - am;
    return String(b.intro || '').length - String(a.intro || '').length;
  });
  // 搜索结果通常不带简介，逐本抓详情页补
  for (const b of candidates.slice(0, 3)) {
    let intro = String(b.intro || '').trim();
    if (intro.length < 20 && typeof opts.fetchDetail === 'function') {
      const full = await opts.fetchDetail(b).catch(() => null);
      if (full && full.intro) intro = String(full.intro).trim();
    }
    if (intro.length >= 20) {
      return { intro: clean(intro).slice(0, 1200), source: b.originName || '书源', url: b.bookUrl };
    }
  }
  return null;
}

/** 晋江：命中唯一结果才采用（书名被字体混淆，无法逐字校验） */
async function fromJinjiang(name) {
  const url = 'https://www.jjwxc.net/search.php?kw=' + encodeURIComponent(name) + '&t=1';
  const resp = await request(url, { timeout: 20000 });
  const $ = cheerio.load(resp.body);
  const items = [];
  $('a[href*="onebook.php?novelid="]').each((i, el) => {
    const id = (($(el).attr('href') || '').match(/novelid=(\d+)/) || [])[1];
    if (!id) return;
    const intro = $(el).closest('h3').nextAll('.intro').first().text().replace(/\s+/g, ' ').trim();
    if (intro) items.push({ id, intro });
  });
  if (items.length !== 1) return null;

  // 搜索页只有摘要，去作品页取完整「文案」
  try {
    const page = await request('https://www.jjwxc.net/onebook.php?novelid=' + items[0].id, { timeout: 20000 });
    const $$ = cheerio.load(page.body);
    const full = $$('#novelintro').first().text();
    if (full && full.trim().length > 30) {
      return {
        intro: clean(full).slice(0, 1200),
        source: '晋江文学城',
        url: 'https://www.jjwxc.net/onebook.php?novelid=' + items[0].id,
      };
    }
  } catch {
    /* 取不到完整文案就用摘要 */
  }
  return {
    intro: clean(items[0].intro).slice(0, 1200),
    source: '晋江文学城',
    url: 'https://www.jjwxc.net/onebook.php?novelid=' + items[0].id,
  };
}

async function lookup(name, author, dataDir, opts = {}) {
  if (!name) return { intro: '', source: '' };
  if (!cache) init(dataDir);
  const key = norm(name) + '|' + norm(author);
  const hit = cache[key];
  if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL) return hit;

  let result = { intro: '', source: '', url: '', at: Date.now() };

  if (typeof opts.searchSources === 'function') {
    try {
      const fromSrc = await fromSources(name, author, opts.searchSources, opts);
      if (fromSrc) result = { ...fromSrc, at: Date.now() };
    } catch {
      /* 书源搜索失败不影响兜底 */
    }
  }

  if (!result.intro) {
    try {
      const jj = await fromJinjiang(name);
      if (jj) result = { ...jj, at: Date.now() };
    } catch {
      /* 晋江不可用就算了 */
    }
  }

  if (result.intro) {
    cache[key] = result;
    persist();
  }
  return result;
}

module.exports = { lookup, init };
