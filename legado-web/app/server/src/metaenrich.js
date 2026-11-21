'use strict';
/**
 * 书城元数据兜底：封面 / 简介 / 评分
 *
 * - 出版物（默认）：亚马逊 amazon.com（搜索书名+作者 → 商品页）
 * - 网文：起点 qidian.com / 晋江 jjwxc.net（按 bookUrl 里的站点判断）
 *
 * 设计原则：
 * - 只补空字段，不覆盖已有数据
 * - 结果按「书名+作者」缓存（默认 7 天），避免重复请求
 * - 失败一律静默（返回 null），不影响阅读
 * - 图片下载到 data/covers 后回写本地 /api/covers/xxx 地址，避免前端直连第三方
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const CACHE_TTL = 7 * 24 * 3600 * 1000;

const WEB_NOVEL_HOSTS = ['qidian.com', 'jjwxc.net'];

function httpGet(url, ua, timeout = 20000) {
  // 用 curl：亚马逊对 Node undici 的 TLS 指纹不友好，会返回 meta refresh 拦截页
  try {
    return httpGetOnce(url, ua, timeout);
  } catch {
    try { return httpGetOnce(url, ua, timeout); } catch { return ''; }
  }
}

function httpGetOnce(url, ua, timeout = 20000) {
  try {
    const out = execFileSync('curl', [
      '-sL', '-m', String(Math.round(timeout / 1000)), '-A', ua || UA,
      '-H', 'Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8',
      '-H', 'Accept: text/html,application/xhtml+xml',
      url,
    ], { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 });
    return out || '';
  } catch (e) {
    if (process.env.META_DEBUG) console.error('[meta] curl error:', e.message, e.status, String(e.stderr || '').slice(0, 200));
    return '';
  }
}

// 亚马逊会间歇性返回 1.5KB 的跳转拦截页：拿到大页面才算成功，最多重试 5 次
function fetchWithRetry(url, ua, minLen = 20000, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const html = httpGet(url, ua);
    if (html && html.length >= minLen && !/meta\s+http-equiv=["']refresh/i.test(html.slice(0, 500))) return html;
    if (process.env.META_DEBUG) console.error('[meta] retry', i + 1, 'len', html.length, url.slice(0, 80));
    execFileSync('sleep', ['1'], { stdio: 'ignore' });
  }
  return '';
}

function metaOf(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = String(html).match(re);
  return m ? m[1].trim() : '';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function bookKind(bookUrl) {
  const host = hostOf(bookUrl);
  if (WEB_NOVEL_HOSTS.some((h) => host.endsWith(h))) return 'web';
  return 'publication';
}

function normKey(book) {
  const norm = (s) => String(s || '').replace(/[《》「」【】\[\]()（）:：·\s]/g, '').toLowerCase();
  return { title: norm(book.name), author: norm(book.author) };
}

// ---------------- 起点 ----------------
function qidianBookId(bookUrl) {
  const m = String(bookUrl).match(/qidian\.com\/book\/(\d+)/i) || String(bookUrl).match(/[?&]bookId=(\d+)/i);
  return m ? m[1] : '';
}

function fromQidian(book) {
  const id = qidianBookId(book.bookUrl);
  if (!id) return null;
  const html = httpGet(`https://m.qidian.com/book/${id}/`, MUA);
  if (!html || html.length < 5000) return null;
  const title = metaOf(html, 'og:title') || book.name;
  const intro = metaOf(html, 'og:description') || '';
  const cover = (metaOf(html, 'og:image') || '').replace(/^\/\//, 'https://');
  const author = metaOf(html, 'og:novel:author') || '';
  if (!intro && !cover) return null;
  return { source: 'qidian', title, author, intro, cover, rating: null, ratingCount: null };
}

// ---------------- 晋江 ----------------
function jinjiangBookId(bookUrl) {
  const m = String(bookUrl).match(/novelid=(\d+)/i) || String(bookUrl).match(/jjwxc\.net\/book2\/(\d+)/i);
  return m ? m[1] : '';
}

function fromJinjiang(book) {
  const id = jinjiangBookId(book.bookUrl);
  if (!id) return null;
  const html = httpGet(`https://m.jjwxc.net/book2/${id}`, MUA);
  if (!html || html.length < 2000) return null;
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const introM = html.match(/id="novelintro"[^>]*>([\s\S]{0,2000}?)<\/div>/i);
  const intro = introM ? strip(introM[1]).replace(/^简介[：:]\s*/, '').slice(0, 1200) : '';
  const coverM = html.match(/<img[^>]+(?:src|data-src)="([^"]*(?:novelimage|novel|cover)[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
  const cover = coverM ? coverM[1].replace(/^\/\//, 'https://') : '';
  if (!intro && !cover) return null;
  return { source: 'jinjiang', title: book.name, author: book.author || '', intro, cover, rating: null, ratingCount: null };
}

// ---------------- 亚马逊（出版物） ----------------
function fromAmazon(book) {
  const dbg = (...a) => { if (process.env.META_DEBUG) console.error('[meta]', ...a); };
  const kw = `${book.name || ''} ${book.author || ''}`.trim();
  if (!kw) return null;
  const search = fetchWithRetry(`https://www.amazon.com/s?k=${encodeURIComponent(kw)}`, UA, 50000);
  dbg('search', kw, 'len', search.length);
  if (!search) return null;
  const asin = (search.match(/data-asin="([A-Z0-9]{10})"/) || [])[1];
  dbg('asin', asin);
  if (!asin) return null;

  // 搜索卡片兜底（商品页偶尔超时/被拦，卡片里就有封面、标题、评分）
  const card = (() => {
    const idx = search.indexOf(`data-asin="${asin}"`);
    if (idx < 0) return {};
    const block = search.slice(Math.max(0, idx - 200), idx + 20000);
    const strip = (v) => String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      title: strip((block.match(/<h2[^>]*aria-label="([^"]{5,200})"/) || [])[1] || '')
        || strip((block.match(/<span class="a-size-(?:medium|base) a-color-base a-text-normal">([^<]{5,200})<\/span>/) || [])[1] || ''),
      cover: (block.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/) || [])[1] || '',
      rating: Number((block.match(/a-icon-alt">([0-9.]+) out of 5 stars/) || [])[1] || 0) || null,
      count: Number(((block.match(/([0-9,]+)\s*ratings?/i) || [])[1] || '0').replace(/,/g, '')) || null,
      intro: strip((block.match(/<span class="a-size-base-plus a-color-base a-text-normal">([^<]{10,300})<\/span>/) || [])[1] || ''),
    };
  })();

  const html = fetchWithRetry(`https://www.amazon.com/dp/${asin}`, UA, 100000, 3);
  dbg('product len', html.length, 'captcha', /captcha|Robot Check/i.test(html));
  const strip = (v) => String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const title = metaOf(html, 'og:title')
    || strip((html.match(/id="productTitle"[^>]*>([\s\S]{0,300}?)<\/span>/i) || [])[1] || '')
    || strip((html.match(/<title>([^<]{0,300})<\/title>/i) || [])[1] || '');
  const intro = metaOf(html, 'og:description')
    || strip((html.match(/id="bookDescription_feature_div"[\s\S]{0,2000}?<div[^>]*>([\s\S]{0,1500}?)<\/div>/i) || [])[1] || '')
    || strip((html.match(/id="productDescription"[\s\S]{0,2000}?<p[^>]*>([\s\S]{0,1200}?)<\/p>/i) || [])[1] || '');
  const ratingM = html.match(/a-icon-alt">([0-9.]+) out of 5 stars/);
  const countM = html.match(/([0-9,]+)\s*ratings?/);
  const imgBlock = (html.match(/id="landingImage"[^>]*data-a-dynamic-image="([^"]+)"/) || [])[1] || '';
  const productCover = imgBlock
    ? (imgBlock.replace(/&quot;/g, '"').match(/https:\/\/[^"\\]+/) || [''])[0]
    : metaOf(html, 'og:image');
  const cover = productCover || card.cover || '';
  const finalTitle = title || card.title || '';
  const finalIntro = intro || card.intro || '';
  const finalRating = ratingM ? Number(ratingM[1]) : card.rating;
  const finalCount = countM ? Number(countM[1].replace(/,/g, '')) : card.count;
  if (!finalTitle && !cover && !finalRating) return null;
  return {
    source: 'amazon',
    asin,
    title,
    author: book.author || '',
    intro,
    cover: cover || '',
    rating: ratingM ? Number(ratingM[1]) : null,
    ratingCount: countM ? Number(countM[1].replace(/,/g, '')) : null,
  };
}

// ---------------- 封面落盘 ----------------
function downloadCover(url, coversDir) {
  if (!url) return '';
  try {
    const buf = execFileSync('curl', ['-sL', '-m', '20', '-A', UA, url], { maxBuffer: 12 * 1024 * 1024 });
    if (!buf || buf.length < 1000) return '';
    const ext = (url.match(/\.(jpg|jpeg|png|webp)(?:[?#]|$)/i) || [])[1] || 'jpg';
    const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.' + ext.replace('jpeg', 'jpg');
    fs.mkdirSync(coversDir, { recursive: true });
    fs.writeFileSync(path.join(coversDir, name), buf);
    return '/api/covers/' + name;
  } catch {
    return '';
  }
}

// ---------------- 缓存 ----------------
function cachePath(dataDir) {
  return path.join(dataDir, 'meta-cache.json');
}
function loadCache(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(dataDir), 'utf8'));
  } catch {
    return {};
  }
}
function saveCache(dataDir, cache) {
  try {
    const entries = Object.entries(cache).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 2000);
    fs.writeFileSync(cachePath(dataDir), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore */
  }
}

function cacheKey(book) {
  const { title, author } = normKey(book);
  return title + '|' + author;
}

/**
 * 补一本书的封面/简介/评分
 * @returns {Promise<{coverUrl?:string,intro?:string,rating?:number,ratingCount?:number,metaSource?:string}|null>}
 */
async function enrichBook(book, opts = {}) {
  const dataDir = opts.dataDir;
  const coversDir = opts.coversDir || path.join(dataDir, 'covers');
  const cache = loadCache(dataDir);
  const key = cacheKey(book);
  const hit = opts.force ? null : cache[key];
  const failedTtl = 6 * 3600 * 1000;
  const fresh = hit && (hit.result
    ? Date.now() - (hit.at || 0) < CACHE_TTL
    : hit.failed && Date.now() - (hit.at || 0) < failedTtl);
  let result = fresh && hit.result ? { ...hit.result } : null;

  if (!result && fresh && hit && hit.failed) return null;
  if (!result) {
    const kind = bookKind(book.bookUrl);
    let provider = null;
    if (kind === 'web') {
      provider = fromQidian(book) || fromJinjiang(book);
    } else {
      provider = fromAmazon(book);
    }
    if (!provider) {
      cache[key] = { at: Date.now(), result: null, failed: true };
      saveCache(dataDir, cache);
      return null;
    }
    const cover = provider.cover ? downloadCover(provider.cover, coversDir) : '';
    result = {
      coverUrl: cover || '',
      intro: provider.intro || '',
      rating: typeof provider.rating === 'number' ? provider.rating : null,
      ratingCount: provider.ratingCount || null,
      metaSource: provider.source,
      title: provider.title || '',
    };
    cache[key] = { at: Date.now(), result };
    saveCache(dataDir, cache);
  }

  const patch = {};
  if (!book.coverUrl && result.coverUrl) patch.coverUrl = result.coverUrl;
  if (!book.intro && result.intro) patch.intro = String(result.intro).slice(0, 2000);
  if (!book.rating && result.rating) {
    patch.rating = result.rating;
    patch.ratingCount = result.ratingCount || null;
  }
  patch.metaSource = result.metaSource;
  patch.metaAt = Date.now();
  return Object.keys(patch).length > 2 || patch.coverUrl || patch.intro || patch.rating ? patch : { metaSource: result.metaSource, metaAt: Date.now() };
}

function shouldEnrich(book) {
  if (!book) return false;
  return !book.coverUrl || !book.intro || !book.rating;
}

module.exports = { enrichBook, shouldEnrich, bookKind, cacheKey, CACHE_TTL, _providers: { fromAmazon, fromQidian, fromJinjiang } };
