'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const store = require('./store');
const diskCache = require('./cache');

// ---- 运行日志环形缓冲：导出日志给外部模型定位问题 ----
const LOG_RING = [];
const LOG_MAX = 800;
function logPush(line) {
  const t = new Date().toISOString();
  for (const l of String(line == null ? '' : line).split('\n')) {
    if (!l.trim()) continue;
    LOG_RING.push(`${t} ${l}`);
    if (LOG_RING.length > LOG_MAX) LOG_RING.splice(0, LOG_RING.length - LOG_MAX);
  }
}
(() => {
  const wrap = (stream) => {
    const orig = stream.write.bind(stream);
    stream.write = (chunk, enc, cb) => {
      try {
        logPush(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      } catch {
        /* ignore */
      }
      return orig(chunk, enc, cb);
    };
  };
  wrap(process.stdout);
  wrap(process.stderr);
})();
const { execFileSync } = require('node:child_process');
const { normalizeSource, sourceId } = require('./books');
const {
  searchSource: localSearchSource,
  getBookInfo: localGetBookInfo,
  getToc: localGetToc,
  getContent: localGetContent,
} = require('./books');
const parsePool = require('./parsepool');
const { request, requestBinary, absoluteUrl } = require('./util');
const { fetchFeed } = require('./feeds');
const { getArticle } = require('./article');
const replaceRules = require('./replace');
const introLookup = require('./intro');
const { buildSyncPayload } = require('./sync');
const { getDaily } = require('./daily');
const { dedupeBooks } = require('./dedupe');
const { dedupeCache, findExistingDir } = require('./cacheclean');
const tombstone = require('./tombstone');
const { normalizeChapterList } = require('./chapter-order');
const pyengine = require('./pyengine');
const javaWorker = require('./java-worker');
const metaenrich = require('./metaenrich');
javaWorker.setEnabled(store.config.javaEngine !== false);
const { mergeSources, pullSince } = require('./sourcesync');
const events = require('./events');
const remote = require('./remote');

// 订阅条目正文的内存缓存（按条目链接）
const chapterCache = new Map();
function rememberChapter(key, value) {
  chapterCache.set(key, value);
  if (chapterCache.size > 300) chapterCache.delete(chapterCache.keys().next().value);
}

const { detectAcademic } = require('./academic');
const { handleDav } = require('./dav');
const searchCache = require('./searchcache');

// 普通规则保持原解析路径；含同步 JS / java.* 的复杂规则交给 worker 池，避免卡住主事件循环。
const dynamicSearchRequests = new Map();
async function searchSource(source, key, page = 1, opts = {}) {
  if (!parsePool.shouldOffload(source)) return localSearchSource(source, key, page, opts);
  const requestKey = JSON.stringify([sourceId(source), source.searchUrl || '', key, page]);
  const known = dynamicSearchRequests.get(requestKey);
  if (known) {
    const cached = searchCache.get(known.url, known.body);
    if (cached) {
      const list = cached.map((b) => ({ ...b }));
      list.fromCache = true;
      return list;
    }
  }
  const meta = await parsePool.run('searchSource', [
    source,
    key,
    page,
    { ...opts, cache: false, returnMeta: true },
  ]);
  const books = meta && Array.isArray(meta.books) ? meta.books : [];
  if (!meta || !meta.url) throw new Error('复杂书源未返回有效搜索地址');
  dynamicSearchRequests.set(requestKey, { url: meta.url, body: meta.body });
  if (dynamicSearchRequests.size > 1000) dynamicSearchRequests.delete(dynamicSearchRequests.keys().next().value);
  searchCache.set(meta.url, meta.body, books);
  return books;
}

async function getBookInfo(source, book, opts = {}) {
  if (!parsePool.shouldOffload(source)) return localGetBookInfo(source, book, opts);
  const result = await parsePool.run('getBookInfo', [source, book, opts]);
  Object.assign(book, result || {});
  return book;
}

/**
 * 书城兜底：按书号补封面/简介/评分（出版物走亚马逊，网文走起点/晋江）
 * 只填空字段，不覆盖已有数据；失败静默。
 */
async function enrichShelfBook(url, opts = {}) {
  if (store.config.metaFallback === false) return null;
  const book = store.findBook(url) || store.books.find((b) => b.bookUrl === url);
  if (!book) return null;
  if (!opts.force && !metaenrich.shouldEnrich(book)) return null;
  const patch = await metaenrich.enrichBook(book, {
    dataDir: store.dataDir,
    coversDir: path.join(store.dataDir, 'covers'),
    force: !!opts.force,
  }).catch(() => null);
  if (!patch) return null;
  const current = store.findBook(book.bookUrl) || book;
  const changed = {};
  if (!current.coverUrl && patch.coverUrl) changed.coverUrl = patch.coverUrl;
  if (!current.intro && patch.intro) changed.intro = patch.intro;
  if (!current.rating && patch.rating) {
    changed.rating = patch.rating;
    changed.ratingCount = patch.ratingCount || null;
  }
  changed.metaSource = patch.metaSource || current.metaSource || '';
  changed.metaAt = Date.now();
  if (!changed.coverUrl && !changed.intro && !changed.rating) return null;
  store.upsertBook({ ...current, ...changed });
  events.broadcast({
    type: 'shelf',
    action: 'enriched',
    bookUrl: current.bookUrl,
    cover: !!changed.coverUrl,
    intro: !!changed.intro,
    rating: changed.rating || null,
    source: changed.metaSource,
  });
  return changed;
}

function scheduleMetaEnrich(url, delay = 1200) {
  if (!url || store.config.metaFallback === false) return;
  setTimeout(() => enrichShelfBook(url).catch(() => {}), delay);
}

async function normalizeTocOffload(chapters) {
  const fromJava = await javaWorker.normalizeToc(chapters).catch(() => null);
  const list = fromJava || normalizeChapterList(chapters);
  return list.map((chapter, index) => ({ ...chapter, index }));
}

async function getToc(source, book, opts = {}) {
  const chapters = !parsePool.shouldOffload(source)
    ? await localGetToc(source, book, opts)
    : await parsePool.run('getToc', [source, book, opts]);
  return normalizeTocOffload(chapters);
}

async function getContent(source, book, chapter) {
  if (!parsePool.shouldOffload(source)) return localGetContent(source, book, chapter);
  return parsePool.run('getContent', [source, book, chapter]);
}

const APPNAME = process.env.TRIM_APPNAME || 'legado-web';
const WEB_DIR = path.resolve(process.env.LEGADO_WEB || path.join(__dirname, '..', 'web'));
const PORT = Number(process.env.TRIM_SERVICE_PORT || process.env.PORT || 1122);
const APP_DEST = process.env.TRIM_APPDEST || path.join(process.cwd(), 'target');
function manifestVersion() {
  try {
    const text = fs.readFileSync(path.join(APP_DEST, 'manifest'), 'utf8');
    const m = /^version=(.+)$/m.exec(text);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}
const APP_VERSION = process.env.TRIM_APPVER || manifestVersion() || '0.0.0';
const BUILD_ID = APP_VERSION;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

const contentCache = new Map(); // key -> paragraphs
function cacheGet(key) {
  return contentCache.get(key);
}
function cacheSet(key, val) {
  // 空正文与反爬占位页都不写缓存，避免一次失败把整章永久钉死
  if (!Array.isArray(val) || !val.length) return;
  if (contentLooksJunk(val)) {
    contentCache.delete(key);
    return;
  }
  if (contentCache.size > 300) contentCache.delete(contentCache.keys().next().value);
  contentCache.set(key, val);
}

const prefetching = new Set();
const inflight = new Map(); // 同一章并发请求只抓一次

/** 取章节正文：内存 → 磁盘 → 网络 */
/** 清掉正文里的 HTML 片段（<br>/<div>/<p> 等），按标签断行并还原实体 */
function cleanParagraphs(list) {
  const out = [];
  const push = (t) => {
    const v = String(t || '').replace(/\u3000/g, ' ').trim();
    if (v) out.push(v);
  };
  for (const raw of list || []) {
    let t = String(raw == null ? '' : raw);
    if (!/[<&]/.test(t)) {
      push(t);
      continue;
    }
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|section|article|li|h[1-6])\s*>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = t
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'");
    t.split('\n').forEach(push);
  }
  return out;
}

/** 反爬占位页/目录页残留：这类“正文”不能当成功结果，应回落到手机代理解析 */
function contentLooksJunk(paragraphs) {
  const text = (paragraphs || []).join('\n').trim();
  if (!text) return true;
  // 反爬占位页通常很短；超过 800 字基本是真正文
  if (text.length > 800) return false;
  return /退出阅读模式|退出#?阅读|#退#出#阅#读|章节缺失|章节#?缺失|请使用其它.{0,4}浏览器|网页版.{0,6}最新内容|请退出转码|最快.{0,4}免费阅读|最新网址|本章未完|#中间#有#缺失|quyoulai|q#u#y#o#u#l#a#i/.test(
    text,
  );
}

async function loadChapterContent(book, index) {
  const chapter = book.chapters[index];
  if (!chapter) throw new Error('章节不存在');
  const key = chapter.url || `${book.bookUrl}#${index}`;
  // 手机同步过来的缓存：正文直接读本地文件
  if (book.cachedDir && chapter.file) {
    try {
      const file = path.join(book.cachedDir, chapter.file);
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        const paragraphs = text
          .split(/\n{2,}/)
          .map((x) => x.trim())
          .filter(Boolean);
        if (paragraphs.length && !contentLooksJunk(paragraphs)) {
          cacheSet(key, paragraphs);
          return { paragraphs, cached: false, fromCache: true };
        }
      }
    } catch {
      /* 读盘失败就继续走网络 */
    }
  }
  if (book.viaPhone) {
    // 手机解析过的章节落过盘，就不必再问手机
    const hit = readPhoneCache(book.bookUrl, index, 'content');
    if (hit && Array.isArray(hit.paragraphs) && hit.paragraphs.length && !contentLooksJunk(hit.paragraphs)) {
      cacheSet(key, hit.paragraphs);
      return { paragraphs: cleanParagraphs(hit.paragraphs), cached: true, via: 'phone-cache' };
    }
    const paragraphs = await remoteContent(book, chapter).catch(() => null);
    if (paragraphs && paragraphs.length) {
      cacheSet(key, paragraphs);
      writePhoneCache(book.bookUrl, index, 'content', { paragraphs, title: chapter.title, at: Date.now() });
      return { paragraphs: cleanParagraphs(paragraphs), cached: false, via: 'phone' };
    }
  }
  const mem = cacheGet(key);
  if (mem && mem.length) {
    if (!contentLooksJunk(mem)) return { paragraphs: cleanParagraphs(mem), cached: true };
    contentCache.delete(key); // 反爬占位不当作缓存命中，清掉后重新解析
  }
  const disk = diskCache.get(key);
  if (disk && Array.isArray(disk.paragraphs) && disk.paragraphs.length) {
    if (!contentLooksJunk(disk.paragraphs)) {
      cacheSet(key, disk.paragraphs);
      return { paragraphs: cleanParagraphs(disk.paragraphs), cached: true };
    }
    diskCache.del(key);
  }
  if (inflight.has(key)) {
    const paragraphs = await inflight.get(key);
    return { paragraphs: cleanParagraphs(paragraphs), cached: true };
  }
  // 只有“手机专属书”或本机确实没有书源时才手机优先；
  // 其余书本地优先，避免所有章节都去挤软总线队列（软件总线应只做兜底）
  const source = resolveSource(book);
  if ((book.viaPhone || !source) && busAvailable()) {
    const paras = await remoteContent(book, chapter).catch(() => null);
    if (paras && paras.length) {
      const cleaned = cleanParagraphs(paras);
      cacheSet(key, cleaned);
      writePhoneCache(book.bookUrl, index, 'content', { paragraphs: cleaned, title: chapter.title, at: Date.now() });
      bumpUsage('phoneContent');
      return { paragraphs: cleaned, cached: false, via: 'phone' };
    }
  }
  if (!source) throw new Error('该书没有关联书源，且没有本地缓存');
  bumpUsage('localContent');
  if (effectiveEngine() === 'python') {
    try {
      const r = await pyengine.call('content', { source, chapterUrl: chapter.url, bookUrl: book.bookUrl });
      if (r && Array.isArray(r.paragraphs) && r.paragraphs.length) {
        const paragraphs = cleanParagraphs(r.paragraphs);
        cacheSet(key, paragraphs);
        return { paragraphs, cached: false, via: 'python' };
      }
    } catch {
      /* 回退内置 */
    }
  }
  const promise = getContent(source, book, chapter).then((raw) => cleanParagraphs(raw));
  inflight.set(key, promise);
  try {
    let paragraphs;
    try {
      paragraphs = await promise;
    } catch (localErr) {
      // 本地解析报错（反爬/403/站点改版）时，若手机在线就交给手机重试一次
      if (busAvailable()) {
        const remote = await remoteContent(book, chapter).catch(() => null);
        if (remote && remote.length) {
          const cleanedRemote = cleanParagraphs(remote);
          if (!contentLooksJunk(cleanedRemote)) {
            cacheSet(key, cleanedRemote);
            diskCache.set(key, { paragraphs: cleanedRemote, title: chapter.title });
            writePhoneCache(book.bookUrl, index, 'content', { paragraphs: cleanedRemote, title: chapter.title, at: Date.now() });
            bumpUsage('phoneContent');
            return { paragraphs: cleanedRemote, cached: false, via: 'phone' };
          }
        }
      }
      throw localErr;
    }
    // 反爬占位页（“退出阅读模式 / 章节缺失”等）不能当正文缓存，优先交给手机重解析。
    if (contentLooksJunk(paragraphs) && busAvailable()) {
      const remote = await remoteContent(book, chapter).catch(() => null);
      if (remote && remote.length) {
        const cleanedRemote = cleanParagraphs(remote);
        if (!contentLooksJunk(cleanedRemote)) {
          cacheSet(key, cleanedRemote);
          diskCache.set(key, { paragraphs: cleanedRemote, title: chapter.title });
          writePhoneCache(book.bookUrl, index, 'content', { paragraphs: cleanedRemote, title: chapter.title, at: Date.now() });
          bumpUsage('phoneContent');
          return { paragraphs: cleanedRemote, cached: false, via: 'phone' };
        }
      }
    }
    if (!contentLooksJunk(paragraphs)) {
      cacheSet(key, paragraphs);
      diskCache.set(key, { paragraphs, title: chapter.title });
    } else {
      diskCache.del(key); // 反爬占位不落盘，交给下次手机重解析
    }
    return { paragraphs, cached: false };
  } finally {
    inflight.delete(key);
  }
}

/** 后台预取（不阻塞当前请求） */
function prefetchChapter(book, index) {
  if (index < 0 || index >= book.chapters.length) return;
  const chapter = book.chapters[index];
  const key = chapter.url || `${book.bookUrl}#${index}`;
  if (cacheGet(key) || prefetching.has(key)) return;
  prefetching.add(key);
  const timer = setTimeout(async () => {
    try {
      if (!cacheGet(key)) await loadChapterContent(book, index);
    } catch {
      /* 预取失败忽略 */
    } finally {
      prefetching.delete(key);
    }
  }, 400);
  if (timer.unref) timer.unref();
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      let text = buf.toString('utf8');
      // 有些安卓端把 JSON 按 GBK 发上来，UTF-8 解出来会带替换符，这里回退一次
      if (text.includes('\uFFFD')) {
        try {
          const gbk = new TextDecoder('gbk').decode(buf);
          if (gbk && !gbk.includes('\uFFFD')) text = gbk;
        } catch {
          /* 环境不支持 gbk 就保持原样 */
        }
      }
      resolve(text);
    });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求数据不是合法 JSON');
  }
}

const staticCache = new Map(); // filePath -> { etag, raw, gz, type }

function cachePolicy(ext) {
  // 页面与脚本每次都回源校验（有 ETag，命中就是 304），避免用户看到旧界面
  return ['.html', '.js', '.css', '.txt'].includes(ext) ? 'no-cache' : 'public, max-age=86400';
}

function serveStatic(req, res, pathname, retried = false) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  const outside = path.relative(WEB_DIR, filePath);
  if (outside.startsWith('..') || path.isAbsolute(outside)) return json(res, 403, { error: 'forbidden' });

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA 回退到 index.html（只回退一次）
      if (!retried) return serveStatic(req, res, '/index.html', true);
      return json(res, 404, { error: 'not found' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cachePolicy(ext) });
      return res.end();
    }

    let entry = staticCache.get(filePath);
    if (!entry || entry.etag !== etag) {
      let raw;
      try {
        raw = fs.readFileSync(filePath);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      const compressible = ['.html', '.js', '.css', '.svg', '.json', '.ico'].includes(ext);
      entry = {
        etag,
        raw,
        gz: compressible && raw.length > 1024 ? zlib.gzipSync(raw, { level: 6 }) : null,
        type: MIME[ext] || 'application/octet-stream',
      };
      if (staticCache.size > 60) staticCache.clear();
      staticCache.set(filePath, entry);
    }

    const accept = String(req.headers['accept-encoding'] || '');
    const useGzip = entry.gz && /gzip/.test(accept);
    const body = useGzip ? entry.gz : entry.raw;
    const headers = {
      'Content-Type': entry.type,
      'Content-Length': body.length,
      ETag: etag,
      'Cache-Control': cachePolicy(ext),
      Vary: 'Accept-Encoding',
    };
    if (useGzip) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(body);
  });
}

function sanitizeBook(book) {
  if (!book) return null;
  const { chapters, ...rest } = book;
  return { ...rest, chapterCount: chapters ? chapters.length : book.chapterCount || 0 };
}

/** 按 URL 找书架书；换源合并后旧 URL 会落在 altOrigins 里，这里一并认 */
function resolveShelfBook(url) {
  const direct = store.findBook(url);
  if (direct) return direct;
  if (!url) return null;
  for (const b of store.books) {
    const alts = Array.isArray(b.altOrigins) ? b.altOrigins : [];
    if (alts.some((a) => a && (a.bookUrl === url || a.origin === url))) return b;
  }
  return null;
}

/**
 * 实际生效的解析引擎：
 * - Python 引擎关 → node
 * - 引擎开 + 工作模式=解析（core）→ python 接管规则解析
 * - 引擎开 + 工作模式=辅助（aux）→ node 解析，Python 只做辅助
 */
function effectiveEngine() {
  if (store.config.engine !== 'python') return 'node';
  return String(store.config.pyMode || 'aux') === 'core' ? 'python' : 'node';
}

/** Python 是否负责辅助任务（TXT 下载 / 去重 / 缓存转换）：引擎开 + 辅助模式 */
function pythonAuxEnabled() {
  return store.config.engine === 'python' && String(store.config.pyMode || 'aux') !== 'core';
}

/* ---------------- 业务处理 ---------------- */

/** 对标题/正文应用「替换·屏蔽」规则 */
function applyReplaceRules(book, chapter, paragraphs) {
  try {
    const rules = replaceRules.load(store.dataDir);
    if (!rules || !rules.length) return { title: chapter.title, paragraphs };
    const title = replaceRules.applyText(rules, chapter.title, 'title');
    let out = replaceRules.applyToParagraphs(rules, paragraphs);
    if ((!out || !out.length) && paragraphs && paragraphs.length) out = paragraphs;
    return { title, paragraphs: out };
  } catch {
    return { title: chapter.title, paragraphs };
  }
}

/* ---------------- 搜索 ---------------- */
// 默认检索的推荐源：覆盖网文/晋江/聚合站，避免默认把 1000+ 源全扫导致长时间无结果
const DEFAULT_SEARCH_SOURCES = [
  'https://www.jjwxc.net',
  'https://m.quyoulai.net',
  'http://www.feisuwx.org',
  'http://www.3yt.com',
  'https://m.feixs.com',
  'https://www.555x.org',
  'http://www.vbiquge.org',
  'https://69shu.net',
  'https://www.dubuxiaoshuo.com',
  'http://www.biquw.com',
  'https://www.147xs.org',
  'https://www.ixuanshu.org',
  'https://m.fansg.cc',
  'https://m.shucangxs.com',
  'https://www.soumal.com',
  'https://m.aitbooks.com',
  'https://m.xuribook.com',
  'https://www.56fz.net',
  'https://m.meiguixsw.com',
  'https://m.yushugu.com',
  'http://www.55shuba.com',
  'https://m.x33xs.com',
  'https://www.yb3.cc',
  'https://www.00shu.com',
  'https://www.shuquzw.com',
  'https://www.hongxiuxs.com',
  'http://www.22ff.vip',
  'https://www.aixiaxsw.com',
  'https://m.zhongtianwen.cn',
  'https://m.xhwx5.com',
  'http://www.22mt.net',
];

const normSearchText = (s) =>
  String(s || '')
    .replace(/[\s《》「」"'·、,，.。:：!！?？\-—_\[\]ⅠⅡⅢ]/g, '')
    .toLowerCase();

/** 命中级别：exact=同名，fuzzy=前缀包含，related=其余；并按级别排序 */
function rankSearchBooks(books, key) {
  const k = normSearchText(key);
  const level = (b) => {
    const n = normSearchText(b.name);
    if (n === k) return 0;
    if (n.startsWith(k) || n.includes(k)) return 1;
    return 2;
  };
  return books
    .map((b) => ({ ...b, match: ['exact', 'fuzzy', 'related'][level(b)] }))
    .sort((a, b) => level(a) - level(b));
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const wrapped = Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error((label || '解析') + '超时')), ms);
    }),
  ]);
  return wrapped.finally(() => clearTimeout(timer));
}

async function handleSearchSSE(req, res, params) {
  const key = String(params.get('key') || '').trim();
  const ids = String(params.get('sources') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const concurrency = Math.max(1, Math.min(16, Number(params.get('limit') || 12)));
  const group = params.get('group');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!key) {
    send({ type: 'error', message: '请输入搜索关键字' });
    return res.end();
  }

  let sources = store.sources.filter((s) => s.enabled && !isJunkSource(s));

  // 正版接口源默认不搜；用户勾选「正版源」或指定了具体书源时才包含
  const includeOfficial = params.get('official') === '1' || ids.length > 0;
  let officialSkipped = 0;
  if (!includeOfficial) {
    const beforeOfficial = sources.length;
    sources = sources.filter((s) => !isOfficialSource(s));
    officialSkipped = beforeOfficial - sources.length;
    if (officialSkipped > 0) {
      send({ type: 'note', message: `已跳过 ${officialSkipped} 个正版接口源（起点/QQ/掌阅等），需要时勾选「正版源」` });
    }
  }

  // 学术关键词识别：命中后只搜学术类书源，跳过网络小说源
  let academicInfo = null;
  if (params.get('auto') !== '0' && !ids.length && !group) {
    const det = detectAcademic(key);
    if (det.academic) {
      const acad = sources.filter((s) => /学术|论文|文献|期刊/.test(s.bookSourceGroup || ''));
      if (acad.length) {
        sources = acad;
        academicInfo = { hits: det.hits, total: acad.length };
      }
    }
  }
  // 学术模式下不再受「仅可用 / 分组」限制：学术源通常没做过体检
  if (!academicInfo) {
    if (params.get('only') === 'checked') sources = sources.filter((s) => s.checkStatus === 'ok');
    if (group) sources = sources.filter((s) => (s.bookSourceGroup || '') === group);
  }
  if (ids.length) sources = sources.filter((s) => ids.includes(s.bookSourceUrl));
  // 默认检索只用推荐源，既快又覆盖主流站点；显式指定源/分组/学术模式时不受限制
  if (!ids.length && !group && !academicInfo && params.get('all') !== '1') {
    const curated = sources.filter((s) => DEFAULT_SEARCH_SOURCES.includes(s.bookSourceUrl));
    if (curated.length >= 4) {
      // 推荐源优先（它们多数响应快、规则稳），其余源排在后面，在硬截止时限内顺带补扫，
      // 这样既不牺牲首屏延迟，也不会因为推荐源失效而搜不到书
      const rest = params.get('curated') === '1' ? [] : sources.filter((s) => !DEFAULT_SEARCH_SOURCES.includes(s.bookSourceUrl));
      sources = curated.concat(rest);
      send({ type: 'note', message: `默认检索 ${curated.length} 个推荐源优先${rest.length ? `，另 ${rest.length} 个源在时限内补扫` : ''}` });
    }
  }
  // 检测可用的源优先，先出结果
  sources = sources.slice().sort((a, b) => Number(b.checkStatus === 'ok') - Number(a.checkStatus === 'ok'));

  if (!sources.length) {
    send({ type: 'error', message: '没有可用书源，请先在书源管理中导入' });
    return res.end();
  }

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  if (academicInfo) send({ type: 'academic', hits: academicInfo.hits, total: academicInfo.total });

  send({ type: 'start', total: sources.length });
  const deadlineMs = Math.max(10000, Math.min(120000, (Number(params.get('deadline')) || 45) * 1000));
  const deadline = Date.now() + deadlineMs;
  let timedOut = false;
  let cursor = 0;
  let found = 0;
  let doneCount = 0;
  let cachedSources = 0;
  let phoneFallbacks = 0;
  const finish = (extra) => {
    if (closed) return;
    closed = true;
    send({ type: 'done', found, officialSkipped: typeof officialSkipped === 'number' ? officialSkipped : 0, timedOut, deadlineMs, ...(extra || {}) });
    res.end();
  };
  // 硬截止：到点直接收尾，不等在途的慢源（否则 45s 的 deadline 会拖到 90s+）
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    finish();
  }, deadlineMs);
  if (deadlineTimer.unref) deadlineTimer.unref();
  const worker = async () => {
    while (!closed) {
      if (Date.now() > deadline) {
        timedOut = true;
        return;
      }
      const i = cursor++;
      if (i >= sources.length) return;
      const source = sources[i];
      const startedAt = Date.now();
      send({ type: 'source-start', source: source.bookSourceName, id: source.bookSourceUrl });

      // 搜索本地优先（毫秒级），失败/无结果再交给手机；手机优先会让每个源多等 20s
      if (closed) return;

      // Python 引擎其次（本地解析），失败再走内置实现
      if (effectiveEngine() === 'python' && !closed) {
        try {
          const r = await pyengine.call('search', { source, key });
          if (r && Array.isArray(r.books) && r.books.length) {
            const books = rankSearchBooks(r.books.map((b) => ({ ...b, origin: b.origin || source.bookSourceUrl, originName: b.originName || source.bookSourceName })), key);
            found += books.length;
            send({ type: 'result', source: source.bookSourceName, id: source.bookSourceUrl, books, via: 'python' });
            doneCount++;
            send({
              type: 'source-done',
              source: source.bookSourceName,
              count: books.length,
              ms: Date.now() - startedAt,
              done: doneCount,
              total: sources.length,
              via: 'python',
            });
            continue;
          }
        } catch (e) {
          send({ type: 'log', message: `python 引擎失败（${source.bookSourceName}）：${e.message}` });
        }
      }

      try {
        const booksRaw = await withTimeout(searchSource(source, key, 1), 15000, '搜索');
        const fromCache = booksRaw.fromCache === true;
        const books = rankSearchBooks(booksRaw, key);
        if (closed) return;
        if (fromCache) cachedSources++;
        if (books.length) {
          found += books.length;
          send({ type: 'result', source: source.bookSourceName, id: source.bookSourceUrl, books });
        }
        doneCount++;
        send({
          type: 'source-done',
          source: source.bookSourceName,
          count: books.length,
          ms: Date.now() - startedAt,
          done: doneCount,
          total: sources.length,
          cached: fromCache,
          cachedTotal: cachedSources,
        });
      } catch (e) {
        // 本机解析失败：还没有结果时才交给手机，且最多 3 个源，避免每个源都等手机 15s
        if (!closed && found === 0 && (params.get('remote') === '1' || (busAvailable() && phoneFallbacks < 3))) {
          phoneFallbacks++;
          const phoneMs = Math.max(5000, Math.min(15000, deadline - Date.now()));
          const r = await phoneSearch(source.bookSourceUrl, key, phoneMs);
          if (!closed && r.ok && r.data && Array.isArray(r.data.books) && r.data.books.length) {
            const fromPhone = rankSearchBooks(r.data.books.map((b) => ({ ...b, viaPhone: true, origin: b.origin || source.bookSourceUrl })), key);
            found += fromPhone.length;
            send({ type: 'result', source: source.bookSourceName, id: source.bookSourceUrl, books: fromPhone, via: 'phone' });
            doneCount++;
            send({
              type: 'source-done',
              source: source.bookSourceName,
              count: fromPhone.length,
              ms: Date.now() - startedAt,
              done: doneCount,
              total: sources.length,
              via: 'phone',
            });
            continue;
          }
        }
        doneCount++;
        if (!closed)
          send({
            type: 'source-done',
            source: source.bookSourceName,
            error: String(e.message || e),
            ms: Date.now() - startedAt,
            done: doneCount,
            total: sources.length,
          });
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, worker);
  Promise.all(workers).then(() => {
    clearTimeout(deadlineTimer);
    finish();
  });
}

/* ---------------- 书源体检 ---------------- */
const checkJob = { running: false, total: 0, done: 0, ok: 0, empty: 0, fail: 0, key: '', startedAt: 0 };

function checkSummary() {
  return {
    running: checkJob.running,
    total: checkJob.total,
    done: checkJob.done,
    ok: checkJob.ok,
    empty: checkJob.empty,
    fail: checkJob.fail,
    key: checkJob.key,
    startedAt: checkJob.startedAt,
  };
}

async function startCheck(key, ids = []) {
  const all = store.sources;
  const sources = ids.length ? all.filter((s) => ids.includes(s.bookSourceUrl)) : all;
  Object.assign(checkJob, {
    running: true,
    total: sources.length,
    done: 0,
    ok: 0,
    empty: 0,
    fail: 0,
    key,
    startedAt: Date.now(),
  });
  for (const s of sources) {
    s.checkStatus = '';
    s.checkAt = 0;
  }
  store.saveSources(store.sources);

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= sources.length) return;
      const s = sources[i];
      let status = 'fail';
      try {
        const books = await searchSource(s, key, 1, { timeout: Number(process.env.LEGADO_CHECK_TIMEOUT || 8000) });
        status = books.length ? 'ok' : 'empty';
      } catch {
        status = 'fail';
      }
      s.checkStatus = status;
      s.checkAt = Date.now();
      checkJob.done++;
      if (status === 'ok') checkJob.ok++;
      else if (status === 'empty') checkJob.empty++;
      else checkJob.fail++;
      if (checkJob.done % 10 === 0) store.saveSources(store.sources);
    }
  };

  try {
    const n = Math.min(10, Math.max(1, sources.length));
    await Promise.all(Array.from({ length: n }, worker));
  } finally {
    store.saveSources(store.sources);
    checkJob.running = false;
  }
}

const DOWNLOAD_DIR = path.join(store.dataDir, 'downloads');
const downloadJobs = new Map(); // bookUrl -> job

const DOWNLOAD_INDEX = path.join(store.dataDir, 'downloads.json');
const FEEDS_FILE = path.join(store.dataDir, 'feeds.json');
const IMG_DIR = path.join(store.dataDir, 'cache', 'img');
const COVER_DIR = path.join(store.dataDir, 'covers');
const PHONE_CACHE = path.join(store.dataDir, 'cache', 'phone');

function phoneCachePath(bookUrl, index, kind) {
  const h = crypto.createHash('sha1').update(String(bookUrl)).digest('hex').slice(0, 16);
  return path.join(PHONE_CACHE, h, `${kind}-${index}.json`);
}

function readPhoneCache(bookUrl, index, kind) {
  try {
    const f = phoneCachePath(bookUrl, index, kind);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function writePhoneCache(bookUrl, index, kind, data) {
  try {
    const f = phoneCachePath(bookUrl, index, kind);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data), 'utf8');
  } catch {
    /* 落盘失败不影响阅读 */
  }
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

/** 可选的下载目录：应用数据目录 + 用户在 fnOS 里授权的目录 */
/**
 * 安装或更新后是否需要让用户确认缓存保存位置。
 * 记录确认过的版本：版本变了（更新过）或从未确认过 → 需要确认。
 */
function setupState() {
  const confirmed = String(store.config.setupVersion || '');
  const cacheDir = resolveDownloadDir();
  return {
    needConfirm: confirmed !== APP_VERSION,
    version: APP_VERSION,
    confirmedVersion: confirmed,
    cacheDir,
    cachePath: path.join(cacheDir, 'cache'),
    dirs: allowedDownloadDirs(),
  };
}

/** 软总线（App 轮询任务）是否已放行 */
function busEnabled() {
  return String(store.config.setupVersion || '') === APP_VERSION;
}

function allowedDownloadDirs() {
  const dirs = [{ label: '应用数据目录（默认）', path: path.join(store.dataDir, 'downloads') }];
  const extra = String(process.env.TRIM_DATA_ACCESSIBLE_PATHS || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  const add = (p) => {
    if (!p || dirs.some((d) => d.path === p)) return;
    try {
      if (fs.statSync(p).isDirectory()) {
        const name = p.replace(/\/+$/, '').split('/').pop() || p;
        dirs.push({ label: name, path: p });
      }
    } catch {
      /* 跳过不存在/无权限的目录 */
    }
  };
  for (const p of extra) add(p);
  // 环境变量可能滞后于授权操作，保留用户之前选过的目录
  add(store.config.downloadDir);
  // fnOS 重装/重启后 TRIM_DATA_ACCESSIBLE_PATHS 会被清空，
  // 这里扫描常见卷上的可写目录，让用户仍能选到自己的空间
  const roots = ['/vol1/1000', '/vol2/1000', '/vol3/1000', '/vol4/1000', '/vol1/@appshare', '/vol00'];
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root).slice(0, 40);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = path.join(root, name);
      try {
        if (fs.statSync(p).isDirectory() && isWritableDir(p)) add(p);
      } catch {
        /* ignore */
      }
    }
  }
  return dirs;
}

function isWritableDir(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDownloadDir() {
  const dirs = allowedDownloadDirs();
  const wanted = store.config.downloadDir;
  // 配置的目录只要存在且可写就用它（环境变量可能滞后于授权操作）
  if (wanted && isWritableDir(wanted)) return wanted;
  return dirs[0].path;
}

function recordDownload(book, file, size, failed) {
  const list = readJSON(DOWNLOAD_INDEX, []);
  const entry = {
    bookUrl: book.bookUrl,
    name: book.name,
    author: book.author || '',
    file,
    size,
    chapters: book.chapters.length,
    failed: failed || 0,
    time: Date.now(),
  };
  const idx = list.findIndex((x) => x.bookUrl === book.bookUrl);
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);
  writeJSON(DOWNLOAD_INDEX, list);
}

function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 4 && buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 4 && buf.toString('ascii', 0, 4) === '<svg') return 'image/svg+xml';
  return 'image/jpeg';
}

/** 封面代理：带 Referer 抓取并落盘，规避站点防盗链 */
async function serveImage(res, url, referer) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: 'bad url' });
  const key = crypto.createHash('sha1').update(target).digest('hex');
  const file = path.join(IMG_DIR, key);
  if (fs.existsSync(file)) {
    try {
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': sniffImageType(buf), 'Cache-Control': 'public, max-age=604800' });
      return res.end(buf);
    } catch {
      /* 重新抓取 */
    }
  }
  const { buffer } = await requestBinary(target, { referer: referer || undefined, timeout: 12000 });
  if (!buffer || !buffer.length) return json(res, 502, { error: '图片抓取失败' });
  try {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    if (buffer.length < 3 * 1024 * 1024) fs.writeFileSync(file, buffer);
  } catch {
    /* 缓存失败忽略 */
  }
  res.writeHead(200, { 'Content-Type': sniffImageType(buffer), 'Cache-Control': 'public, max-age=604800' });
  return res.end(buffer);
}

function safeFileName(name) {
  return (
    String(name || 'book')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'book'
  );
}

function downloadSummary(job) {
  if (!job) return { running: false, done: 0, total: 0 };
  return {
    running: job.running,
    done: job.done,
    total: job.total,
    failed: job.failed,
    via: job.via || '',
    file: job.file ? path.basename(job.file) : '',
    error: job.error || '',
  };
}

/** Node 兜底下载（Python 辅助模式关闭时用，2 并发） */
function startDownloadNode(book) {
  const existing = downloadJobs.get(book.bookUrl);
  if (existing && existing.running) return existing;
  const job = { running: true, done: 0, total: book.chapters.length, failed: 0, file: null, error: '', via: 'node', cancel: false };
  downloadJobs.set(book.bookUrl, job);
  (async () => {
    const chunks = [];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (job.cancel || i >= book.chapters.length) return;
        const ch = book.chapters[i];
        try {
          const { paragraphs } = await loadChapterContent(book, i);
          chunks.push({ i, text: `\n\n${ch.title}\n\n${paragraphs.join('\n\n')}` });
        } catch {
          job.failed++;
          chunks.push({ i, text: `\n\n${ch.title}\n\n（本章抓取失败）` });
        }
        job.done++;
        if (job.done % 5 === 0) await new Promise((r) => setImmediate(r));
      }
    };
    try {
      await Promise.all([worker(), worker()]);
      if (job.cancel) return (job.error = '已取消');
      const outDir = resolveDownloadDir();
      fs.mkdirSync(outDir, { recursive: true });
      chunks.sort((a, b) => a.i - b.i);
      const text = '\uFEFF' + `${book.name}\n作者：${book.author || '未知'}\n来源：${book.originName || book.origin || ''}\n` + chunks.map((c) => c.text).join('');
      const file = path.join(outDir, `${safeFileName(book.name)}.txt`);
      fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o644 });
      job.file = file;
      recordDownload(book, file, text.length, job.failed);
    } catch (e) {
      job.error = String(e.message || e);
    } finally {
      job.running = false;
    }
  })();
  return job;
}

/** 后台把整本书抓成 txt：交给 Python 引擎，4 线程并发 */
function startDownload(book) {
  if (!pythonAuxEnabled()) return startDownloadNode(book);
  const existing = downloadJobs.get(book.bookUrl);
  if (existing && existing.running) return existing;

  const job = {
    running: true,
    done: 0,
    total: (book.chapters || []).length,
    failed: 0,
    file: null,
    error: '',
    via: 'python',
    threads: 4,
    cancel: false,
  };
  downloadJobs.set(book.bookUrl, job);

  if (!book.chapters || !book.chapters.length) {
    job.running = false;
    job.error = '目录为空，先刷新目录';
    return job;
  }
  const source = resolveSource(book);
  if (!source) {
    job.running = false;
    job.error = '未找到书源，无法整本下载';
    return job;
  }

  const outDir = resolveDownloadDir();
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${safeFileName(book.name)}.txt`);
  const progressPath = outPath + '.progress.json';
  try {
    fs.rmSync(progressPath, { force: true });
  } catch {
    /* ignore */
  }

  const payload = {
    source,
    chapters: book.chapters.map((c) => ({ title: c.title, url: c.url })),
    outPath,
    progressPath,
    threads: 4,
    header: `${book.name}\n作者：${book.author || '未知'}\n来源：${book.originName || book.origin || ''}\n`,
  };

  const { child, promise } = pyengine.start('book_txt', payload);
  job.child = child;
  const timer = setInterval(() => {
    if (job.cancel) return;
    try {
      const st = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      job.done = Number(st.done) || 0;
      job.failed = Number(st.failed) || 0;
      job.total = Number(st.total) || job.total;
      events.broadcast({ type: 'download-progress', bookUrl: book.bookUrl, done: job.done, total: job.total, failed: job.failed });
    } catch {
      /* 进度文件还没写 */
    }
  }, 1000);
  timer.unref?.();

  promise
    .then((r) => {
      clearInterval(timer);
      if (job.cancel) {
        job.error = '已取消';
        return;
      }
      if (!r.ok) {
        job.error = (r.data && r.data.error) || r.error || (r.stderr || '').slice(-200) || 'Python 下载失败';
        return;
      }
      job.done = r.data.done || job.done;
      job.failed = r.data.failed || 0;
      job.total = r.data.total || job.total;
      job.file = outPath;
      try {
        fs.chmodSync(outPath, 0o644);
      } catch {
        /* ignore */
      }
      recordDownload(book, outPath, r.data.chars || 0, job.failed);
    })
    .catch((e) => {
      clearInterval(timer);
      job.error = String(e.message || e);
    })
    .finally(() => {
      job.running = false;
      try {
        fs.rmSync(progressPath, { force: true });
      } catch {
        /* ignore */
      }
    });

  return job;
}

/* ---------------- 移动端接入 API ---------------- */
// 供安卓 App / 第三方客户端读取书架、目录、正文
function apiToken() {
  if (!store.config.apiToken) store.saveConfig({ apiToken: crypto.randomBytes(12).toString('hex') });
  return store.config.apiToken;
}

// ---- 本地电子书引擎（Text Parsing Engine） ----
const ebookStore = require('./ebook/store');
const ebookScan = require('./ebook/scan');
const ebookBus = require('./ebook/bus');
const ebookRender = require('./ebook/render');
const ebookLocal = require('./ebook/local');
const ebookPages = require('./ebook/pdfpages');
const { splitTxtChapters: splitTxtByRules } = require('./txtrule');

const ebookCtx = {
  dataDir: store.dataDir,
  config: () => store.config,
  remote,
  token: () => apiToken(),
  log: (...args) => console.log(...args),
  afterScan: async () => {
    const off = ebookBus.ebookMode(store.config) === 'off';
    if (off) return linkLocalEbooksToShelf();
    const list = ebookStore
      .loadIndex(store.dataDir)
      .filter((e) => String(e.format).toLowerCase() === 'txt' && e.status !== 'toc-only' && e.source !== 'device');
    for (const e of list) {
      try {
        await pythonParseTxtEntry(e);
      } catch (err) {
        console.log('[legado-web] TXT Python 分章失败：' + (err.message || err));
      }
    }
    return linkLocalEbooksToShelf();
  },
};

/** 客户端传书专用令牌（与 X-Api-Token 分开，泄露不影响书架读写） */
function uploadToken() {
  if (!store.config.uploadToken) {
    store.saveConfig({ uploadToken: crypto.randomBytes(16).toString('hex') });
  }
  return store.config.uploadToken;
}

function checkUploadToken(req, url) {
  const t = req.headers['x-upload-token'] || url.searchParams.get('token');
  return !!t && t === uploadToken();
}

const UPLOAD_FORMATS = { '.pdf': 'pdf', '.mobi': 'mobi', '.prc': 'mobi', '.azw': 'mobi', '.azw3': 'mobi', '.epub': 'epub', '.txt': 'txt' };

function checkApiToken(req, url) {
  const t = req.headers['x-api-token'] || url.searchParams.get('token');
  return !!t && t === apiToken();
}

/* ---------------- 应用内更新 ---------------- */
// 只有 debug 包指向测试仓库；正式包继续指向生产仓库。
const IS_DEBUG_APP = /(?:^|-)debug(?:$|-)/i.test(APPNAME) || /debug/i.test(APP_VERSION);
const UPDATE_REPO = process.env.TRIM_UPDATE_REPO || (IS_DEBUG_APP ? 'TZYLXS/FnReader-Alpha' : 'TZYLXS/FnReader');
const UPDATE_ASSET_RE = IS_DEBUG_APP ? /legado-web(?:-debug)?[-.].*\.fpk$/i : /legado-web\.fpk$/i;
const UPDATE_CACHE_MS = 10 * 60 * 1000;
let updateCache = { at: 0, data: null };

function semverParts(v) {
  return String(v || '0')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

function semverGt(a, b) {
  const x = semverParts(a);
  const y = semverParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const xa = x[i] || 0;
    const yb = y[i] || 0;
    if (xa !== yb) return xa > yb;
  }
  return false;
}

/**
 * 旧版 App 上传缓存/加书时可能不带 origin，服务端以前只补 originName「手机缓存」，
 * 客户端同步过去就变成打不开的无源书。这里按 bookUrl 主机找回启用书源：
 * 先精确匹配 host，再按站点主域匹配（3yt.info → 3yt.com / 3yt.la）。
 */
function resolveSourceForBookUrl(bookUrl) {
  let host = '';
  try {
    host = new URL(String(bookUrl || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host) return null;
  const sources = (store.sources || []).filter((s) => s && s.bookSourceUrl && s.enabled !== false);
  const hostOf = (u) => {
    try {
      return new URL(String(u || '')).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const siteKey = (h) => {
    const parts = String(h || '').split('.');
    if (parts.length < 2) return '';
    const key = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    return key.length >= 3 ? key : '';
  };
  const exact = sources.find((s) => hostOf(s.bookSourceUrl) === host);
  if (exact) return exact;
  const key = siteKey(host);
  if (!key) return null;
  return sources
    .filter((s) => siteKey(hostOf(s.bookSourceUrl)) === key)
    .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0) || Number(a.customOrder || 0) - Number(b.customOrder || 0))[0] || null;
}

/** 已缓存书籍清单：书名 + 来源 + 章节数（供 App 同步书架） */
function buildLibraryManifest() {
  const list = readJSON(DOWNLOAD_INDEX, []);
  const books = list
    .filter((e) => e.file && fs.existsSync(e.file))
    .map((e) => ({
      name: e.name,
      origin: e.author ? `${e.author}` : '',
      source: e.source || '',
      chapters: e.chapters || 0,
      failed: e.failed || 0,
      size: e.size || 0,
      bookUrl: e.bookUrl,
      path: '/dav/books/' + encodeURIComponent(e.name + '.txt'),
    }));
  const data = {
    generatedAt: new Date().toISOString(),
    count: books.length,
    books,
  };
  try {
    fs.writeFileSync(path.join(store.dataDir, 'library.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  return data;
}

// 国内网络直连 GitHub 下载会被拦，按顺序回退到镜像
const UPDATE_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/'];

async function downloadUpdateAsset(url) {
  try {
    if (url && (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) && fs.existsSync(url)) {
      const buf = fs.readFileSync(url);
      if (buf.length > 10000) return { buf, from: url };
    }
  } catch { /* 继续按 URL 处理 */ }
  const candidates = [url, ...UPDATE_MIRRORS.map((m) => m + url)];
  let lastError = null;
  for (const target of candidates) {
    try {
      const r = await fetch(target, {
        headers: { 'User-Agent': 'FnReader' },
        redirect: 'follow',
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 10000) throw new Error('返回内容过小（' + buf.length + ' 字节）');
      return { buf, from: target };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('所有下载通道都失败');
}

// debug 版更新源：本地文件 <下载目录>/update/latest.json（Alpha 仓库已归档，不再读它的 Release）
function localUpdateFile() {
  if (process.env.FNREADER_UPDATE_FILE) return process.env.FNREADER_UPDATE_FILE;
  return path.join(store.config.downloadDir || store.dataDir, 'update', 'latest.json');
}
async function fetchLocalRelease() {
  const file = localUpdateFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error('本地更新源不存在：' + file);
  }
  const j = JSON.parse(raw);
  const version = String(j.version || '').replace(/^v/i, '');
  if (!version) throw new Error('latest.json 缺少 version 字段');
  const fpk = String(j.fpk || j.fpkUrl || '');
  return {
    tag: 'v' + version,
    version,
    name: j.name || 'V' + version,
    body: j.notes || j.body || '',
    publishedAt: j.releasedAt || j.publishedAt || '',
    htmlUrl: j.url || '',
    asset: fpk ? { name: path.basename(fpk), size: Number(j.size) || 0, url: fpk } : null,
    source: 'local',
    localFile: file,
  };
}

async function fetchLatestRelease(force) {
  if (!force && updateCache.data && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.data;
  if (IS_DEBUG_APP) {
    const data = await fetchLocalRelease();
    updateCache = { at: Date.now(), data };
    return data;
  }
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'FnReader', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => /\.fpk$/i.test(a.name)) || null;
  const data = {
    tag: rel.tag_name,
    version: String(rel.tag_name || '').replace(/^v/i, '').replace(/^(?:debug|alpha|beta|test)[-_]/i, ''),
    name: rel.name || rel.tag_name,
    body: rel.body || '',
    publishedAt: rel.published_at,
    htmlUrl: rel.html_url,
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
  };
  updateCache = { at: Date.now(), data };
  return data;
}

function mobileBook(b) {
  return {
    bookUrl: b.bookUrl,
    name: b.name,
    author: b.author || '',
    coverUrl: b.coverUrl || '',
    intro: b.intro || '',
    kind: b.kind || '',
    origin: b.origin,
    originName: b.originName || '',
    lastChapter: b.lastChapter || '',
    durChapterIndex: b.durChapterIndex || 0,
    durChapterPos: b.durChapterPos || 0,
    durChapterTitle: b.durChapterTitle || '',
    durChapterTime: b.durChapterTime || 0,
    totalChapterNum: b.totalChapterNum || (b.chapters ? b.chapters.length : 0),
  };
}

async function mobileSearch(key, group, limit) {
  // 优先用体检通过的源，但一个都没有时退化为全部启用源（否则换源永远搜不到东西）
  let sources = store.sources.filter((s) => s.enabled);
  if (group) sources = sources.filter((s) => (s.bookSourceGroup || '') === group);
  sources = sources.sort((a, b) => Number(b.checkStatus === 'ok') - Number(a.checkStatus === 'ok'));
  sources = sources.slice(0, Math.max(1, Math.min(30, Number(limit) || 8)));
  const buckets = await Promise.all(
    sources.map((s) =>
      Promise.race([
        searchSource(s, key, 1, { timeout: 8000 }).catch(() => []),
        new Promise((r) => setTimeout(() => r([]), 9000)),
      ])
    )
  );
  const seen = new Set();
  const out = [];
  for (const list of buckets) {
    for (const b of list) {
      const k = b.bookUrl;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(mobileBook({ ...b, chapters: [] }));
    }
  }
  return out;
}

/** 书架去重：同名同作者只留一条（章数多的优先），其余来源记进 altOrigins */
async function dedupeShelf() {
  // 去重交给 Python 引擎（1.0.1 起），失败再回退 JS 实现
  let r = null;
  if (pythonAuxEnabled()) {
    try {
      const py = await pyengine.call('dedupe', { books: store.books }, 60000);
      if (py && Array.isArray(py.books)) {
        r = { list: py.books, removed: Number(py.removed) || 0, via: 'python' };
      }
    } catch {
      /* 回退 JS */
    }
  }
  if (!r) {
    const jsr = dedupeBooks(store.books);
    r = { list: jsr.list, removed: jsr.removed, via: 'js' };
  }
  if (r.removed > 0) {
    store.saveBooks(r.list);
    events.broadcast({ type: 'shelf', action: 'dedupe', removed: r.removed, via: r.via });
    console.log('[legado-web] 书架去重（' + r.via + '）：合并 ' + r.removed + ' 条');
  }
  return r;
  return r;
}

let tombstoneReady = false;
function ensureTombstone() {
  if (tombstoneReady) return;
  tombstone.init(store.dataDir);
  tombstoneReady = true;
}
/** 让手机端补全书籍详情（简介/封面/字数等），失败返回 null */
async function remoteBookInfo(bookUrl, source, timeout = 10000) {
  if (!busAvailable()) return null;
  const book = bookUrl ? store.findBook(bookUrl) : null;
  const r = await remote.request(
    'bookinfo',
    {
      bookUrl,
      source: source || (book && book.origin) || '',
      name: (book && book.name) || '',
      author: (book && book.author) || '',
    },
    timeout
  ).catch(() => null);
  if (!r || !r.ok || !r.data) return null;
  const d = r.data;
  return {
    intro: String(d.intro || '').trim(),
    coverUrl: String(d.coverUrl || '').trim(),
    author: String(d.author || '').trim(),
    kind: String(d.kind || '').trim(),
    wordCount: String(d.wordCount || '').trim(),
    lastChapter: String(d.lastChapter || '').trim(),
    totalChapterNum: Number(d.totalChapterNum) || 0,
  };
}

/**
 * 拆分任务：封面（cover）与简介（intro）分别下发，交给低分设备处理；
 * 客户端若不支持这两种类型，会回失败，这里再回退到原来的 bookinfo。
 */
async function remoteMedia(bookUrl, source, timeout = 8000) {
  if (!busAvailable()) return null;
  const book = bookUrl ? store.findBook(bookUrl) : null;
  const base = {
    bookUrl,
    source: source || (book && book.origin) || '',
    name: (book && book.name) || '',
    author: (book && book.author) || '',
  };
  const [cover, intro] = await Promise.all([
    remote.request('cover', base, timeout).catch(() => null),
    remote.request('intro', base, timeout).catch(() => null),
  ]);
  const out = {
    coverUrl: '',
    intro: '',
    author: '',
    kind: '',
    wordCount: '',
    lastChapter: '',
    totalChapterNum: 0,
  };
  if (cover && cover.ok && cover.data) {
    out.coverUrl = String(cover.data.coverUrl || cover.data.url || '').trim();
  }
  if (intro && intro.ok && intro.data) {
    out.intro = String(intro.data.intro || '').trim();
    out.author = String(intro.data.author || '').trim();
    out.kind = String(intro.data.kind || '').trim();
    out.wordCount = String(intro.data.wordCount || '').trim();
    out.lastChapter = String(intro.data.lastChapter || '').trim();
    out.totalChapterNum = Number(intro.data.totalChapterNum) || 0;
  }
  if (!out.coverUrl && !out.intro) return null;
  return out;
}

/** 把手机补全的信息写回书架 */
function applyRemoteBookInfo(book, info) {
  if (!book || !info) return;
  if (info.intro) book.intro = info.intro;
  if (info.coverUrl && !book.coverUrl) book.coverUrl = info.coverUrl;
  if (info.author && !book.author) book.author = info.author;
  if (info.kind && !book.kind) book.kind = info.kind;
  if (info.wordCount && !book.wordCount) book.wordCount = info.wordCount;
  if (info.lastChapter && !book.lastChapter) book.lastChapter = info.lastChapter;
  if (info.totalChapterNum && !book.totalChapterNum) book.totalChapterNum = info.totalChapterNum;
  store.upsertBook(book);
}

/** 手机解析来的书：预热目录 + 前几章正文并落盘 */
async function prefetchPhoneBook(book, chapterCount = 3) {
  if (!book || !book.viaPhone) return;
  if (!busAvailable()) return;
  const chapters = book.chapters && book.chapters.length ? book.chapters : await handleRefreshToc(book).catch(() => []);
  const n = Math.min(chapterCount, (chapters || []).length);
  for (let i = 0; i < n; i++) {
    if (readPhoneCache(book.bookUrl, i, 'content')) continue;
    const ps = await remoteContent(book, chapters[i]).catch(() => null);
    if (ps && ps.length) {
      writePhoneCache(book.bookUrl, i, 'content', { paragraphs: ps, title: chapters[i].title, at: Date.now() });
    }
  }
}

/** 让手机端解析目录（返回 chapters） */
async function remoteToc(book) {
  const r = await remote.request(
    'toc',
    { source: book.origin || '', bookUrl: book.bookUrl, name: book.name },
    20000
  );
  if (!r.ok || !r.data || !Array.isArray(r.data.chapters)) return null;
  const chapters = r.data.chapters.map((c, i) => ({
    index: i,
    title: String(c.title || `第${i + 1}章`),
    url: String(c.url || ''),
  }));
  if (r.data.normalized === true) return chapters;
  return normalizeTocOffload(chapters);
}

/** 让手机端解析正文（返回段落） */
async function remoteContent(book, chapter) {
  const r = await remote.request(
    'content',
    { source: book.origin || '', chapterUrl: chapter.url, title: chapter.title, bookUrl: book.bookUrl },
    25000
  );
  if (!r.ok || !r.data) return null;
  const paras = r.data.paragraphs || r.data.content;
  if (Array.isArray(paras)) return paras.map(String);
  if (typeof paras === 'string') return paras.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  return null;
}

/** 目录看起来是不是只抓到了第一页（章数远少于 lastChapter 里的编号） */
function tocLooksIncomplete(book, list) {
  const n = Array.isArray(list) ? list.length : 0;
  if (!n) return true;
  if (n < 10) return true;
  const hint = String((book && (book.lastChapter || book.lastChapterTitle)) || '');
  const m = hint.match(/(\d{2,5})/);
  if (!m) return false;
  const expect = Number(m[1]);
  if (!expect || expect < 20) return false;
  return n < Math.floor(expect * 0.6);
}

async function refreshToc(book) {
  // 客户端可能把 `,{'webView': true}` 这类配置拼进 tocUrl（还可能被 URL 编码），先剥掉再解析
  const cleanBookUrl = (u) => {
    let s = String(u || '').trim();
    if (/^https?%3A/i.test(s) || /%7B/i.test(s)) {
      try {
        s = decodeURIComponent(s);
      } catch {
        /* 保持原样 */
      }
    }
    return s.replace(/,\s*\{[\s\S]*?\}\s*$/, '').trim();
  };
  if (book.tocUrl) book.tocUrl = cleanBookUrl(book.tocUrl);
  if (book.bookUrl) book.bookUrl = cleanBookUrl(book.bookUrl);
  // 目录优先走软总线：只要有手机在线就先让它解析（手机能过反爬/登录态），
  // 拿不到（无设备、源不在手机上、超时）再回落到本机解析
  let phoneChapters = null;
  if (book.viaPhone || busAvailable()) {
    const cachedToc = readPhoneCache(book.bookUrl, 0, 'toc');
    if (cachedToc && Array.isArray(cachedToc.chapters) && cachedToc.chapters.length) {
      book.chapters = cachedToc.chapters;
      book.totalChapterNum = cachedToc.chapters.length;
      book.tocVia = 'phone-cache';
      store.upsertBook(book);
      if (!tocLooksIncomplete(book, cachedToc.chapters)) return book.chapters;
      phoneChapters = cachedToc.chapters;
    }
    if (!phoneChapters) {
      const chapters = await remoteToc(book).catch(() => null);
      if (chapters && chapters.length) {
        phoneChapters = chapters;
        book.chapters = chapters;
        book.totalChapterNum = chapters.length;
        book.tocVia = 'phone';
        bumpUsage('phoneToc');
        store.upsertBook(book);
        writePhoneCache(book.bookUrl, 0, 'toc', { chapters, at: Date.now() });
        if (!tocLooksIncomplete(book, chapters)) return chapters;
      }
    }
  }
  const source = resolveSource(book);
  if (!source) {
    if (book.cachedDir) return book.chapters || [];
    throw new Error('未找到书源，可能已被删除');
  }
  book.tocVia = 'local';

  // 同一站点可能挂着多个书源（例如“通用书源”和站点专用源）。
  // 专用源规则坏了就按候选顺序换下一个，不要一本书失败就整本 502。
  const candidates = resolveSourceCandidates(book, source);
  let lastErr = null;

  if (effectiveEngine() === 'python') {
    try {
      const r = await pyengine.call('toc', { source, tocUrl: book.tocUrl || book.bookUrl, bookUrl: book.bookUrl });
      if (r && Array.isArray(r.chapters) && r.chapters.length) {
        const raw = r.chapters.map((c, i) => ({
          index: i,
          title: String(c.title || c.name || `第${i + 1}章`),
          url: String(c.url || c.chapterUrl || ''),
        }));
        const list = r.normalized === 'python'
          ? raw.map((c, i) => ({ ...c, index: i }))
          : await normalizeTocOffload(raw);
        book.chapters = list;
        book.totalChapterNum = list.length;
        store.upsertBook(book);
        return list;
      }
    } catch {
      /* 回退到内置解析 */
    }
  }

  for (const cand of candidates) {
    try {
      // tocUrl 与 bookUrl 相同，说明客户端只存了详情页地址；重新跑一次详情规则拿真正的目录页
      if (!book.tocUrl || book.tocUrl === book.bookUrl) await getBookInfo(cand, book);
      book.tocUrl = cleanBookUrl(book.tocUrl);
      let chapters = await getToc(cand, book);
      if (!chapters || !chapters.length) {
        lastErr = new Error('目录为空，可能书源规则不匹配或站点改版');
        continue;
      }
      // 本机目录页可能只抓到第一页；手机端目录更全时用手机的
      if (tocLooksIncomplete(book, chapters) && phoneChapters && phoneChapters.length > chapters.length) {
        chapters = phoneChapters;
        book.tocVia = 'phone';
      } else if (tocLooksIncomplete(book, chapters) && busAvailable()) {
        const remote = await remoteToc(book).catch(() => null);
        if (remote && remote.length > chapters.length) {
          chapters = remote;
          book.tocVia = 'phone';
          writePhoneCache(book.bookUrl, 0, 'toc', { chapters, at: Date.now() });
        }
      }
      book.chapters = chapters;
      book.totalChapterNum = chapters.length;
      book.origin = cand.bookSourceUrl || book.origin;
      book.originName = cand.bookSourceName || book.originName;
      store.upsertBook(book);
      prefetchChapter(book, book.durChapterIndex || 0);
      if (!book.durChapterIndex) prefetchChapter(book, 1);
      return chapters;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('目录为空，可能书源规则不匹配或站点改版');
}

// 同一本书的并发目录刷新只执行一次，调用方共享结果，避免重复占用软总线 TOC 槽位。
const tocInflight = new Map();
async function handleRefreshToc(book) {
  const key = String((book && book.bookUrl) || '');
  if (!key) return refreshToc(book);
  const existing = tocInflight.get(key);
  if (existing) return existing;
  const promise = refreshToc(book).finally(() => {
    if (tocInflight.get(key) === promise) tocInflight.delete(key);
  });
  tocInflight.set(key, promise);
  return promise;
}

// ---------- 「阅读」APK 接入：把飞牛书库包装成 Legado 书源 ----------
// 思路：APK 侧不改代码，由服务端生成一份 Legado 书源（bookSource），
// 书源把 搜索/详情/目录/正文 四个动作映射到 /api/m/legado/*，正文复用 /api/m/content。

function b64u(s) {
  return Buffer.from(String(s || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function unb64u(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t, 'base64').toString('utf8');
}

/** 外部可访问的基地址（网关前缀 + host） */
function externalBase(req, prefix) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${proto}://${host}${prefix || ''}`;
}

/** 本机局域网 IPv4（跳过 docker / 虚拟网卡） */
/** 请求是否来自本机（fnOS 网关走 app.sock/loopback，直连 :1122 的局域网设备不算） */
function isLocalRequest(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  if (!addr) return true; // unix socket
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function lanIp() {
  const skip = /^(docker|br-|veth|virbr|lo|tun|tap|zt|tailscale)/i;
  const cands = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      if (skip.test(name)) continue;
      cands.push(n.address);
    }
  }
  return cands[0] || '127.0.0.1';
}

/**
 * App / 书源要用的直连地址。
 * 走 fnOS 网关（:5666）时 req.host 是网关端口，手机 App 连不了那儿，
 * 所以固定用「服务端口 + 局域网 IP」。
 */
function allLanIpv6() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv6' || n.internal) continue;
      const ip = String(n.address || '').split('%')[0];
      // 只展示公网段（2xxx/3xxx），跳过 ULA(fd..) 与 link-local(fe80..)
      if (!/^[23]/.test(ip)) continue;
      if (!out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

function allLanIps() {
  const out = [];
  const push = (ip) => {
    if (!ip || ip === '127.0.0.1' || out.includes(ip)) return;
    out.push(ip);
  };
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      push(n.address);
    }
  }
  // 常见私有网段优先展示（192.168 > 10. > 172.16-31）
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  out.sort((a, b) => score(a) - score(b));
  return out.length ? out : ['127.0.0.1'];
}

/** 找一本对应的书源：origin → URL 主机 → 源名 */
/** 同一站点的可用书源候选，供目录解析失败时逐个重试 */
function resolveSourceCandidates(book, primary) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (!s || !s.bookSourceUrl || s.enabled === false) return;
    const key = String(s.bookSourceUrl);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  push(primary);
  let host = '';
  try {
    host = new URL(String(book.bookUrl || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    host = '';
  }
  const hostOf = (u) => {
    try {
      return new URL(String(u || '')).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  if (host) {
    const exact = (store.sources || [])
      .filter((s) => s && s.enabled !== false && hostOf(s.bookSourceUrl) === host)
      .sort((a, b) => {
        const an = String(a.bookSourceName || '') === String(book.originName || '') ? 1 : 0;
        const bn = String(b.bookSourceName || '') === String(book.originName || '') ? 1 : 0;
        return bn - an || Number(b.weight || 0) - Number(a.weight || 0) || Number(a.customOrder || 0) - Number(b.customOrder || 0);
      });
    exact.forEach(push);
  }
  push(resolveSourceForBookUrl(book.bookUrl));
  return out;
}

function resolveSource(book) {
  if (!book) return null;
  if (book.origin) {
    const hit = store.findSource(book.origin);
    if (hit) return hit;
  }
  let host = '';
  try {
    host = new URL(book.bookUrl).host;
  } catch {
    host = '';
  }
  if (host) {
    const cands = store.sources.filter((s) => {
      try {
        return new URL(s.bookSourceUrl).host === host;
      } catch {
        return false;
      }
    });
    const pick = cands.find((s) => s.enabled !== false) || cands[0];
    if (pick) {
      book.origin = pick.bookSourceUrl;
      book.originName = pick.bookSourceName || book.originName;
      store.upsertBook(book);
      return pick;
    }
  }
  // 精确主机没命中时按主域回退（3yt.info → 3yt.com / 3yt.la），
  // 兼容旧客户端上传的空 origin 书籍，避免服务端一直报「未找到书源」。
  const inferred = resolveSourceForBookUrl(book.bookUrl);
  if (inferred && inferred.bookSourceUrl) {
    book.origin = inferred.bookSourceUrl;
    book.originName = inferred.bookSourceName || book.originName || '';
    store.upsertBook(book);
    return inferred;
  }
  if (book.originName) {
    const hit = store.sources.find((s) => s.bookSourceName === book.originName);
    if (hit) {
      book.origin = hit.bookSourceUrl;
      store.upsertBook(book);
      return hit;
    }
  }
  return null;
}

/** 书名归一化：去空白与书名号，用于「本地电子书 ⇄ 客户端同步」匹配 */
function normBookName(s) {
  return String(s || '')
    .replace(/[《》「」【】\[\]()（）]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 扫描到本地电子书后，给书架上同名的书挂一个「本地副本」：
 * - 不改 bookUrl、不删 cachedDir、不动 .nb 缓存
 * - 只记录 localEbook={sha1,format} 与 contentSource（默认 local）
 * - 阅读页可在「本地TXT / 网文源」之间切换
 */
/**
 * 缺章时向在线设备要这一章：建 ebook-chapter 任务，等客户端回传 paragraphs。
 * 返回 { ok, paragraphs } ；失败/超时返回 { ok:false }
 */
async function requestChapterFromDevice(sha1, index, waitMs = 20000) {
  const entry = ebookStore.getEntry(store.dataDir, sha1);
  if (!entry) return { ok: false, error: 'no-entry' };
  const devices = remote.listDevices().filter((d) => d.online && d.enabled !== false);
  if (!devices.length) return { ok: false, error: 'no-device' };
  const payload = {
    schema: 'fnreader.ebook.v1',
    sha1,
    index,
    name: entry.name,
    format: entry.format,
    fileUrl: `/api/m/ebook/file/${sha1}`,
    token: apiToken(),
  };
  const r = await remote.request('ebook-chapter', payload, waitMs).catch(() => ({ ok: false, error: 'timeout' }));
  if (!r.ok || !r.data) return { ok: false, error: r.error || 'failed' };
  const paragraphs = Array.isArray(r.data.paragraphs) ? r.data.paragraphs : [];
  const title = String(r.data.title || '');
  if (!paragraphs.length) return { ok: false, error: 'empty' };
  try {
    const book = ebookStore.readBook(store.dataDir, sha1);
    const tocTitle = (book && book.toc && book.toc[index] && book.toc[index].title) || title || `第 ${index + 1} 章`;
    ebookStore.writeChapter(store.dataDir, sha1, {
      schema: 'fnreader.ebook.v1',
      sha1,
      index,
      id: (book && book.toc && book.toc[index] && book.toc[index].id) || `ch${String(index + 1).padStart(4, '0')}`,
      title: tocTitle,
      paragraphs: paragraphs.map((p) => ({ k: String((p && p.k) || 'p').slice(0, 8), t: String((p && p.t) || '') })),
    });
  } catch {
    /* 落盘失败也不影响本次返回 */
  }
  return { ok: true, paragraphs, title };
}

/** 删除一本本地电子书：登记表 + 解析产物 + 原文件副本（可选原文件） + 书架引用 */
function deleteEbookEntry(sha1, opts = {}) {
  const entry = ebookStore.getEntry(store.dataDir, sha1);
  if (!entry) return { ok: false, code: 404, error: '没有这本书' };

  try {
    ebookStore.removeEntry(store.dataDir, sha1);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(ebookStore.bookDir(store.dataDir, sha1), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (entry.file) {
    try {
      fs.rmSync(entry.file, { force: true });
    } catch {
      /* ignore */
    }
  }
  if (opts.file && entry.sourcePath) {
    try {
      fs.rmSync(entry.sourcePath, { force: true });
    } catch {
      /* ignore */
    }
  }

  // 书架联动：删掉 ebook:// 条目，把挂了本地副本的网文书改回网文源
  const books = store.books;
  const before = books.length;
  const kept = [];
  let reverted = 0;
  for (const b of books) {
    if (b.bookUrl === 'ebook://' + sha1) continue;
    if (b.localEbook && b.localEbook.sha1 === sha1) {
      delete b.localEbook;
      if (b.ebookFormat) delete b.ebookFormat;
      b.contentSource = 'source';
      reverted++;
    }
    kept.push(b);
  }
  const removedShelf = before - kept.length;
  if (removedShelf || reverted) {
    store.saveBooks(kept);
    events.broadcast({ type: 'shelf', action: 'ebook-deleted', sha1, removedShelf, reverted });
  }
  return { ok: true, sha1, name: entry.name, removedShelf, reverted, deletedSource: !!(opts.file && entry.sourcePath) };
}

function linkLocalEbooksToShelf() {
  let entries = [];
  try {
    entries = ebookStore.loadIndex(store.dataDir);
  } catch {
    return 0;
  }
  const usable = entries.filter((e) => e.status === 'complete' || e.status === 'partial' || e.status === 'toc-only');
  if (!usable.length) return 0;

  const books = store.books;
  let changed = 0;
  for (const e of usable) {
    const key = normBookName(e.name);
    if (!key) continue;
    for (const b of books) {
      if (String(b.bookUrl).startsWith('ebook://')) continue;
      if (normBookName(b.name) !== key) continue;
      const cur = b.localEbook || {};
      if (cur.sha1 === e.sha1) continue;
      b.localEbook = { sha1: e.sha1, format: e.format, name: e.name, status: e.status };
      b.ebookFormat = e.format;
      b.contentSource = 'local';
      changed++;
    }
  }

  // 回填老的 ebook:// 条目的 ebookFormat
  const fmtByeSha = new Map(usable.map((e) => ['ebook://' + e.sha1, e.format]));
  for (const b of books) {
    if (!b.ebookFormat && fmtByeSha.has(b.bookUrl)) {
      b.ebookFormat = fmtByeSha.get(b.bookUrl);
      changed++;
    }
  }

  // 扫描到、但书架里还没有的电子书：直接作为新条目加入书架
  const shelfUrls = new Set(books.map((b) => b.bookUrl));
  for (const e of usable) {
    const ebookUrl = 'ebook://' + e.sha1;
    if (shelfUrls.has(ebookUrl)) continue;
    const matched = books.some((b) => normBookName(b.name) === normBookName(e.name));
    if (matched) continue;
    const toc = ebookRender.toc(store.dataDir, e.sha1) || { chapters: [] };
    const chapters = toc.chapters || [];
    const meta = (toc && toc.meta) || {};
    books.push({
      name: e.name,
      author: meta.author || '',
      bookUrl: ebookUrl,
      tocUrl: ebookUrl,
      origin: 'local-ebook',
      originName: '本地电子书',
      coverUrl: '',
      intro: meta.description || '',
      chapters,
      totalChapterNum: chapters.length,
      durChapterIndex: 0,
      durChapterTitle: chapters[0] ? chapters[0].title : '',
      lastChapter: chapters.length ? chapters[chapters.length - 1].title : '',
      tocVia: 'ebook',
      ebookFormat: e.format,
      contentSource: 'local',
      cachedDir: '',
      addedAt: Date.now(),
    });
    shelfUrls.add(ebookUrl);
    changed++;
  }

  if (changed) {
    store.saveBooks(books);
    events.broadcast({ type: 'shelf', action: 'local-ebook', count: changed });
    console.log(`[legado-web] 本地电子书同步书架：${changed} 项`);
  }
  return changed;
}

/** TXT 用本地 Python 引擎分章后写进 ebook 目录（只做一次），供 /api/toc 与 /api/content 直读 */
async function pythonParseTxtEntry(entry) {
  if (!entry || String(entry.format).toLowerCase() !== 'txt') return false;
  if (entry.parsedBy === 'python' && entry.status === 'complete') return true;
  if (entry.status === 'toc-only') return false;
  const cur = (() => {
    try {
      return ebookStore.readBook(store.dataDir, entry.sha1);
    } catch {
      return null;
    }
  })();
  if (cur && cur.tocOnly) return false;
  const file = entry.file || entry.sourcePath;
  if (!file || !fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const r = await pyengine.call('txt', { name: entry.name, text }, 120000);
  const chapters = r.chapters || [];
  if (!chapters.length) return false;
  const toc = chapters.map((c, i) => ({ id: 'ch' + String(i + 1).padStart(4, '0'), title: c.title, level: 1, index: i }));
  ebookStore.writeBook(store.dataDir, entry.sha1, {
    schema: 'fnreader.ebook.v1',
    sha1: entry.sha1,
    format: 'txt',
    name: entry.name,
    meta: { title: entry.name, author: '', language: 'zh' },
    toc,
    stats: { chapters: toc.length, parts: 1, chars: r.chars || 0 },
    source: 'server',
    status: 'complete',
    parsedBy: 'python',
    updatedAt: Date.now(),
  });
  for (const c of chapters) {
    ebookStore.writeChapter(store.dataDir, entry.sha1, {
      index: c.index,
      id: toc[c.index].id,
      title: c.title,
      paragraphs: (c.paragraphs || []).map((t) => ({ k: 'p', t })),
    });
  }
  ebookStore.upsertEntry(store.dataDir, {
    sha1: entry.sha1,
    status: 'complete',
    source: 'server',
    parsedBy: 'python',
    chapters: toc.length,
  });
  return true;
}

function normBookName(s) {
  return String(s || '')
    .replace(/[《》「」【】\[\]()（）]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function localEbookByName(name) {
  const target = normBookName(name);
  if (!target) return null;
  let list = [];
  try {
    list = ebookStore.loadIndex(store.dataDir);
  } catch {
    return null;
  }
  const exact = list.find((e) => normBookName(e.name) === target);
  if (exact) return exact;
  return (
    list.find((e) => {
      const n = normBookName(e.name);
      return n && (n.includes(target) || target.includes(n)) && Math.min(n.length, target.length) >= 2;
    }) || null
  );
}

/** 手机任务并发闸门 + 熔断：App 按队列处理，连续超时就暂停代理解析 */
let phoneSlots = 4;
let phoneFails = 0;
let phoneBlockedUntil = 0;
const phoneWaiting = [];

function acquirePhoneSlot() {
  return new Promise((resolve) => {
    if (phoneSlots > 0) {
      phoneSlots--;
      resolve();
    } else {
      phoneWaiting.push(resolve);
    }
  });
}

function releasePhoneSlot() {
  const next = phoneWaiting.shift();
  if (next) next();
  else phoneSlots++;
}

/** 通过软总线搜一个源（带排队 + 熔断） */
async function phoneSearch(source, key, waitMs = 20000) {
  if (Date.now() < phoneBlockedUntil) return { ok: false, error: 'bus-cooling' };
  await acquirePhoneSlot();
  try {
    // 客户端契约：source 传书源 URL 字符串
    const sourceUrl = typeof source === 'string' ? source : String((source && (source.bookSourceUrl || source.url)) || '');
    const r = await remote.request('search', { source: sourceUrl, key }, waitMs);
    if (r.ok) {
      phoneFails = 0;
    } else if (String(r.error || '').includes('timeout')) {
      phoneFails++;
      if (phoneFails >= 3) {
        phoneBlockedUntil = Date.now() + 120000;
        phoneFails = 0;
        console.log('[legado-web] 软总线连续超时，暂停代理解析 2 分钟');
      }
    }
    return r;
  } finally {
    releasePhoneSlot();
  }
}

/**
 * 正版接口源（起点 / QQ阅读 / 掌阅 / 番茄 / 七猫 / 百度小说…）：
 * 默认不参与搜索（容易被风控、也多是付费源），用户显式指定时才搜。
 */
function isOfficialSource(src) {
  const text = String((src && src.bookSourceName) || '') + ' ' + String((src && src.bookSourceUrl) || '') + ' ' + String((src && src.bookSourceGroup) || '');
  return /起点|qidian|QQ\s*阅读|ubook\.reader\.qq|bookshelf\.html5\.qq|novel\.html5\.qq|掌阅|zhangyue|ireader|番茄|fanqie|fqnovel|七猫|wtzw|百度小说|novelapi\.baidu|17K|正版|官方接口/i.test(text);
}

/** 明显不是小说源的（词典/知道/翻译），搜索时跳过 */
function isJunkSource(src) {
  const text = String((src && src.bookSourceName) || '') + ' ' + String((src && src.bookSourceUrl) || '');
  return /词典|知道|翻译|单词|dict\.cn|zhidao\.baidu/i.test(text);
}

// 软总线使用统计（便于观察利用率）
const busUsage = { phoneSearch: 0, phoneToc: 0, phoneContent: 0, localToc: 0, localContent: 0 };
function bumpUsage(k) {
  if (Object.prototype.hasOwnProperty.call(busUsage, k)) {
    busUsage[k]++;
    if (busUsage[k] > 1e9) busUsage[k] = 1;
  }
}

/** 是否有在线的解析设备（软总线） */
function busAvailable() {
  return remote.listDevices().some((d) => d.online && d.enabled);
}

function directBase() {
  const port = process.env.TRIM_SERVICE_PORT || process.env.PORT || 1122;
  return `http://${lanIp()}:${port}`;
}

/** 生成 Legado 书源对象（可直接被「阅读」导入） */
function buildLegadoBookSource(base, token) {
  const api = `${base}/api/m`;
  return {
    bookSourceName: '飞牛书库',
    bookSourceUrl: `${api}/legado`,
    bookSourceGroup: '飞牛',
    bookSourceType: 0,
    bookSourceComment: '由 FnReader 自动生成：把飞牛书架/书源/缓存包装成阅读书源',
    enabled: true,
    enabledCookieJar: false,
    enabledExplore: false,
    header: '',
    searchUrl: `${api}/legado/search?token=${token}&key={{key}}&page={{page}}`,
    ruleSearch: {
      checkKeyWord: '',
      bookList: '$.books[*]',
      name: '$.name',
      author: '$.author',
      bookUrl: '$.bookUrl',
      coverUrl: '$.coverUrl',
      kind: '$.kind',
      introduce: '$.intro',
      lastChapter: '$.lastChapter',
    },
    ruleBookInfo: {
      init: '',
      name: '$.book.name',
      author: '$.book.author',
      coverUrl: '$.book.coverUrl',
      kind: '$.book.kind',
      introduce: '$.book.intro',
      lastChapter: '$.book.lastChapter',
      tocUrl: '$.book.tocUrl',
    },
    ruleToc: {
      chapterList: '$.chapters[*]',
      chapterName: '$.title',
      chapterUrl: '$.url',
    },
    ruleContent: {
      content: '$.paragraphs[*]',
    },
    weight: 1,
    customOrder: 100,
  };
}

async function route(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method.toUpperCase();
  // 记录网关挂载前缀，生成返回给「阅读」APK 的绝对地址时要用
  const MOUNT_PREFIX = pathname.startsWith(`/app/${APPNAME}`) ? `/app/${APPNAME}` : '';

  // 网关会带 /app/<name> 前缀，统一去掉
  let p = pathname.replace(/\/{2,}/g, '/');
  // 没有结尾斜杠时补一个，保证页面里的相对路径（./api、./style.css）解析正确
  if (p === `/app/${APPNAME}`) {
    res.writeHead(302, { Location: `/app/${APPNAME}/${searchParams.toString() ? '?' + searchParams.toString() : ''}` });
    return res.end();
  }
  if (p === `/app/${APPNAME}` || p.startsWith(`/app/${APPNAME}/`)) {
    p = p.slice(`/app/${APPNAME}`.length) || '/';
  }
  p = p.replace(/\/+$/, '') || '/';

  if (p === '/dav' || p.startsWith('/dav/')) {
    return handleDav(
      { apiToken, readJSON, DOWNLOAD_INDEX, dataDir: store.dataDir, manifest: buildLibraryManifest },
      req,
      res,
      url,
      p,
      method
    );
  }

  if (p === '/api/health')
    return json(res, 200, { ok: true, app: APPNAME, version: APP_VERSION, build: BUILD_ID, runtime: { node: process.version, v8: process.versions.v8, compileCache: require('node:module').getCompileCacheDir?.() || '' }, parse: parsePool.stats(), python: pyengine.poolStats(), java: javaWorker.status() });

  if (p === '/api/m/info') {
    if (!checkApiToken(req, url)) return json(res, 401, { error: 'token 无效' });
    return json(res, 200, {
      app: '阅读',
      version: APP_VERSION,
      tokenRequired: true,
      endpoints: [
        '/api/m/shelf',
        '/api/m/search',
        '/api/m/toc',
        '/api/m/content',
        '/api/m/progress',
        '/api/m/cover',
        '/api/m/booksource',
        '/api/m/legado/search',
        '/api/m/legado/book',
        '/api/m/legado/toc',
      ],
    });
  }

  if (p === '/api/update/check' && method === 'GET') {
    try {
      const rel = await fetchLatestRelease(searchParams.get('force') === '1');
      return json(res, 200, {
        current: APP_VERSION,
        latest: rel.version,
        hasUpdate: IS_DEBUG_APP
          ? !!(rel.asset && (semverGt(rel.version, APP_VERSION) || rel.version === APP_VERSION))
          : semverGt(rel.version, APP_VERSION),
        name: rel.name,
        notes: rel.body,
        publishedAt: rel.publishedAt,
        htmlUrl: rel.htmlUrl,
        asset: rel.asset,
        source: rel.source || 'github',
        updateFile: rel.localFile || '',
      });
    } catch (e) {
      return json(res, 502, { error: '检查更新失败：' + (e.message || e) });
    }
  }

  if (p === '/api/update/download' && method === 'POST') {
    try {
      const rel = await fetchLatestRelease(true);
      if (!rel.asset) return json(res, 404, { error: '最新版本没有附带 fpk 文件' });
      if (!IS_DEBUG_APP && !semverGt(rel.version, APP_VERSION)) {
        return json(res, 200, { ok: true, upToDate: true, current: APP_VERSION, latest: rel.version });
      }
      const dir = path.join(store.dataDir, 'updates');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `legado-web-${rel.version}.fpk`);
      let downloaded;
      try {
        downloaded = await downloadUpdateAsset(rel.asset.url);
      } catch (e) {
        throw new Error('下载失败：' + (e.message || e));
      }
      const buf = downloaded.buf;
      fs.writeFileSync(file, buf, { mode: 0o644 });
      try {
        fs.chmodSync(file, 0o644);
      } catch {
        /* ignore */
      }

      // 复制一份到用户授权的下载目录，方便在应用中心手动安装
      let copyPath = '';
      try {
        const target = resolveDownloadDir();
        if (target) {
          // 统一收在「更新包」子目录；子目录建不了就退回根目录，别让用户找不到文件
          let dest;
          try {
            const dir2 = path.join(target, '更新包');
            fs.mkdirSync(dir2, { recursive: true });
            dest = path.join(dir2, `legado-web-${rel.version}.fpk`);
          } catch {
            dest = path.join(target, `legado-web-${rel.version}.fpk`);
          }
          fs.copyFileSync(file, dest);
          try {
            fs.chmodSync(dest, 0o644);
          } catch {
            /* ignore */
          }
          copyPath = dest;
        }
      } catch {
        /* 下载目录不可写时忽略 */
      }

      return json(res, 200, { ok: true, version: rel.version, file, copyPath, size: buf.length });
    } catch (e) {
      return json(res, 502, { error: '下载更新失败：' + (e.message || e) });
    }
  }

  if (p === '/api/update/install' && method === 'POST') {
    const body = await readJson(req);
    const file = body && body.file;
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: '更新包不存在，请先下载' });

    // 是否授予了免密执行 appcenter-cli 的权限（tools/enable-update-permission.sh）
    const CLI = '/usr/local/bin/appcenter-cli';
    let canPrivileged = false;
    try {
      execFileSync('sudo', ['-n', CLI, 'list'], { timeout: 15000, stdio: 'ignore' });
      canPrivileged = true;
    } catch {
      canPrivileged = false;
    }

    if (!canPrivileged) {
      return json(res, 200, {
        ok: false,
        needManual: true,
        file,
        message: '应用没有安装系统应用的权限，请在「应用中心 → 手动安装」选择这个 fpk（或在 NAS 上执行 tools/enable-update-permission.sh 授权后重试）',
      });
    }

    // 有权限：写一个脚本，后台「停止 → 安装 → 启动」，避免应用自己被中断
    const script = '/tmp/legado-update.sh';
    fs.writeFileSync(
      script,
      [
        '#!/bin/sh',
        'sleep 2',
        `sudo -n ${CLI} stop ${APPNAME} >> /tmp/legado-update.log 2>&1`,
        'sleep 3',
        `sudo -n ${CLI} install-fpk "${file}" >> /tmp/legado-update.log 2>&1`,
        'sleep 2',
        `sudo -n ${CLI} start ${APPNAME} >> /tmp/legado-update.log 2>&1`,
        '',
      ].join(String.fromCharCode(10)),
      { mode: 0o755 }
    );
    try {
      require('node:child_process').spawn('sh', [script], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      return json(res, 500, { error: '启动安装脚本失败：' + (e.message || e) });
    }
    return json(res, 200, {
      ok: true,
      restarting: true,
      message: '已开始安装，应用会重启，大约 30 秒后刷新页面',
    });
  }

  // 客户端传书用自己的令牌（X-Upload-Token / ?token=），不走 X-Api-Token
  const isUploadPath = p === '/api/m/ebook/upload';
  if (p.startsWith('/api/m/') && !isUploadPath && !checkApiToken(req, url)) {
    return json(res, 401, { error: 'token 无效，请在「设置 → 手机接入」查看访问令牌' });
  }

  if (p === '/api/m/reset-token' && method === 'POST') {
    if (!checkApiToken(req, url)) return json(res, 401, { error: 'token 无效' });
    const token = crypto.randomBytes(12).toString('hex');
    store.saveConfig({ apiToken: token });
    return json(res, 200, { ok: true, apiToken: token });
  }

  if (p === '/api/m/library' && method === 'GET') {
    return json(res, 200, buildLibraryManifest());
  }

  if (p === '/api/m/shelf' && method === 'GET') {
    const books = [...store.books].sort((a, b) => (b.durChapterTime || 0) - (a.durChapterTime || 0));
    return json(res, 200, { books: books.map(mobileBook) });
  }

  if (p === '/api/m/search' && method === 'GET') {
    const key = String(searchParams.get('key') || '').trim();
    if (!key) return json(res, 400, { error: '缺少 key' });
    try {
      const books = await mobileSearch(key, searchParams.get('group') || '', searchParams.get('limit') || 8);
      return json(res, 200, { key, books });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/m/toc' && method === 'GET') {
    const book = store.findBook(searchParams.get('url'));
    if (!book) return json(res, 404, { error: '书籍不在书架中，请先通过 /api/m/shelf 获取' });
    if (!book.chapters || !book.chapters.length) {
      try {
        await handleRefreshToc(book);
      } catch (e) {
        return json(res, 502, { error: String(e.message || e) });
      }
    }
    return json(res, 200, {
      name: book.name,
      author: book.author || '',
      chapters: book.chapters.map((c, i) => ({ index: i, title: c.title, url: c.url })),
    });
  }

  if (p === '/api/m/content' && method === 'GET') {
    const book = store.findBook(searchParams.get('url'));
    if (!book) return json(res, 404, { error: '书籍不在书架中' });
    const index = Number(searchParams.get('index') || 0);
    if (!book.chapters || !book.chapters.length) {
      try {
        await handleRefreshToc(book);
      } catch (e) {
        return json(res, 502, { error: String(e.message || e) });
      }
    }
    if (!book.chapters[index]) return json(res, 404, { error: '章节不存在' });
    try {
      const result = await loadChapterContent(book, index);
      const chapter = book.chapters[index];
      prefetchChapter(book, index + 1);
      // 客户端同样需要净化（替换/屏蔽规则）
      const cleaned = applyReplaceRules(book, chapter, result.paragraphs);
      return json(res, 200, {
        bookUrl: book.bookUrl,
        title: cleaned.title,
        index,
        total: book.chapters.length,
        prev: index > 0 ? book.chapters[index - 1].title : '',
        next: index + 1 < book.chapters.length ? book.chapters[index + 1].title : '',
        paragraphs: cleaned.paragraphs,
        cached: result.cached,
      });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/m/progress' && method === 'POST') {
    const body = await readJson(req);
    const book = store.findBook(body.bookUrl);
    if (!book) return json(res, 404, { error: '书籍不在书架中' });
    book.durChapterIndex = Number(body.index) || 0;
    book.durChapterPos = Number(body.pos) || 0;
    book.durChapterTitle = body.title || (book.chapters && book.chapters[book.durChapterIndex] ? book.chapters[book.durChapterIndex].title : '');
    book.durChapterTime = Date.now();
    store.upsertBook(book);
    events.broadcast({ type: 'progress', bookUrl: book.bookUrl, index: book.durChapterIndex, title: book.durChapterTitle, via: 'app' });
    return json(res, 200, { ok: true });
  }

  // ---- 本地电子书：扫描 / 列表 / 重新解析 ----
  if (p === '/api/ebook/list' && method === 'GET') {
    const entries = ebookStore.loadIndex(store.dataDir);
    return json(res, 200, { dir: ebookScan.ebookDir(ebookCtx), count: entries.length, books: entries });
  }

  if (p === '/api/ebook/scan' && method === 'POST') {
    // scanOnce 结束时 ctx.afterScan 已经做过书架联动，这里不再重复调用
    const r = await ebookScan.scanOnce(ebookCtx);
    return json(res, 200, r);
  }

  if (p === '/api/ebook/reparse' && method === 'POST') {
    const body = await readJson(req);
    const sha1 = String((body && body.sha1) || '');
    const entry = ebookStore.getEntry(store.dataDir, sha1);
    if (!entry) return json(res, 404, { error: '没有这本书' });
    ebookStore.resetChapters(store.dataDir, sha1);
    ebookStore.upsertEntry(store.dataDir, { sha1, status: 'discovered', source: '', error: '', parts: 0 });
    const reset = ebookStore.getEntry(store.dataDir, sha1) || entry;
    ebookBus.dispatch(ebookCtx, reset);
    return json(res, 200, { ok: true, sha1, status: 'dispatched' });
  }

  // ---- 本地电子书：给 App 下载原文件（支持 Range）----
  if (p.startsWith('/api/m/ebook/file/') && method === 'GET') {
    if (!checkApiToken(req, url)) return json(res, 401, { error: 'token 无效' });
    const sha1 = String(p.slice('/api/m/ebook/file/'.length)).split('/')[0].toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha1)) return json(res, 400, { error: 'sha1 不合法' });
    const entry = ebookStore.getEntry(store.dataDir, sha1);
    if (!entry || !entry.file || !fs.existsSync(entry.file)) return json(res, 404, { error: '文件不存在' });
    const stat = fs.statSync(entry.file);
    const types = { epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook', azw3: 'application/vnd.amazon.ebook', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8' };
    const type = types[String(entry.format || '').toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(String(range));
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : stat.size - 1;
      if (!Number.isFinite(start) || start >= stat.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      const stop = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': stop - start + 1,
        'Content-Range': `bytes ${start}-${stop}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      });
      return fs.createReadStream(entry.file, { start, end: stop }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(entry.file).pipe(res);
  }

  // ---- 本地电子书：App 上传解析分片 ----
  if (p === '/api/m/ebook/part' && method === 'POST') {
    if (!checkApiToken(req, url)) return json(res, 401, { error: 'token 无效' });
    const sha1 = String(searchParams.get('sha1') || '').toLowerCase();
    const seq = Number(searchParams.get('seq') || 0);
    const total = Number(searchParams.get('total') || 0);
    if (!/^[0-9a-f]{40}$/.test(sha1)) return json(res, 400, { error: 'sha1 不合法' });
    const entry = ebookStore.getEntry(store.dataDir, sha1);
    if (!entry) return json(res, 404, { error: '没有这本书' });
    let raw;
    try {
      raw = await readBody(req, 8 * 1024 * 1024);
    } catch (e) {
      return json(res, 413, { error: '分片过大（上限 8MB）' });
    }
    let text = raw;
    if (String(req.headers['content-encoding'] || '').includes('gzip')) {
      try {
        text = zlib.gunzipSync(Buffer.from(raw, 'utf8')).toString('utf8');
      } catch {
        return json(res, 400, { error: 'gzip 解压失败' });
      }
    }
    if (text.length > 20 * 1024 * 1024) return json(res, 413, { error: '解压后超过 20MB' });
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return json(res, 400, { error: '分片不是合法 JSON' });
    }
    let r;
    try {
      r = ebookLocal.acceptPart(store.dataDir, entry, seq, total, payload);
    } catch (e) {
      const code = e && e.code;
      const status = code === 'too-large' ? 413 : code === 'sha1' ? 409 : 400;
      return json(res, status, { error: String((e && e.message) || e), code: code || '' });
    }
    return json(res, 200, { ok: true, ...r });
  }

  // ---- 删除本地电子书：DELETE /api/ebook/delete?sha1=&file=1 ----
  if (p === '/api/ebook/delete' && (method === 'DELETE' || method === 'POST')) {
    let sha1 = String(searchParams.get('sha1') || '').toLowerCase();
    let withFile = searchParams.get('file') === '1';
    if (!sha1 && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      sha1 = String((body && body.sha1) || '').toLowerCase();
      withFile = !!(body && body.file);
    }
    // 批量清理：?missing=1 删掉所有「原目录里已不存在」的条目
    if (searchParams.get('missing') === '1') {
      const list = ebookStore.loadIndex(store.dataDir).filter((e) => e.status === 'missing');
      const result = list.map((e) => deleteEbookEntry(e.sha1, { file: false }));
      return json(res, 200, { ok: true, cleaned: result.length, items: result.map((r) => r.sha1) });
    }
    if (!/^[0-9a-f]{40}$/.test(sha1)) return json(res, 400, { error: 'sha1 不合法' });
    const r = deleteEbookEntry(sha1, { file: withFile });
    return json(res, r.ok ? 200 : r.code || 400, r);
  }

  // ---- 客户端删除（带 X-Api-Token 的同一能力）----
  if (p === '/api/m/ebook/delete' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const sha1 = String((body && body.sha1) || '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha1)) return json(res, 400, { error: 'sha1 不合法' });
    const r = deleteEbookEntry(sha1, { file: !!(body && body.file) });
    return json(res, r.ok ? 200 : r.code || 400, r);
  }

  // ---- 客户端传书：POST /api/m/ebook/upload?name=xxx.pdf ----
  if (p === '/api/m/ebook/upload' && method === 'POST') {
    if (store.config.uploadEnabled === false) return json(res, 403, { error: '服务端已关闭客户端传书' });
    if (!checkUploadToken(req, url)) {
      return json(res, 401, { error: '上传令牌无效，请在「设置 → 手机接入」查看上传令牌', code: 'upload-token' });
    }
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.includes('multipart/form-data')) {
      return json(res, 400, {
        error: '不支持 multipart/form-data，请用裸 body 上传（--data-binary，文件名放 ?name=）',
        code: 'multipart',
      });
    }
    const rawName = String(searchParams.get('name') || '').trim();
    const ext = path.extname(rawName).toLowerCase();
    const format = UPLOAD_FORMATS[ext];
    if (!rawName || !format) {
      return json(res, 400, { error: '只支持 pdf / mobi / prc / azw / azw3 / epub / txt', code: 'format' });
    }

    const safeName =
      path.basename(rawName).replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 120) || `upload${ext}`;
    const dir = ebookScan.ebookDir(ebookCtx);
    fs.mkdirSync(dir, { recursive: true });
    const maxBytes = (Number(store.config.uploadMaxMB) || 1024) * 1024 * 1024;
    const tmp = path.join(dir, `.upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.part`);
    let size = 0;
    let aborted = false;

    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        req.on('data', (c) => {
          size += c.length;
          if (size > maxBytes && !aborted) {
            aborted = true;
            out.destroy();
            reject(new Error('文件超过上限'));
            req.destroy();
          }
        });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return json(res, 413, { error: `上传失败：${e.message}（上限 ${Math.round(maxBytes / 1048576)} MB）` });
    }

    let finalName = safeName;
    for (let i = 2; fs.existsSync(path.join(dir, finalName)); i++) {
      const base = path.basename(safeName, ext);
      finalName = `${base} (${i})${ext}`;
    }
    const dest = path.join(dir, finalName);
    fs.renameSync(tmp, dest);
    try {
      const old = Date.now() / 1000 - 120;
      fs.utimesSync(dest, old, old); // 绕过扫描的 20 秒 mtime 保护
    } catch {
      /* ignore */
    }

    let entry = null;
    try {
      const r = await ebookScan.scanOnce(ebookCtx);
      entry = ebookStore.loadIndex(store.dataDir).find((e) => e.sourcePath === dest) || null;
      if (entry) ebookBus.dispatch(ebookCtx, entry);
    } catch (e) {
      return json(res, 502, { error: '入库失败：' + e.message, name: finalName });
    }
    return json(res, 200, {
      ok: true,
      name: finalName,
      format,
      size,
      sha1: entry ? entry.sha1 : '',
      status: entry ? entry.status : 'discovered',
      path: dest,
    });
  }

  // ---- 客户端传书：配置查询 ----
  if (p === '/api/ebook/upload' && method === 'GET') {
    return json(res, 200, {
      enabled: store.config.uploadEnabled !== false,
      token: uploadToken(),
      dir: ebookScan.ebookDir(ebookCtx),
      maxMB: Number(store.config.uploadMaxMB) || 1024,
      formats: ['pdf', 'mobi', 'azw3', 'epub', 'txt'],
      endpoint: '/api/m/ebook/upload?name=<文件名>&token=<上传令牌>',
    });
  }

  if (p === '/api/ebook/upload/reset-token' && method === 'POST') {
    store.saveConfig({ uploadToken: crypto.randomBytes(16).toString('hex') });
    return json(res, 200, { ok: true, token: uploadToken() });
  }

  // ---- PDF 原页：触发渲染 / 查询进度 ----
  if (p === '/api/ebook/pages' && method === 'GET') {
    const sha1 = String(searchParams.get('sha1') || '').toLowerCase();
    const entry = ebookStore.getEntry(store.dataDir, sha1);
    if (!entry) return json(res, 404, { error: '没有这本书' });
    return json(res, 200, {
      sha1,
      format: entry.format,
      ready: ebookPages.pageCount(store.dataDir, sha1) > 0,
      count: ebookPages.pageCount(store.dataDir, sha1),
      rendering: ebookPages.isRendering(sha1),
    });
  }

  if (p === '/api/ebook/pages' && method === 'POST') {
    const body = await readJson(req);
    const sha1 = String((body && body.sha1) || searchParams.get('sha1') || '').toLowerCase();
    const entry = ebookStore.getEntry(store.dataDir, sha1);
    if (!entry) return json(res, 404, { error: '没有这本书' });
    if (String(entry.format).toLowerCase() !== 'pdf') return json(res, 400, { error: '只有 PDF 支持原页渲染' });
    const dpi = Number((body && body.dpi) || 100);
    ebookPages
      .renderPages(store.dataDir, sha1, entry.file, { dpi })
      .then((r) => events.broadcast({ type: 'ebook-pages', sha1, count: r.count }))
      .catch((e) => console.error('[legado-web] PDF 原页渲染失败:', e.message));
    return json(res, 202, { ok: true, sha1, started: true, dpi });
  }

  // ---- 单页图片：/api/ebook/page/<sha1>/<n> ----
  if (p.startsWith('/api/ebook/page/') && method === 'GET') {
    const rest = p.slice('/api/ebook/page/'.length);
    const m = /^([0-9a-f]{40})\/(\d+)$/.exec(rest);
    if (!m) return json(res, 400, { error: '路径应为 /api/ebook/page/<sha1>/<n>' });
    const file = ebookPages.pageFile(store.dataDir, m[1], Number(m[2]));
    if (!fs.existsSync(file)) return json(res, 404, { error: '该页还没有渲染' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(file).pipe(res);
  }

  // ---- 本地电子书：单章按需回传（toc-only 补章）----
  if (p === '/api/m/ebook/chapter' && method === 'POST') {
    if (!checkApiToken(req, url)) return json(res, 401, { error: 'token 无效' });
    const sha1 = String(searchParams.get('sha1') || '').toLowerCase();
    const index = Number(searchParams.get('index') || -1);
    if (!/^[0-9a-f]{40}$/.test(sha1)) return json(res, 400, { error: 'sha1 不合法' });
    if (!Number.isInteger(index) || index < 0) return json(res, 400, { error: 'index 不合法' });
    const entry = ebookStore.getEntry(store.dataDir, sha1);
    if (!entry) return json(res, 404, { error: '没有这本书' });
    const book = ebookStore.readBook(store.dataDir, sha1);
    if (!book || !book.toc || index >= book.toc.length) return json(res, 400, { error: '章节号越界' });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return json(res, 400, { error: '请求体不是合法 JSON' });
    }
    if (body && body.schema && body.schema !== 'fnreader.ebook.v1') return json(res, 400, { error: 'schema 不匹配', code: 'schema' });
    const rawParas = Array.isArray(body && body.paragraphs) ? body.paragraphs : [];
    if (!rawParas.length) return json(res, 400, { error: 'paragraphs 不能为空' });
    const allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'hr', 'img']);
    const paragraphs = rawParas
      .map((x) => ({ k: String((x && x.k) || 'p').toLowerCase(), t: String((x && x.t) || '') }))
      .filter((x) => allowed.has(x.k) && (x.t || x.k === 'hr'));
    if (!paragraphs.length) return json(res, 400, { error: '没有合法段落' });
    ebookStore.writeChapter(store.dataDir, sha1, {
      schema: 'fnreader.ebook.v1',
      sha1,
      index,
      id: book.toc[index].id,
      title: String((body && body.title) || book.toc[index].title),
      paragraphs,
    });
    return json(res, 200, { ok: true, index, chapters: book.toc.length });
  }

  // ---- 本地电子书：断点续传查询 ----
  if (p === '/api/m/ebook/parts' && method === 'GET') {
    if (!checkApiToken(req, url)) return json(res, 401, { error: 'token 无效' });
    const sha1 = String(searchParams.get('sha1') || '').toLowerCase();
    const entry = ebookStore.getEntry(store.dataDir, sha1);
    if (!entry) return json(res, 404, { error: '没有这本书' });
    const parts = ebookStore.receivedParts(store.dataDir, sha1);
    return json(res, 200, {
      sha1,
      total: entry.parts || 0,
      received: parts.length,
      complete: entry.status === 'complete',
      status: entry.status,
      parts,
    });
  }

  // App 同步已缓存小说：直接接收 Legado 的缓存文件结构，服务端自己转成本站格式
  //   目录：<下载目录>/cache/<书名>/
  //     raw/      原样保存 App 的 .nb（保留原始格式，便于回传 App）
  //     images/   章节图片
  //     0001 标题.txt   转好的正文（段落之间空行），网页阅读直接读它
  //     cover.jpg / meta.json
  if (p === '/api/m/cache' && method === 'POST') {
    const body = await readJson(req);
    const book = body && body.book;
    if (!book || !book.bookUrl) return json(res, 400, { error: '缺少 book.bookUrl' });

    const layout = String(body.layout || 'legado').toLowerCase();

    // 本地已有同名电子书（epub/mobi/txt/pdf）→ 不同步客户端的网文缓存
    if (body.skipIfLocal !== false) {
      const hit = localEbookByName(book.name);
      if (hit) {
        return json(res, 200, {
          ok: true,
          skipped: true,
          reason: 'local-ebook',
          message: '本地已有同名电子书，跳过客户端同步',
          local: { sha1: hit.sha1, name: hit.name, format: hit.format, status: hit.status },
        });
      }
    }

    const root = path.join(store.config.downloadDir || path.join(store.dataDir, 'downloads'), 'cache');
    const safe =
      String(book.name || '未命名')
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 80)
        .trim() || '未命名';

    // 同一本书重复同步时复用原目录，避免出现「书名 (2)(3)…」一堆同名目录
    let dir = findExistingDir(root, book.bookUrl, safe) || '';
    if (!dir) {
      dir = path.join(root, safe);
      for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${safe} (${i})`);
    }
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });

    let chapters = Array.isArray(body.chapters) ? body.chapters : [];
    let viaTxt = false;

    // 客户端手里只有 TXT：正文交给本地 Python 引擎分章，不再存 .nb
    const isTxt = String(body.format || (book && book.format) || '').toLowerCase() === 'txt' && typeof body.text === 'string';
    if (isTxt) {
      try {
        const parsed = await pyengine.call('txt', { name: book.name, text: body.text });
        chapters = (parsed.chapters || []).map((c) => ({
          title: c.title,
          raw: (c.paragraphs || []).join('\n'),
          paragraphs: c.paragraphs || [],
        }));
        viaTxt = true;
      } catch (e) {
        return json(res, 502, { error: '本地 TXT 解析失败：' + (e.message || e) });
      }
    }

    // 客户端回传的 .nb 若是整本大块（只有一个章节），用 TXT 目录规则再切一次
    if (chapters.length === 1) {
      const blob = chapters
        .map((c) => String(c.raw || '') + '\n' + (Array.isArray(c.paragraphs) ? c.paragraphs.join('\n') : ''))
        .join('\n');
      if (blob.length > 3000) {
        try {
          const r = splitTxtByRules(blob, book.name);
          if (r.chapters.length > 1) {
            chapters = r.chapters.map((c) => ({ title: c.title, raw: c.paragraphs.map((p) => p.t || p).join('\n') }));
          }
        } catch {
          /* 规则失败就保持原样 */
        }
      }
    }

    const saved = [];
    let bytes = 0;
    let imageCount = 0;

    chapters.forEach((ch, i) => {
      const idx = String(i + 1).padStart(4, '0');
      const title = String(ch.title || `第${i + 1}章`).replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60);

      // 原始内容：Legado 传 raw / content / paragraphs
      let rawText = '';
      if (typeof ch.raw === 'string') rawText = ch.raw;
      else if (Array.isArray(ch.paragraphs)) rawText = ch.paragraphs.join('\n');
      else if (typeof ch.content === 'string') rawText = ch.content;

      let paragraphs = [];
      let imgs = [];
      if (layout === 'legado') {
        const parsed = legadoToParagraphs(rawText);
        paragraphs = parsed.paragraphs;
        imgs = parsed.images;
      } else {
        paragraphs = rawText.split(/\n+/).map((x) => x.trim()).filter(Boolean);
      }

      // 原始文件（有文件名就按 App 的命名存）
      let rawName = '';
      if (rawText) {
        rawName = String(ch.file || `${idx}-${title}.nb`).replace(/[\\/:*?"<>|]/g, '_');
        fs.writeFileSync(path.join(dir, 'raw', rawName), rawText, 'utf8');
        bytes += Buffer.byteLength(rawText, 'utf8');
      }

      const text = paragraphs.join('\n\n');
      const file = `${idx} ${title}.txt`;
      if (text) {
        fs.writeFileSync(path.join(dir, file), text, 'utf8');
        bytes += Buffer.byteLength(text, 'utf8');
      }

      saved.push({
        index: i,
        title: String(ch.title || ''),
        url: String(ch.url || ''),
        file: text ? file : '',
        raw: rawName,
        images: imgs,
        imageFile: '',
      });
    });

    // 章节图片：{name, data(base64)} 或 {src, data}
    if (Array.isArray(body.images)) {
      for (const img of body.images) {
        try {
          const buf = Buffer.from(String(img.data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
          if (!buf.length) continue;
          const name = String(img.name || `${crypto.createHash('md5').update(String(img.src || Date.now())).digest('hex').slice(0, 16)}.jpg`)
            .replace(/[\\/:*?"<>|]/g, '_');
          fs.writeFileSync(path.join(dir, 'images', name), buf);
          imageCount++;
          bytes += buf.length;
        } catch {
          /* 忽略坏图 */
        }
      }
    }

    // 封面：存到公共 covers 目录，网页能直接访问
    let coverUrl = '';
    if (body.coverData) {
      try {
        const buf = Buffer.from(String(body.coverData).replace(/^data:[^;]+;base64,/, ''), 'base64');
        if (buf.length) {
          coverUrl = saveCover(book.bookUrl, buf, body.coverMime || 'image/jpeg');
          const ext = /png/i.test(body.coverMime || '') ? 'png' : /webp/i.test(body.coverMime || '') ? 'webp' : 'jpg';
          fs.writeFileSync(path.join(dir, `cover.${ext}`), buf);
        }
      } catch {
        /* 忽略坏图 */
      }
    }

    const meta = {
      layout,
      name: String(book.name || ''),
      author: String(book.author || ''),
      bookUrl: book.bookUrl,
      origin: String(book.origin || ''),
      originName: String(book.originName || ''),
      intro: String(book.intro || '').slice(0, 1000),
      totalChapterNum: saved.length || Number(book.totalChapterNum) || 0,
      durChapterIndex: Number(book.durChapterIndex || 0),
      savedAt: Date.now(),
      cover: coverUrl,
      chapters: saved,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    // 登记到书架：正文已在本地，读章节直接读文件
    const stored = store.findBook(book.bookUrl) || {};
    const explicitOrigin = String(book.origin || stored.origin || '').trim();
    const inferredSource = explicitOrigin ? null : resolveSourceForBookUrl(book.bookUrl);
    store.upsertBook({
      ...stored,
      bookUrl: book.bookUrl,
      name: String(book.name || stored.name || '未命名'),
      author: String(book.author || stored.author || ''),
      coverUrl: coverUrl || stored.coverUrl || '',
      intro: String(book.intro || stored.intro || ''),
      origin: explicitOrigin || inferredSource?.bookSourceUrl || '',
      originName: inferredSource
        ? inferredSource.bookSourceName
        : String(book.originName || stored.originName || '手机缓存'),
      chapters: saved.map((c) => ({ title: c.title, url: c.url, file: c.file })),
      totalChapterNum: saved.length,
      cachedDir: dir,
      durChapterIndex: Number(book.durChapterIndex || stored.durChapterIndex || 0),
      durChapterTime: Date.now(),
    });
    events.broadcast({ type: 'shelf', action: 'cache', bookUrl: book.bookUrl, via: 'app' });

    return json(res, 200, {
      ok: true,
      layout,
      dir,
      via: viaTxt ? 'local-txt' : 'legado',
      chapters: saved.length,
      withText: saved.filter((c) => c.file).length,
      images: imageCount,
      bytes,
      cover: coverUrl,
    });
  }

  // App 上传书源：与「导入书源」同格式，按 bookSourceUrl 合并
  if (p === '/api/m/sources' && method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body) ? body : body && Array.isArray(body.sources) ? body.sources : [];
    if (!list.length) return json(res, 400, { error: '请提供书源数组' });
    const existing = new Map(store.sources.map((s) => [s.bookSourceUrl, s]));
    let added = 0;
    let updated = 0;
    let duplicated = 0;
    const seen = new Set();
    for (const item of list) {
      if (!item || !item.bookSourceUrl) continue;
      const normalized = normalizeSource(item);       // 补 type / rule* 默认值 / 运行时方法
      const url = normalized.bookSourceUrl;
      if (seen.has(url)) { duplicated++; continue; }   // 同一批里重复的只留第一次
      seen.add(url);
      const stamp = Number(item.lastUpdateTime) || Date.now();
      const hit = existing.get(url);
      if (hit) {
        Object.assign(hit, normalized, {
          enabled: item.enabled !== undefined ? item.enabled : hit.enabled,
          lastUpdateTime: Math.max(stamp, Number(hit.lastUpdateTime) || 0),
        });
        updated++;
      } else {
        const created = { ...normalized, enabled: item.enabled !== false, lastUpdateTime: stamp };
        store.sources.push(created);
        existing.set(url, created);
        added++;
      }
    }
    store.saveSources(store.sources);
    events.broadcast({ type: 'sources', action: 'import', added, updated, via: 'app' });
    return json(res, 200, { ok: true, added, updated, duplicated, total: store.sources.length });
  }

/** Legado 缓存正文 → 我们的段落数组；顺带取出图片地址 */
function legadoToParagraphs(rawText) {
  const text = String(rawText || '');
  const images = [];
  const stripped = text.replace(/<img[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (m, src) => {
    if (src) images.push(src);
    return '\n[图片]\n';
  });
  const paragraphs = stripped
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, ''))
    .filter((line) => line.length > 0);
  return { paragraphs, images };
}

/** 保存封面文件并返回可访问地址 */
function saveCover(target, buf, mime) {
  const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : /gif/i.test(mime) ? 'gif' : 'jpg';
  const name = crypto.createHash('sha1').update(String(target) || buf).digest('hex').slice(0, 16) + '.' + ext;
  fs.mkdirSync(COVER_DIR, { recursive: true });
  fs.writeFileSync(path.join(COVER_DIR, name), buf);
  return `${directBase()}/api/covers/${name}`;
}

  // App 上传封面：JSON {bookUrl, data(base64)} 或 raw image + ?bookUrl=
  if (p === '/api/m/cover' && method === 'POST') {
    const bookUrl = searchParams.get('bookUrl') || '';
    const ctype = String(req.headers['content-type'] || '');
    let buf = null;
    let mime = 'image/jpeg';
    let target = bookUrl;

    if (ctype.includes('application/json')) {
      const body = await readJson(req);
      if (!body || !body.data) return json(res, 400, { error: '缺少 data' });
      target = body.bookUrl || target;
      mime = body.mime || 'image/jpeg';
      buf = Buffer.from(String(body.data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    } else {
      buf = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) {
            reject(new Error('封面过大'));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
      mime = ctype.split(';')[0] || 'image/jpeg';
    }

    if (!buf || !buf.length) return json(res, 400, { error: '封面为空' });
    const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : /gif/i.test(mime) ? 'gif' : 'jpg';
    const name = crypto.createHash('sha1').update(target || buf).digest('hex').slice(0, 16) + '.' + ext;
    fs.mkdirSync(COVER_DIR, { recursive: true });
    fs.writeFileSync(path.join(COVER_DIR, name), buf);

    const coverUrl = `${directBase()}/api/covers/${name}`;
    const book = target ? store.findBook(target) : null;
    if (book) {
      book.coverUrl = coverUrl;
      store.upsertBook(book);
      events.broadcast({ type: 'cover', bookUrl: book.bookUrl, via: 'app' });
    }
    return json(res, 200, { ok: true, coverUrl, size: buf.length, book: !!book });
  }

  // App 上传书籍：把手机本地加的书推到 NAS 书架
  if (p === '/api/m/books' && method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body) ? body : body && Array.isArray(body.books) ? body.books : body ? [body] : [];
    if (!list.length) return json(res, 400, { error: '请提供书籍对象或数组' });
    let added = 0;
    let updated = 0;
    ensureTombstone();
    let skippedDeleted = 0;
    for (const item of list) {
      const bookUrl = String((item && item.bookUrl) || '').trim();
      if (!/^https?:/i.test(bookUrl)) continue;
      // 被删过的书不再推回来；客户端要主动恢复必须显式 force: true
      if (tombstone.tombstoneOf(bookUrl) && !(item && item.force === true)) {
        skippedDeleted++;
        continue;
      }
      if (item && item.force === true) tombstone.remove(bookUrl);
      // 内嵌封面：一次请求完成「加书 + 封面」
      let inlineCover = '';
      if (item.coverData) {
        try {
          const buf = Buffer.from(String(item.coverData).replace(/^data:[^;]+;base64,/, ''), 'base64');
          if (buf.length) inlineCover = saveCover(bookUrl, buf, item.coverMime || 'image/jpeg');
        } catch {
          /* 忽略坏图片 */
        }
      }
      const existing = store.findBook(bookUrl);
      if (existing) {
        store.upsertBook({
          ...existing,
          coverUrl: inlineCover || item.coverUrl || existing.coverUrl,
          name: item.name || existing.name,
          author: item.author || existing.author,
          intro: item.intro || existing.intro,
          durChapterIndex: Number(item.index != null ? item.index : item.durChapterIndex) || existing.durChapterIndex || 0,
          durChapterTitle: item.title || item.durChapterTitle || existing.durChapterTitle || '',
          durChapterTime: Number(item.time || item.durChapterTime) || existing.durChapterTime || Date.now(),
        });
        updated++;
      } else {
        const inferredSource = String(item.origin || '').trim() ? null : resolveSourceForBookUrl(bookUrl);
        store.upsertBook({
          bookUrl,
          name: String(item.name || '未命名'),
          author: String(item.author || ''),
          coverUrl: inlineCover || String(item.coverUrl || ''),
          intro: String(item.intro || ''),
          kind: String(item.kind || ''),
          origin: String(item.origin || inferredSource?.bookSourceUrl || ''),
          originName: inferredSource
            ? inferredSource.bookSourceName
            : String(item.originName || item.origin || '手机端'),
          tocUrl: '',
          chapters: [],
          durChapterIndex: Number(item.index != null ? item.index : item.durChapterIndex) || 0,
          durChapterPos: Number(item.pos || item.durChapterPos) || 0,
          durChapterTitle: String(item.title || item.durChapterTitle || ''),
          durChapterTime: Number(item.time || item.durChapterTime) || Date.now(),
          totalChapterNum: Number(item.totalChapterNum) || 0,
        });
        added++;
      }
    }
    if (added) events.broadcast({ type: 'shelf', action: 'add', count: added, via: 'app' });
    if (added || updated) await dedupeShelf();
    // 缺封面/简介的书：后台兜底补全（每本间隔 2 秒，避免打爆第三方）
    if (added || updated) {
      list.slice(0, 5).forEach((item, i) => {
        const url = String(item && item.bookUrl || '');
        if (url) scheduleMetaEnrich(url, 2000 + i * 2000);
      });
    }
    return json(res, 200, { ok: true, added, updated, skippedDeleted, total: store.books.length });
  }

  // 批量回传阅读进度（App 同步用）
  if (p === '/api/m/progress/batch' && method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body) ? body : body && Array.isArray(body.items) ? body.items : [];
    if (!list.length) return json(res, 400, { error: '请提供进度数组' });
    let updated = 0;
    const missing = [];
    for (const item of list) {
      let book = store.findBook(item.bookUrl);
      if (!book) {
        if (tombstone.tombstoneOf(item.bookUrl) && item.force !== true) {
          missing.push(item.bookUrl);
          continue;
        }
        // App 本地新加的书：带书名就顺手建一条，否则记为 missing 让 App 补传
        if (item.name && /^https?:/i.test(String(item.bookUrl || ''))) {
          book = {
            bookUrl: item.bookUrl,
            name: item.name,
            author: item.author || '',
            coverUrl: item.coverUrl || '',
            intro: item.intro || '',
            kind: item.kind || '',
            origin: item.origin || '',
            originName: item.originName || item.origin || '手机端',
            tocUrl: '',
            chapters: [],
            durChapterIndex: 0,
            durChapterPos: 0,
            durChapterTitle: '',
            durChapterTime: 0,
            totalChapterNum: Number(item.totalChapterNum) || 0,
          };
          store.upsertBook(book);
          events.broadcast({ type: 'shelf', action: 'add', bookUrl: book.bookUrl, via: 'app' });
        } else {
          missing.push(item.bookUrl);
          continue;
        }
      }
      book.durChapterIndex = Number(item.index) || 0;
      book.durChapterPos = Number(item.pos) || 0;
      book.durChapterTitle = item.title || book.durChapterTitle || '';
      book.durChapterTime = Number(item.time) || Date.now();
      store.upsertBook(book);
      events.broadcast({ type: 'progress', bookUrl: book.bookUrl, index: book.durChapterIndex, title: book.durChapterTitle, via: 'app' });
      updated++;
    }
    return json(res, 200, { ok: true, updated, total: list.length, missing });
  }

  if (p === '/api/m/cover' && method === 'GET') {
    const book = store.findBook(searchParams.get('url'));
    if (!book || !book.coverUrl) return json(res, 404, { error: '没有封面' });
    try {
      return await serveImage(res, book.coverUrl, book.bookUrl);
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  /* ---------- 「阅读」APK 接入（Legado 书源桥） ---------- */

  // 书源 JSON：GET /api/m/booksource?token=xxx
  if (p === '/api/m/booksource' && method === 'GET') {
    const base = directBase();
    return json(res, 200, buildLegadoBookSource(base, apiToken()));
  }

  // 书源搜索：返回 Legado 规则可直接 JSONPath 解析的结构
  if (p === '/api/m/legado/search' && method === 'GET') {
    const key = String(searchParams.get('key') || '').trim();
    if (!key) return json(res, 400, { error: '缺少 key' });
    const base = directBase();
    const token = apiToken();
    try {
      const books = await mobileSearch(key, searchParams.get('group') || '', searchParams.get('limit') || 8);
      const list = books.map((b) => {
        const src = store.findSource(b.origin);
        return {
          name: b.name,
          author: b.author || '',
          kind: b.kind || '',
          intro: b.intro || '',
          lastChapter: b.lastChapter || '',
          coverUrl: b.coverUrl
            ? `${base}/api/m/cover?token=${token}&url=${encodeURIComponent(b.bookUrl)}`
            : '',
          bookUrl: `${base}/api/m/legado/book?token=${token}&u=${b64u(b.bookUrl)}&s=${b64u(
            src ? src.bookSourceUrl : ''
          )}&n=${encodeURIComponent(b.name || '')}`,
        };
      });
      return json(res, 200, { key, books: list });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  // 书籍详情：首次打开时自动加入书架，修掉「搜到书却打不开」的断链
  if (p === '/api/m/legado/book' && method === 'GET') {
    const base = directBase();
    const token = apiToken();
    const bookUrl = unb64u(searchParams.get('u'));
    const srcUrl = unb64u(searchParams.get('s'));
    if (!bookUrl) return json(res, 400, { error: '缺少 u 参数' });
    let book = store.findBook(bookUrl);
    if (!book) {
      const source = store.findSource(srcUrl);
      if (!source) return json(res, 404, { error: '书源不存在，请回到阅读重新搜索' });
      book = {
        name: String(searchParams.get('n') || ''),
        author: '',
        bookUrl,
        origin: sourceId(source),
        originName: source.bookSourceName,
        coverUrl: '',
        intro: '',
        kind: '',
        lastChapter: '',
        tocUrl: '',
        chapters: [],
        durChapterIndex: 0,
        durChapterPos: 0,
        durChapterTitle: '',
        durChapterTime: 0,
        totalChapterNum: 0,
        group: 0,
        order: Date.now(),
        addedBy: 'apk',
      };
      try {
        await getBookInfo(source, book);
      } catch {
        /* 详情抓不到也先入架，目录页还能重试 */
      }
      store.upsertBook(book);
    }
    return json(res, 200, {
      book: {
        name: book.name,
        author: book.author || '',
        kind: book.kind || '',
        intro: book.intro || '',
        lastChapter: book.lastChapter || '',
        coverUrl: book.coverUrl
          ? `${base}/api/m/cover?token=${token}&url=${encodeURIComponent(book.bookUrl)}`
          : '',
        tocUrl: `${base}/api/m/legado/toc?token=${token}&u=${b64u(book.bookUrl)}`,
      },
    });
  }

  // 目录：章节地址直接指向 /api/m/content，正文返回 {"paragraphs":[...]}
  if (p === '/api/m/legado/toc' && method === 'GET') {
    const base = directBase();
    const token = apiToken();
    const book = store.findBook(unb64u(searchParams.get('u')));
    if (!book) return json(res, 404, { error: '书籍不在书架中，请从阅读里重新搜索打开' });
    if (!book.chapters || !book.chapters.length) {
      try {
        await handleRefreshToc(book);
      } catch (e) {
        return json(res, 502, { error: String(e.message || e) });
      }
    }
    return json(res, 200, {
      name: book.name,
      author: book.author || '',
      chapters: book.chapters.map((c, i) => ({
        title: c.title,
        url: `${base}/api/m/content?token=${token}&url=${encodeURIComponent(book.bookUrl)}&index=${i}`,
      })),
    });
  }

  if (p === '/api/sources' && method === 'GET') {
    // 已启用排前面，其余按名称排
    const ordered = [...store.sources].sort(
      (a, b) =>
        Number(b.enabled !== false) - Number(a.enabled !== false) ||
        String(a.bookSourceName || '').localeCompare(String(b.bookSourceName || ''), 'zh')
    );
    return json(res, 200, {
      sources: ordered.map((s) => ({
        bookSourceUrl: s.bookSourceUrl,
        bookSourceName: s.bookSourceName,
        bookSourceGroup: s.bookSourceGroup,
        enabled: s.enabled !== false,
        checkStatus: s.checkStatus || '',
        checkAt: s.checkAt || 0,
      })),
    });
  }

  if (p === '/api/sources/check' && method === 'POST') {
    const body = await readJson(req);
    const key = String(body.key || '斗破').trim() || '斗破';
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
    if (checkJob.running) return json(res, 200, { started: false, running: true, ...checkSummary() });
    startCheck(key, ids);
    return json(res, 200, { started: true, total: checkJob.total });
  }

  if (p === '/api/sources/check' && method === 'GET') {
    return json(res, 200, checkSummary());
  }

  if (p === '/api/sources/check/disable-unavailable' && method === 'POST') {
    let disabled = 0;
    for (const s of store.sources) {
      if (s.checkStatus && s.checkStatus !== 'ok' && s.enabled !== false) {
        s.enabled = false;
        s.lastUpdateTime = Date.now();
        disabled++;
      }
    }
    store.saveSources(store.sources);
    return json(res, 200, { ok: true, disabled });
  }

  // 批量删除勾选的书源（先备份）
  if (p === '/api/sources/batch-delete' && method === 'POST') {
    const body = await readJson(req);
    const urls = Array.isArray(body && body.urls) ? body.urls.filter(Boolean) : [];
    if (!urls.length) return json(res, 400, { error: '没有选择书源' });
    const backupDir = path.join(store.dataDir, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, 'sources-' + stamp + '.json'), JSON.stringify(store.sources), 'utf8');
    const before = store.sources.length;
    const set = new Set(urls);
    const keep = store.sources.filter((s) => !set.has(s.bookSourceUrl));
    store.saveSources(keep);
    return json(res, 200, { ok: true, removed: before - keep.length, remaining: keep.length });
  }

  // 删除检测未通过的书源（先备份到 var/backup/）
  if (p === '/api/sources/check/remove-unavailable' && method === 'POST') {
    if (checkJob.running) return json(res, 409, { error: '检测进行中，请等结束再清理' });
    const body = await readJson(req).catch(() => ({}));
    const mode = body && body.mode === 'all' ? 'all' : 'fail';
    const backupDir = path.join(store.dataDir, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `sources-${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(store.sources), 'utf8');

    const before = store.sources.length;
    const keep = store.sources.filter((s) => {
      if (!s.checkStatus) return true;
      if (s.checkStatus === 'ok') return true;
      if (mode === 'all') return false;
      return s.checkStatus !== 'fail'; // 默认只删「不可用」，「无结果」保留
    });
    store.saveSources(keep);
    return json(res, 200, {
      ok: true,
      mode,
      removed: before - keep.length,
      remaining: keep.length,
      backup: backupFile,
    });
  }

  if (p === '/api/sources' && method === 'POST') {
    const body = await readJson(req);
    let incoming = [];
    if (Array.isArray(body)) incoming = body;
    else if (Array.isArray(body.sources)) incoming = body.sources;
    else if (body.source) incoming = [body.source];
    else if (body.url) {
      const resp = await request(String(body.url), { timeout: 30000 });
      const parsed = JSON.parse(resp.body);
      incoming = Array.isArray(parsed) ? parsed : [parsed];
    }
    incoming = incoming.filter((s) => s && s.bookSourceUrl);
    if (!incoming.length) return json(res, 400, { error: '没有解析到有效书源' });

    const map = new Map(store.sources.map((s) => [s.bookSourceUrl, s]));
    for (const raw of incoming) {
      const s = normalizeSource(raw);
      map.set(s.bookSourceUrl, {
        ...(map.get(s.bookSourceUrl) || {}),
        ...s,
        enabled: true,
        lastUpdateTime: Date.now(),
      });
    }
    store.saveSources([...map.values()]);
    return json(res, 200, { ok: true, imported: incoming.length, total: store.sources.length });
  }

  if (p.startsWith('/api/sources/') && (method === 'PATCH' || method === 'DELETE')) {
    const id = decodeURIComponent(p.slice('/api/sources/'.length));
    const list = store.sources;
    const idx = list.findIndex((s) => s.bookSourceUrl === id);
    if (idx < 0) return json(res, 404, { error: '书源不存在' });
    if (method === 'DELETE') list.splice(idx, 1);
    else {
      const body = await readJson(req);
      list[idx] = { ...list[idx], enabled: body.enabled !== false, lastUpdateTime: Date.now() };
    }
    store.saveSources(list);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/books' && method === 'GET') {
    ensureTombstone();
    await dedupeShelf();
    const books = [...store.books].sort((a, b) => (b.durChapterTime || 0) - (a.durChapterTime || 0));
    // 老版本入库的 ebook:// 条目没有 ebookFormat，这里按登记表补上（前端据此显示「文/图」按钮）
    let fmtMap = null;
    const needFmt = books.some((b) => String(b.bookUrl).startsWith('ebook://') && !b.ebookFormat);
    if (needFmt) {
      try {
        fmtMap = new Map(ebookStore.loadIndex(store.dataDir).map((e) => [e.sha1, e.format]));
      } catch {
        fmtMap = new Map();
      }
    }
    const enriched = books.map((b) => {
      let out = b;
      if (fmtMap) {
        const sha = ebookRender.parseUrl(b.bookUrl);
        if (sha && !b.ebookFormat && fmtMap.get(sha)) out = { ...b, ebookFormat: fmtMap.get(sha) };
      }
      if (!out.ebookFormat && out.localEbook && out.localEbook.format) out = { ...out, ebookFormat: out.localEbook.format };
      return sanitizeBook(out);
    });
    return json(res, 200, { books: enriched });
  }

  // 换源：按书名再搜一遍，返回其它书源的同名书
  if (p === '/api/switch-source' && method === 'GET') {
    const name = String(searchParams.get('name') || '').trim();
    const exclude = String(searchParams.get('exclude') || '');
    if (!name) return json(res, 400, { error: '缺少书名' });
    try {
      let books = await mobileSearch(name, searchParams.get('group') || '', searchParams.get('limit') || 8);

      // 本地结果太少时，再让软总线上的手机用它的书源搜一轮
      const wantPhone = searchParams.get('remote') === '1' || store.config.preferRemote === true;
      if ((wantPhone || books.length < 3 || busAvailable()) && busAvailable()) {
        const phoneSources = store.sources
          .filter((x) => x.enabled)
          .sort((a, b) => Number(b.checkStatus === 'ok') - Number(a.checkStatus === 'ok'))
          .slice(0, 16);
        const buckets = await Promise.all(
          phoneSources.map((src) =>
            remote
              .request('search', { source: src.bookSourceUrl, name: src.bookSourceName, key: name }, 6000)
              .then((r) => (r.ok && r.data && Array.isArray(r.data.books) ? r.data.books.map((b) => ({ ...b, viaPhone: true })) : []))
              .catch(() => [])
          )
        );
        for (const list of buckets) books = books.concat(list);
      }

      // 同一本书只留一条（多个源抓到同一地址）
      const seenUrl = new Set();
      books = books.filter((b) => {
        if (!b || !b.bookUrl || seenUrl.has(b.bookUrl)) return false;
        seenUrl.add(b.bookUrl);
        return true;
      });

      const norm = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
      const target = norm(name);
      const list = books
        .filter((b) => b.bookUrl !== exclude)
        .map((b) => {
          const n = norm(b.name);
          const score = n === target ? 0 : n.includes(target) ? 1 : target.includes(n) ? 2 : 3;
          return { b, score };
        })
        .sort((x, y) => x.score - y.score)
        .filter((x) => x.score <= 2)
        .slice(0, 30)
        .map((x) => x.b);
      return json(res, 200, { name, books: list });
    } catch (e) {
      return json(res, 502, { error: '换源搜索失败：' + (e.message || e) });
    }
  }

  // 网页端事件流：App 回传进度后立即刷新
  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}

`);
    events.addClient(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping' + String.fromCharCode(10, 10));
      } catch {
        /* ignore */
      }
    }, 25000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  // 借助手机端解析器：服务端建任务并等待结果
  if (p === '/api/remote/job' && method === 'POST') {
    const body = await readJson(req);
    const type = String((body && body.type) || '');
    if (!['search', 'toc', 'content', 'bookinfo', 'cover', 'intro', 'rank', 'ebook-parse', 'ebook-chapter'].includes(type)) {
      return json(res, 400, { error: '不支持的任务类型' });
    }
    // 软总线不因升级后的「确认缓存位置」而中断，否则客户端会拿不到任务、代理解析全空
    const isEbook = type === 'ebook-parse';
    const wait = isEbook ? 240000 : Math.min(60000, Number((body && body.waitMs) || 20000));
    const result = await remote.request(type, body.payload || {}, wait);
    if (!result.ok) return json(res, 504, { error: result.error === 'timeout' ? '手机端没有响应' : result.error });
    return json(res, 200, { ok: true, data: result.data });
  }

  // 规则引擎切换：Node（内置）/ Python（规则解析）/ Java 21（TOC 后处理）
  if (p === '/api/engine' && method === 'GET') {
    const status = await pyengine.probe();
    const java = await javaWorker.health();
    return json(res, 200, {
      engine: effectiveEngine(),
      engineSwitch: store.config.engine === 'python' ? 'python' : 'node',
      pyMode: String(store.config.pyMode || 'aux'),
      pythonAux: pythonAuxEnabled(),
      python: status,
      javaEngine: store.config.javaEngine !== false,
      java,
      node: { version: process.version, v8: process.versions.v8, compileCache: require('node:module').getCompileCacheDir?.() || '' },
    });
  }

  if (p === '/api/engine' && method === 'POST') {
    const body = await readJson(req);
    if (body && typeof body.javaEngine === 'boolean') {
      if (body.javaEngine) {
        javaWorker.setEnabled(true);
        const java = await javaWorker.health();
        if (!java.ok) {
          javaWorker.setEnabled(false);
          return json(res, 400, { error: 'Java 21 TOC 引擎不可用：' + (java.lastError || '启动失败'), java });
        }
      } else {
        javaWorker.setEnabled(false);
      }
      store.saveConfig({ javaEngine: body.javaEngine });
      return json(res, 200, { ok: true, javaEngine: body.javaEngine, java: await javaWorker.health() });
    }
    if (body && (body.pyMode === 'aux' || body.pyMode === 'core')) {
      store.saveConfig({ pyMode: body.pyMode });
    }
    if (!body || body.engine === undefined) {
      return json(res, 200, { ok: true, engine: effectiveEngine(), pyMode: String(store.config.pyMode || 'aux') });
    }
    const want = body.engine === 'python' ? 'python' : 'node';
    if (want === 'python') {
      const status = await pyengine.probe(true);
      if (!status.ok) return json(res, 400, { error: 'Python 引擎不可用：' + (status.error || '未知原因'), python: status });
    }
    store.saveConfig({ engine: want });
    return json(res, 200, { ok: true, engine: want });
  }

  // 每日推荐（起点榜 → 纵横兜底，6 小时缓存）
  if (p === '/api/daily' && method === 'GET') {
    const data = await getDaily(path.join(store.dataDir, 'daily.json'), {
      remoteRank: busAvailable()
        ? async () => {
            const r = await remote.request('rank', { url: 'https://www.qidian.com/rank/recom/' }, 12000);
            if (!r.ok || !r.data) return null;
            return r.data;
          }
        : null,
    });
    const books = (data.books || []).map((b) => ({
      ...b,
      from: data.source,
    }));
    return json(res, 200, {
      source: data.source || '',
      url: data.url || '',
      updatedAt: data.updatedAt || 0,
      cached: !!data.cached,
      stale: !!data.stale,
      count: books.length,
      books,
      error: data.error || '',
    });
  }


  if (p === '/api/bus' && method === 'GET') {
    return json(res, 200, { devices: remote.listDevices(), ...remote.stats(), usage: busUsage });
  }

  if (p === '/api/bus/toggle' && method === 'POST') {
    const body = await readJson(req);
    const ok = remote.setEnabled(String(body.id || ''), body.enabled !== false);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '设备不存在' });
  }

  // 缓存目录去重：把「书名 (2)(3)…」合并回一本
  if (p === '/api/cache/dedupe' && method === 'POST') {
    const root = path.join(store.config.downloadDir || path.join(store.dataDir, 'downloads'), 'cache');
    const r = await dedupeCache(root);
    return json(res, 200, { ok: true, ...r, root });
  }

  // 书源双向同步（LWW：lastUpdateTime 大的赢）
  if (p === '/api/m/sources/sync' && method === 'GET') {
    const data = pullSince(store, searchParams.get('since') || 0);
    return json(res, 200, { ok: true, ...data, total: store.sources.length });
  }

  if (p === '/api/m/sources/sync' && method === 'POST') {
    const body = await readJson(req);
    const r = mergeSources(store, body || {});
    events.broadcast({ type: 'sources', action: 'sync', applied: r.applied, via: 'app' });
    return json(res, 200, { ok: true, ...r, total: store.sources.length });
  }

  // 封面文件
  if (p.startsWith('/api/covers/') && method === 'GET') {
    const name = path.basename(p.replace('/api/covers/', ''));
    const file = path.join(COVER_DIR, name);
    if (!fs.existsSync(file)) return json(res, 404, { error: '封面不存在' });
    const ext = path.extname(name).slice(1).toLowerCase();
    const type = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[ext] || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
    return res.end(fs.readFileSync(file));
  }

  if (p === '/api/remote/stats' && method === 'GET') {
    return json(res, 200, { ...remote.stats(), viewers: events.count() });
  }

  // App 同步：一次拉取书架 / 阅读进度 / 书源配置
  if (p === '/api/m/sync' && method === 'GET') {
    const payload = buildSyncPayload(store, {
      since: searchParams.get('since') || 0,
      full: searchParams.get('full') === '1',
      version: APP_VERSION,
    });
    return json(res, 200, payload);
  }

  // 手机端领任务（长轮询：没有任务就等一会儿再返回）
  if (p === '/api/m/remote/pending' && method === 'GET') {
    // 设备报到：id/name/model 由 App 带上来；2.6.19 起再带能力上报（cores / mem / inflight / supports），
    // 服务端据此给初值分并切分各类额度，不再让新设备一律从 50 分开始
    remote.hello({
      id: searchParams.get('id') || req.headers['x-device-id'] || '',
      name: searchParams.get('name') || req.headers['x-device-name'] || '',
      model: searchParams.get('model') || req.headers['x-device-model'] || '',
      version: searchParams.get('ver') || '',
      caps: {
        cores: Number(searchParams.get('cores') || 0),
        memMb: Number(searchParams.get('mem') || 0),
        maxInflight: Number(searchParams.get('inflight') || 0),
        supports: String(searchParams.get('supports') || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      },
    });
    const deviceId = searchParams.get('id') || req.headers['x-device-id'] || '';
    const wait = Math.min(30000, Number(searchParams.get('wait') || 10000));
    const deadline = Date.now() + wait;
    let list = remote.pending(Number(searchParams.get('limit') || 5), deviceId);
    while (!list.length && Date.now() < deadline && !res.writableEnded) {
      await new Promise((r) => setTimeout(r, 800));
      list = remote.pending(5, deviceId);
    }
    return json(res, 200, {
      jobs: list,
      waitMs: wait,
      serverTime: Date.now(),
      debug: remote.isDebugDevice(deviceId, ''),
    });
  }

  if (p === '/api/m/remote/result' && method === 'POST') {
    const body = await readJson(req);
    if (!body || !body.id) return json(res, 400, { error: '缺少任务 id' });
    const devId = body.deviceId || req.headers['x-device-id'] || '';
    const ok = remote.complete(body.id, body.ok !== false, body.data, body.error, devId);
    if (ok === 'ignored') {
      return json(res, 200, { ok: true, accepted: false, ignored: true, reason: '调试设备结果已忽略' });
    }
    if (ok) {
      if (devId) remote.bumpHandled(devId);
      else {
        // 没带设备 id 时记到最近活跃的设备上
        const d = remote.listDevices()[0];
        if (d) remote.bumpHandled(d.id);
      }
    }
    return json(res, 200, { ok, accepted: ok });
  }

  // 书源配置原文件（与 Legado 导出的数组格式一致，可直接导入）
  if (p === '/api/m/sources.json' && method === 'GET') {
    const list = store.sources.filter((s) => s.enabled !== false || searchParams.get('all') === '1');
    res.setHeader('Content-Disposition', 'attachment; filename="sources.json"');
    return json(res, 200, list);
  }

  // 简介补全：本应用无关书源里都没有简介时，去其它书源 / 晋江取
  if (p === '/api/intro' && method === 'GET') {
    const name = String(searchParams.get('name') || '').trim();
    const author = String(searchParams.get('author') || '').trim();
    if (!name) return json(res, 400, { error: '缺少书名' });
    try {
      let bookUrlParam = String(searchParams.get('url') || '');
      let originParam = String(searchParams.get('origin') || '');
      // 网页详情页只传了书名/作者：从书架里反查地址，否则手机不知道要抓哪本书
      if (!bookUrlParam) {
        const inShelf = (store.books || []).find(
          (b) => b.name === name && (!author || !b.author || b.author.includes(author) || author.includes(b.author))
        );
        if (inShelf) {
          bookUrlParam = inShelf.bookUrl;
          originParam = originParam || inShelf.origin || '';
        }
      }
      const r = await introLookup.lookup(name, author, store.dataDir, {
        force: searchParams.get('force') === '1',
        searchSources: (key, limit) => mobileSearch(key, '', limit),
        fetchDetail: async (b) => {
          const src = store.findSource(b.origin);
          if (!src) return null;
          const book = { ...b };
          await getBookInfo(src, book).catch(() => null);
          return book;
        },
      });
      // 本地书源/晋江都拿不到时，让手机端补全
      if (!r.intro) {
        const info = (await remoteMedia(bookUrlParam, originParam)) || (await remoteBookInfo(bookUrlParam, originParam));
        if (info && info.intro) {
          const book = store.findBook(bookUrlParam);
          if (book) applyRemoteBookInfo(book, info);
          return json(res, 200, { ...r, ...info, source: '手机解析', via: 'phone' });
        }
      }
      return json(res, 200, r);
    } catch (e) {
      return json(res, 502, { error: '获取简介失败：' + (e.message || e) });
    }
  }

  // 书籍详情（搜索结果点进去）
  if (p === '/api/detail' && method === 'GET') {
    const url = String(searchParams.get('url') || '');
    const origin = String(searchParams.get('origin') || '');
    if (!/^https?:/i.test(url)) return json(res, 400, { error: '缺少书籍地址' });
    const inShelf = store.findBook(url);
    const book = inShelf
      ? { ...inShelf, chapters: undefined, totalChapterNum: (inShelf.chapters || []).length || inShelf.totalChapterNum }
      : { bookUrl: url, name: '', author: '', coverUrl: '', intro: '', kind: '', origin, originName: '' };
    if (!inShelf && origin) {
      const source = store.sources.find((x) => x.bookSourceUrl === origin);
      if (source) {
        try {
          await getBookInfo(source, book);
        } catch {
          /* 详情抓不到就把搜索里的信息返回 */
        }
      }
    }
    // 本地书源抓不到简介：让手机补
    if (!book.intro || !book.coverUrl) {
      const info = (await remoteMedia(url, origin)) || (await remoteBookInfo(url, origin));
      if (info && (info.intro || info.coverUrl)) {
        applyRemoteBookInfo(inShelf || book, info);
        Object.assign(book, {
          intro: book.intro || info.intro,
          coverUrl: book.coverUrl || info.coverUrl,
          author: book.author || info.author,
          kind: book.kind || info.kind,
          wordCount: book.wordCount || info.wordCount,
          lastChapter: book.lastChapter || info.lastChapter,
        });
        return json(res, 200, { book, inShelf: !!inShelf, via: 'phone' });
      }
    }
    return json(res, 200, { book, inShelf: !!inShelf });
  }

  if (p === '/api/books' && method === 'POST') {
    const body = await readJson(req);
    if (!body || !body.bookUrl) return json(res, 400, { error: '缺少书籍信息' });
    const book = {
      ...body,
      origin: body.origin,
      chapters: body.chapters || [],
      durChapterIndex: body.durChapterIndex || 0,
      durChapterPos: 0,
      durChapterTime: Date.now(),
      totalChapterNum: body.totalChapterNum || 0,
    };
    ensureTombstone();
    tombstone.remove(book.bookUrl); // 网页显式加书视为用户重新加进来
    store.upsertBook(book);
    await dedupeShelf();
    // 手机解析来的书：后台预热目录与前几章，避免手机一离线就没正文
    // dedupeShelf 可能按书名把新书合并到已有条目（不同源），这里按 URL/书名双查，避免取到 null
    let saved = store.findBook(book.bookUrl);
    if (!saved) {
      saved = store.books.find((b) => b.name === book.name && (b.author || '') === (book.author || '')) || null;
    }
    if (saved && saved.viaPhone) {
      setTimeout(() => {
        prefetchPhoneBook(saved).catch(() => {});
      }, 200);
    }
    // 新加的书：缺封面/简介时后台兜底补全
    if (saved) scheduleMetaEnrich(saved.bookUrl, 1500);
    // 新加的书：后台立刻抓一次完整目录（分页也会跟），抓完广播给网页
    if (saved && !(saved.chapters && saved.chapters.length)) {
      setTimeout(() => {
        handleRefreshToc(saved)
          .then((chapters) => {
            events.broadcast({ type: 'shelf', action: 'toc', bookUrl: saved.bookUrl, count: (chapters || []).length, via: 'server' });
          })
          .catch(() => {});
      }, 100);
    }
    return json(res, 200, {
      ok: true,
      book: sanitizeBook(saved || store.findBook(book.bookUrl)),
      requestedUrl: book.bookUrl,
      replaced: saved && saved.bookUrl !== book.bookUrl ? saved.bookUrl : '',
      merged: !!(saved && saved.bookUrl !== book.bookUrl),
    });
  }

  // 书城兜底：手动补全一本书（POST /api/books/enrich {url, force}）
  if (p === '/api/books/enrich' && method === 'POST') {
    const body = await readJson(req);
    const url = String((body && body.url) || '').trim();
    if (!url) return json(res, 400, { error: '缺少 url' });
    const book = store.findBook(url);
    if (!book) return json(res, 404, { error: '书籍不存在' });
    const patch = await enrichShelfBook(url, { force: !!(body && body.force) });
    return json(res, 200, { ok: !!patch, patch: patch || null, book: sanitizeBook(store.findBook(url)) });
  }

  if (p === '/api/books' && method === 'DELETE') {
    const bookUrl = searchParams.get('url');
    if (!bookUrl) return json(res, 400, { error: '缺少 url' });
    ensureTombstone();
    const victim = store.findBook(bookUrl);
    store.removeBook(bookUrl);
    // 记墓碑，防止客户端同步把删掉的书又推回来
    tombstone.add(bookUrl, victim && victim.name);
    events.broadcast({ type: 'shelf', action: 'delete', bookUrl, via: 'web' });
    return json(res, 200, { ok: true });
  }

  // 换源：把书架里的旧书替换成新源的同一本书，避免出现两条记录
  if (p === '/api/books/switch' && method === 'POST') {
    const body = await readJson(req);
    const fromUrl = String((body && body.fromUrl) || '');
    const target = body && body.book;
    if (!fromUrl || !target || !target.bookUrl) return json(res, 400, { error: '缺少源书或目标书' });
    const old = store.findBook(fromUrl);
    const existing = store.findBook(target.bookUrl);

    if (existing) {
      // 目标书已在书架：只保留它，进度沿用旧书
      if (old && old.bookUrl !== existing.bookUrl) {
        existing.durChapterIndex = old.durChapterIndex || 0;
        existing.durChapterTitle = old.durChapterTitle || existing.durChapterTitle || '';
        existing.durChapterTime = Date.now();
        store.upsertBook(existing);
        store.removeBook(fromUrl);
      }
      return json(res, 200, { ok: true, bookUrl: existing.bookUrl, replaced: fromUrl, existed: true });
    }

    const book = {
      ...target,
      chapters: [],
      tocUrl: '',
      durChapterIndex: old ? old.durChapterIndex || 0 : 0,
      durChapterPos: old ? old.durChapterPos || 0 : 0,
      durChapterTitle: old ? old.durChapterTitle || '' : '',
      durChapterTime: Date.now(),
      totalChapterNum: 0,
    };
    store.upsertBook(book);
    if (old && old.bookUrl !== book.bookUrl) store.removeBook(fromUrl);
    return json(res, 200, { ok: true, bookUrl: book.bookUrl, replaced: fromUrl, existed: false });
  }

  if (p === '/api/progress' && method === 'POST') {
    const body = await readJson(req);
    const book = store.findBook(body.bookUrl);
    if (!book) return json(res, 404, { error: '书籍不存在' });
    book.durChapterIndex = Number(body.index) || 0;
    book.durChapterPos = Number(body.pos) || 0;
    book.durChapterTitle = body.title || book.chapters?.[book.durChapterIndex]?.title || '';
    book.durChapterTime = Date.now();
    store.upsertBook(book);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/search') return handleSearchSSE(req, res, searchParams);

  if (p === '/api/toc' && method === 'GET') {
    const bookUrl = searchParams.get('url');
    // 书架书挂了本地副本（localEbook）且当前用本地内容 → 直接读 JSON
    const shelfBookToc = store.findBook(bookUrl);
    if (shelfBookToc && shelfBookToc.localEbook && shelfBookToc.contentSource !== 'source') {
      const data = ebookRender.toc(store.dataDir, shelfBookToc.localEbook.sha1);
      if (data) {
        return json(res, 200, { ...data, localEbook: shelfBookToc.localEbook, contentSource: 'local' });
      }
    }

    // 本地电子书：只读引擎产出的 JSON，不再解析原文件
    const ebookSha = ebookRender.parseUrl(bookUrl);
    if (ebookSha) {
      const data = ebookRender.toc(store.dataDir, ebookSha);
      if (!data) return json(res, 404, { error: '电子书未解析完成' });
      return json(res, 200, data);
    }
    const book = resolveShelfBook(bookUrl);
    if (!book) return json(res, 404, { error: '书籍不存在' });
    const force = searchParams.get('refresh') === '1';
    if (!force && book.chapters && book.chapters.length) return json(res, 200, { chapters: book.chapters });
    try {
      const chapters = await handleRefreshToc(book);
      return json(res, 200, { chapters, via: book.tocVia || 'local' });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/content' && method === 'GET') {
    const bookUrl = searchParams.get('url');
    const index = Number(searchParams.get('index') || 0);
    const pageMode = searchParams.get('mode') === 'page';
    if (pageMode) {
      const shaP = ebookRender.parseUrl(bookUrl) || (store.findBook(bookUrl) && store.findBook(bookUrl).localEbook && store.findBook(bookUrl).localEbook.sha1) || '';
      const count = shaP ? ebookPages.pageCount(store.dataDir, shaP) : 0;
      if (!shaP) return json(res, 404, { error: '不是本地电子书' });
      if (!count) {
        // 客户端要原页但还没渲染：直接开始渲染，返回 409 + needPages 让前端轮询
        const entryP = ebookStore.getEntry(store.dataDir, shaP);
        let rendering = ebookPages.isRendering(shaP);
        if (entryP && entryP.file) {
          ebookPages
            .renderPages(store.dataDir, shaP, entryP.file, { dpi: 100 })
            .then((r) => events.broadcast({ type: 'ebook-pages', sha1: shaP, count: r.count }))
            .catch((e) => console.error('[legado-web] PDF 原页渲染失败:', e.message));
          rendering = true;
        }
        return json(res, 409, { error: '原页还没渲染', sha1: shaP, needPages: true, rendering });
      }
      if (index < 0 || index >= count) return json(res, 404, { error: '页号越界' });
      return json(res, 200, {
        title: `第 ${index + 1} 页`,
        index,
        total: count,
        page: index + 1,
        paragraphs: [{ k: 'img', t: `/api/ebook/page/${shaP}/${index + 1}` }],
        next: index + 1 < count ? `第 ${index + 2} 页` : '',
        prev: index > 0 ? `第 ${index} 页` : '',
        via: 'ebook-page',
      });
    }

    const shelfBookContent = store.findBook(bookUrl);
    if (shelfBookContent && shelfBookContent.localEbook && shelfBookContent.contentSource !== 'source') {
      const sha = shelfBookContent.localEbook.sha1;
      const data = ebookRender.content(store.dataDir, sha, index);
      if (data) return json(res, 200, { ...data, contentSource: 'local' });
      const local = ebookRender.toc(store.dataDir, sha);
      if (local && (local.status === 'toc-only' || local.status === 'partial')) {
        // 先让在线设备补这一章（App 有原文件，能按 index 取章）
        const got = await requestChapterFromDevice(sha, index, 20000);
        if (got.ok) {
          const data2 = ebookRender.content(store.dataDir, sha, index);
          if (data2) return json(res, 200, { ...data2, contentSource: 'local', deviceFetched: true });
        }
        return json(res, 200, { needChapter: index, sha1: sha, status: local.status, via: 'ebook-local-miss' });
      }
      return json(res, 404, { error: '章节不存在' });
    }

    const ebookShaC = ebookRender.parseUrl(bookUrl);
    if (ebookShaC) {
      const data = ebookRender.content(store.dataDir, ebookShaC, index);
      if (!data) {
        const local = ebookRender.toc(store.dataDir, ebookShaC);
        if (local && (local.status === 'toc-only' || local.status === 'partial')) {
          const got = await requestChapterFromDevice(ebookShaC, index, 20000);
          if (got.ok) {
            const data2 = ebookRender.content(store.dataDir, ebookShaC, index);
            if (data2) return json(res, 200, { ...data2, deviceFetched: true });
          }
          return json(res, 200, { needChapter: index, sha1: ebookShaC, status: local.status, via: 'ebook-local-miss' });
        }
        return json(res, 404, { error: '章节不存在' });
      }
      return json(res, 200, data);
    }
    const book = resolveShelfBook(bookUrl);
    if (!book) return json(res, 404, { error: '书籍不存在' });

    // 订阅书：抓取条目原文并转成段落
    if (String(bookUrl).startsWith('feed://')) {
      const chapter = (book.chapters || [])[index];
      if (!chapter) return json(res, 404, { error: '章节不存在' });
      try {
        const cached = chapterCache.get(chapter.url);
        const paragraphs = cached || (await getArticle(chapter.url));
        if (!cached) rememberChapter(chapter.url, paragraphs);
        return json(res, 200, { title: chapter.title, paragraphs, cached: !!cached });
      } catch (e) {
        return json(res, 502, { error: '抓取原文失败：' + (e.message || e) });
      }
    }
    if (!book.chapters || !book.chapters.length) await handleRefreshToc(book);
    if (!book.chapters[index]) return json(res, 404, { error: '章节不存在' });
    let result;
    try {
      result = await loadChapterContent(book, index);
    } catch (e) {
      const msg = String(e.message || e);
      return json(res, 502, {
        error: /Maximum call stack|递归/.test(msg) ? '书源规则递归过深，已中止解析（请检查该源的 ruleToc/ruleContent）' : msg,
      });
    }
    const chapter = book.chapters[index];
    // 后台预取后面两章，翻页时直接命中
    prefetchChapter(book, index + 1);
    prefetchChapter(book, index + 2);
    // 应用「替换 / 屏蔽」规则（去掉正文里的广告、推广信息）
    const cleaned = applyReplaceRules(book, chapter, result.paragraphs);
    const title = cleaned.title;
    const paragraphs = cleaned.paragraphs;
    return json(res, 200, {
      title,
      index,
      total: book.chapters.length,
      next: index + 1 < book.chapters.length ? book.chapters[index + 1].title : '',
      prev: index > 0 ? book.chapters[index - 1].title : '',
      paragraphs,
      cached: result.cached,
    });
  }

  if (p === '/api/download' && method === 'POST') {
    const body = await readJson(req);
    const book = store.findBook(body.url);
    if (!book) return json(res, 404, { error: '书籍不存在' });
    if (!book.chapters || !book.chapters.length) {
      try {
        await handleRefreshToc(book);
      } catch (e) {
        return json(res, 502, { error: String(e.message || e) });
      }
    }
    const job = startDownload(book);
    return json(res, 200, { ok: true, ...downloadSummary(job) });
  }

  if (p === '/api/download/status' && method === 'GET') {
    const job = downloadJobs.get(searchParams.get('url'));
    return json(res, 200, downloadSummary(job));
  }

  if (p === '/api/download/cancel' && method === 'POST') {
    const body = await readJson(req);
    const job = downloadJobs.get(body.url);
    if (job) {
      job.cancel = true;
      try {
        pyengine.killTree(job.child);
      } catch {
        /* ignore */
      }
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/download/file' && method === 'GET') {
    const bookUrl = searchParams.get('url');
    // 先看正在跑的下载任务，服务重启后回落到下载索引
    let filePath = null;
    const job = downloadJobs.get(bookUrl);
    if (job && job.file) filePath = job.file;
    if (!filePath) {
      const entry = readJSON(DOWNLOAD_INDEX, []).find((x) => x.bookUrl === bookUrl);
      if (entry) filePath = entry.file;
    }
    if (!filePath) return json(res, 404, { error: '没有这本书的下载记录' });
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return json(res, 404, { error: '文件不存在，可能已被移动或删除' });
    }
    const name = path.basename(filePath);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  if (p === '/api/image' && method === 'GET') {
    try {
      return await serveImage(res, searchParams.get('url'), searchParams.get('book'));
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  // 阅读页切换「本地副本 / 网文源」
  if (p === '/api/books/content-source' && method === 'POST') {
    const body = await readJson(req);
    const bookUrl = String((body && body.url) || '');
    const source = String((body && body.source) || '').toLowerCase();
    if (!['local', 'source'].includes(source)) return json(res, 400, { error: 'source 只能是 local / source' });
    const book = store.findBook(bookUrl);
    if (!book) return json(res, 404, { error: '书籍不在书架' });
    if (!book.localEbook) return json(res, 400, { error: '这本书没有本地副本' });
    book.contentSource = source;
    store.saveBooks(store.books);
    return json(res, 200, { ok: true, source, localEbook: book.localEbook });
  }

  // ---- 离线缓存：书架缓存章节 + 整本 TXT + 本地电子书 合并列表 ----
  if (p === '/api/offline' && method === 'GET') {
    const items = [];
    const dlIndex = readJSON(DOWNLOAD_INDEX, []);
    const byUrl = new Map(dlIndex.map((x) => [x.bookUrl, x]));
    const countCacheFiles = (dir) => {
      if (!dir) return 0;
      const full = path.isAbsolute(dir) ? dir : path.join(store.config.downloadDir || path.join(store.dataDir, 'downloads'), 'cache', dir);
      try {
        return fs.readdirSync(full).filter((f) => f.endsWith('.txt')).length;
      } catch {
        return 0;
      }
    };
    for (const b of store.books) {
      const cached = countCacheFiles(b.cachedDir);
      const dl = byUrl.get(b.bookUrl);
      const total = (b.chapters && b.chapters.length) || 0;
      const downloaded = Math.max(cached, dl ? total : 0);
      if (!downloaded && !dl) continue;
      items.push({
        kind: 'book',
        name: b.name,
        author: b.author || '',
        bookUrl: b.bookUrl,
        downloaded,
        total,
        size: dl ? dl.size : 0,
        hasTxt: !!dl,
        format: '',
        sha1: b.localEbook && b.localEbook.sha1,
      });
    }
    let ebooks = [];
    try {
      ebooks = ebookStore.loadIndex(store.dataDir);
    } catch {
      ebooks = [];
    }
    for (const e of ebooks) {
      if (e.status !== 'complete' && e.status !== 'partial') continue;
      let chapters = 0;
      let size = 0;
      try {
        const dir = path.join(store.dataDir, 'ebooks', e.sha1);
        const toc = require('./ebook/render').toc(store.dataDir, e.sha1);
        chapters = (toc && toc.chapters && toc.chapters.length) || 0;
        const st = fs.statSync(path.join(store.dataDir, 'ebooks', e.sha1, 'book.json'));
        size = st.size;
      } catch {
        /* ignore */
      }
      items.push({
        kind: 'ebook',
        name: e.name,
        author: e.author || '',
        bookUrl: 'ebook://' + e.sha1,
        downloaded: chapters,
        total: chapters,
        size,
        hasTxt: true,
        format: e.format || '',
        sha1: e.sha1,
      });
    }
    items.sort((a, b) => (b.size || 0) - (a.size || 0));
    return json(res, 200, {
      total: items.length,
      books: items.filter((x) => x.kind === 'book').length,
      ebooks: items.filter((x) => x.kind === 'ebook').length,
      items,
    });
  }

  // ---- 本地电子书导出 TXT ----
  if (p === '/api/ebook/export' && method === 'GET') {
    const sha1 = String(searchParams.get('sha1') || '').trim();
    if (!sha1) return json(res, 400, { error: '缺少 sha1' });
    const meta = ebookStore.loadIndex(store.dataDir).find((e) => e.sha1 === sha1);
    if (!meta) return json(res, 404, { error: '电子书不存在' });
    const toc = ebookRender.toc(store.dataDir, sha1);
    if (!toc || !toc.chapters || !toc.chapters.length) return json(res, 404, { error: '还没有解析出目录' });
    const parts = [];
    toc.chapters.forEach((c, i) => {
      const ch = ebookRender.content(store.dataDir, sha1, i);
      if (!ch) return;
      parts.push(String(ch.title || '').trim(), ...(ch.paragraphs || []).map((x) => String(x).trim()).filter(Boolean), '');
    });
    const text = parts.join('\n');
    const safe = String(meta.name || 'book').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 80);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safe)}.txt`,
      'Cache-Control': 'no-store',
    });
    return res.end(text);
  }

  // ---- 检查更新（GitHub 最新 release，6 小时缓存） ----
  if (p === '/api/update/check' && method === 'GET') {
    const now = Date.now();
    if (!updateCheckCache.at || now - updateCheckCache.at > 6 * 3600 * 1000) {
      updateCheckCache.at = now;
      try {
        const resp = await request(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
          headers: { 'User-Agent': 'FnReader', Accept: 'application/vnd.github+json' },
          timeout: 8000,
        });
        const j = JSON.parse(resp.body || '{}');
        updateCheckCache.latest = String(j.tag_name || '').replace(/^v/i, '').replace(/^(?:debug|alpha|beta|test)[-_]/i, '');
        updateCheckCache.url = j.html_url || '';
        updateCheckCache.notes = String(j.body || '').slice(0, 2000);
        updateCheckCache.publishedAt = j.published_at || '';
        const hit = (j.assets || []).find((a) => UPDATE_ASSET_RE.test(a.name));
        updateCheckCache.asset = hit ? (hit.browser_download_url || '') : '';
      } catch (e) {
        updateCheckCache.error = String(e.message || e);
      }
    }
    const cmp = (a, b) => {
      const pa = String(a || '0').split('.').map(Number);
      const pb = String(b || '0').split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      }
      return 0;
    };
    return json(res, 200, {
      current: APP_VERSION,
      latest: updateCheckCache.latest || '',
      hasUpdate: !!(updateCheckCache.latest && cmp(updateCheckCache.latest, APP_VERSION) > 0),
      url: updateCheckCache.url || '',
      asset: updateCheckCache.asset || '',
      notes: updateCheckCache.notes || '',
      publishedAt: updateCheckCache.publishedAt || '',
      error: updateCheckCache.error || '',
    });
  }

  // ---- 导出诊断日志（JSON，给外部模型排障用） ----
  if (p === '/api/logs/export' && method === 'GET') {
    const os = require('node:os');
    const mask = (v) => (v ? String(v).slice(0, 4) + '****' + String(v).slice(-2) : '');
    let ebooks = [];
    try {
      ebooks = require('./ebook/store').loadIndex(store.dataDir);
    } catch {
      ebooks = [];
    }
    let fileLog = [];
    try {
      const logFile = path.join(store.dataDir, 'app.log');
      if (fs.existsSync(logFile)) {
        const st = fs.statSync(logFile);
        const size = Math.min(st.size, 512 * 1024);
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
        fs.closeSync(fd);
        fileLog = buf.toString('utf8').split('\n').filter(Boolean).slice(-400);
      }
    } catch {
      /* ignore */
    }
    const rules = (() => {
      try {
        return replaceRules.load(store.dataDir);
      } catch {
        return [];
      }
    })();
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'legado-web',
      version: APP_VERSION,
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      uptimeSec: Math.round(process.uptime()),
      config: {
        theme: store.config.theme,
        fontSize: store.config.fontSize,
        lineHeight: store.config.lineHeight,
        engine: effectiveEngine(),
        engineSwitch: store.config.engine,
        pyMode: String(store.config.pyMode || 'aux'),
        pythonAux: pythonAuxEnabled(),
        ebookMode: ebookBus.ebookMode(store.config),
        treProxy: store.config.treProxy !== false,
        preferRemote: store.config.preferRemote === true,
        downloadDir: resolveDownloadDir(),
        apiToken: mask(apiToken()),
        lanIps: allLanIps(),
      },
      counts: {
        books: store.books.length,
        sources: store.sources.length,
        enabledSources: store.sources.filter((x) => x.enabled !== false).length,
        ebooks: ebooks.length,
        replaceRules: rules.length,
        replaceRulesEnabled: rules.filter((r) => r.isEnabled !== false).length,
      },
      devices: remote.listDevices(),
      replaceRules: rules.slice(0, 200),
      logs: LOG_RING.slice(-600),
      fileLog,
    };
    if (searchParams.get('download') === '1') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="legado-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json"`,
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify(payload, null, 2));
    }
    return json(res, 200, payload);
  }

  // ---- 导出书架所有书为 TXT，直接写进 ebookDir，随后自动扫描 + 去重 ----
  if (p === '/api/export/books-txt' && method === 'POST') {
    const dir = ebookScan.ebookDir(ebookCtx);
    fs.mkdirSync(dir, { recursive: true });
    const books = [...store.books];
    const written = [];
    const skipped = [];
    const sanitize = (n) => String(n || '未命名').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 80) || '未命名';

    const ebookText = (book) => {
      const sha = ebookRender.parseUrl(book.bookUrl) || (book.localEbook && book.localEbook.sha1);
      if (!sha) return '';
      const toc = ebookRender.toc(store.dataDir, sha);
      if (!toc || !toc.chapters) return '';
      const parts = [];
      toc.chapters.forEach((c, i) => {
        const ch = ebookRender.content(store.dataDir, sha, i);
        if (!ch) return;
        parts.push(ch.title, ...ch.paragraphs, '');
      });
      return parts.join('\n');
    };

    const cacheText = (book) => {
      const raw = book.cachedDir;
      if (!raw) return '';
      const full = path.isAbsolute(raw) ? raw : path.join(store.config.downloadDir || path.join(store.dataDir, 'downloads'), 'cache', raw);
      if (!fs.existsSync(full)) return '';
      let files = [];
      try {
        files = fs.readdirSync(full).filter((f) => f.endsWith('.txt')).sort();
      } catch {
        return '';
      }
      if (!files.length) return '';
      const parts = [];
      for (const f of files) {
        try {
          parts.push(f.replace(/^\d+\s*/, '').replace(/\.txt$/, ''), fs.readFileSync(path.join(full, f), 'utf8'), '');
        } catch {
          /* ignore */
        }
      }
      return parts.join('\n');
    };

    for (const b of books) {
      let text = '';
      try {
        text = ebookText(b) || cacheText(b);
      } catch {
        text = '';
      }
      if (!text || text.length < 20) {
        skipped.push(b.name);
        continue;
      }
      const name = sanitize(b.name) + '.txt';
      try {
        const dest = path.join(dir, name);
        fs.writeFileSync(dest, text, 'utf8');
        // 回拨 mtime，让紧随其后的扫描立刻收录（scan 有 20 秒保护）
        try {
          const old = Date.now() / 1000 - 120;
          fs.utimesSync(dest, old, old);
        } catch {
          /* ignore */
        }
        written.push(name);
      } catch {
        skipped.push(b.name);
      }
    }

    // 导出完自动扫描 + 去重
    let scan = null;
    let dedupe = null;
    try {
      scan = await ebookScan.scanOnce(ebookCtx);
    } catch (e) {
      scan = { error: String(e.message || e) };
    }
    try {
      dedupe = await dedupeShelf();
    } catch (e) {
      dedupe = { error: String(e.message || e) };
    }

    return json(res, 200, {
      ok: true,
      dir,
      written,
      skipped,
      scan,
      dedupe: dedupe && { removed: dedupe.removed || 0, via: dedupe.via || '' },
    });
  }

  // ---- 随包文档：列表 + Markdown 渲染 ----
  if (p === '/api/docs' && method === 'GET') {
    const wantHtml = searchParams.get('html') === '1';
    const name = String(searchParams.get('name') || '').trim();
    if (!wantHtml) {
      let files = [];
      try {
        files = fs
          .readdirSync(path.join(APP_DEST, 'web', 'docs'))
          .filter((f) => /\.md$/i.test(f))
          .map((f) => ({ name: f, title: f.replace(/\.md$/i, '') }));
      } catch {
        files = [];
      }
      return json(res, 200, { docs: files });
    }
    if (!name || !/\.md$/i.test(name) || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return json(res, 400, { error: '文档名不合法' });
    }
    try {
      const file = path.join(APP_DEST, 'web', 'docs', path.basename(name));
      if (!fs.existsSync(file)) return json(res, 404, { error: '文档不存在' });
      const text = fs.readFileSync(file, 'utf8');
      const md = require('./markdown');
      return json(res, 200, { name: path.basename(name), html: md.mdToHtml(text), bytes: text.length });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  }

  // 封面刷新：清掉本地封面缓存，前端带 ?v= 重新抓取
  if (p === '/api/covers/refresh' && method === 'POST') {
    let cleared = 0;
    for (const b of store.books) {
      if (!b.coverUrl) continue;
      const key = crypto.createHash('sha1').update(String(b.coverUrl)).digest('hex');
      const file = path.join(IMG_DIR, key);
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
          cleared++;
        } catch {
          /* ignore */
        }
      }
    }
    return json(res, 200, { ok: true, cleared, total: store.books.length });
  }

  // 电子书引擎设置：proxy（默认，手机优先）/ local（仅本机）/ off
  if (p === '/api/ebook/settings' && method === 'GET') {
    const entries = ebookStore.loadIndex(store.dataDir);
    const alive = entries.filter((e) => e.status !== 'missing');
    return json(res, 200, {
      mode: ebookBus.ebookMode(store.config),
      treProxy: store.config.treProxy !== false,
      enabled: store.config.ebookEnabled !== false,
      dir: ebookScan.ebookDir(ebookCtx),
      scanSec: Number(store.config.ebookScanSec) || 60,
      // 本机 = 已经落盘可读的（不区分解析来源）；手机 = 由设备解析的
      local: alive.filter((e) => e.status === 'complete' || e.status === 'partial' || e.status === 'toc-only').length,
      device: alive.filter((e) => e.source === 'device').length,
      skipping: entries.filter((e) => e.status === 'missing').length,
      total: alive.length,
    });
  }

  if (p === '/api/ebook/settings' && method === 'POST') {
    const body = await readJson(req);
    const mode = String((body && body.mode) || '').toLowerCase();
    if (!['proxy', 'local', 'off'].includes(mode)) return json(res, 400, { error: 'mode 只能是 proxy / local / off' });
    store.saveConfig({ ebookMode: mode, ebookEnabled: mode !== 'off' });
    return json(res, 200, { ok: true, mode, enabled: mode !== 'off' });
  }

  // 初始化引导：安装/更新后确认缓存保存位置
  if (p === '/api/setup' && method === 'GET') {
    return json(res, 200, setupState());
  }

  if (p === '/api/setup/confirm' && method === 'POST') {
    const body = await readJson(req);
    const wanted = String((body && body.cacheDir) || '').trim();
    if (!wanted.startsWith('/')) return json(res, 400, { error: '请填写绝对路径' });
    try {
      fs.mkdirSync(path.join(wanted, 'cache'), { recursive: true });
    } catch {
      /* 下面再判可写 */
    }
    if (!isWritableDir(wanted)) return json(res, 400, { error: '目录不可写：' + wanted });
    store.saveConfig({ downloadDir: wanted, setupVersion: APP_VERSION });
    events.broadcast({ type: 'setup', action: 'confirmed', cacheDir: wanted });
    return json(res, 200, { ok: true, ...setupState() });
  }

  if (p === '/api/download/dirs' && method === 'GET') {
    return json(res, 200, { dirs: allowedDownloadDirs(), current: resolveDownloadDir() });
  }

  if (p === '/api/downloads' && method === 'GET') {
    const list = readJSON(DOWNLOAD_INDEX, []).map((x) => ({ ...x, exists: fs.existsSync(x.file) }));
    return json(res, 200, { items: list });
  }

  if (p === '/api/downloads' && method === 'DELETE') {
    const bookUrl = searchParams.get('url');
    const list = readJSON(DOWNLOAD_INDEX, []);
    const item = list.find((x) => x.bookUrl === bookUrl);
    if (item) {
      try {
        fs.unlinkSync(item.file);
      } catch {
        /* 文件可能已被手动删除 */
      }
    }
    writeJSON(
      DOWNLOAD_INDEX,
      list.filter((x) => x.bookUrl !== bookUrl)
    );
    return json(res, 200, { ok: true });
  }

/** 把订阅的新条目合并进已加入书架的那本书，返回新增条数 */
function mergeFeedIntoBook(feed) {
  const bookUrl = 'feed://' + feed.url;
  const book = store.books.find((b) => b.bookUrl === bookUrl);
  if (!book) return 0;
  const chapters = (feed.items || []).map((it) => ({ title: it.title || '(无标题)', url: it.link || '' }));
  const seen = new Set((book.chapters || []).map((c) => c.url || c.title));
  const fresh = chapters.filter((c) => !seen.has(c.url || c.title));
  if (!fresh.length) return 0;
  book.chapters = fresh.concat(book.chapters || []);
  book.totalChapterNum = book.chapters.length;
  book.name = feed.title || book.name;
  store.upsertBook(book);
  return fresh.length;
}

  // 替换 / 屏蔽规则
  if (p === '/api/replace-rules' && method === 'GET') {
    const rules = replaceRules.load(store.dataDir);
    return json(res, 200, {
      total: rules.length,
      enabled: rules.filter((r) => r.isEnabled !== false).length,
      rules,
    });
  }

  if (p === '/api/replace-rules' && method === 'POST') {
    const body = await readJson(req);
    const incoming = Array.isArray(body) ? body : body && Array.isArray(body.rules) ? body.rules : null;
    if (!incoming) return json(res, 400, { error: '请提供规则数组（Legado 导出的 exportReplaceRule.json）' });
    const mode = (body && body.mode) || 'merge';
    const clean = incoming
      .filter((r) => r && typeof r === 'object' && r.pattern)
      .map((r, i) => ({
        name: String(r.name || '未命名规则'),
        group: String(r.group || ''),
        pattern: String(r.pattern),
        replacement: r.replacement == null ? '' : String(r.replacement),
        isRegex: r.isRegex !== false,
        isEnabled: r.isEnabled !== false,
        scopeContent: r.scopeContent !== false,
        scopeTitle: r.scopeTitle === true,
        order: Number(r.order) || i,
      }));

    let rules;
    if (mode === 'replace') {
      rules = clean;
    } else {
      const existing = replaceRules.load(store.dataDir);
      const seen = new Set(existing.map((r) => r.name + '|' + r.pattern));
      rules = existing.concat(clean.filter((r) => !seen.has(r.name + '|' + r.pattern)));
    }
    replaceRules.save(store.dataDir, rules);
    return json(res, 200, { ok: true, imported: clean.length, total: rules.length });
  }

  if (p === '/api/replace-rules' && method === 'PATCH') {
    const body = await readJson(req);
    const rules = replaceRules.load(store.dataDir);
    const rule = rules[Number(body.index)];
    if (!rule) return json(res, 404, { error: '规则不存在' });
    if (body.isEnabled != null) rule.isEnabled = !!body.isEnabled;
    replaceRules.save(store.dataDir, rules);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/replace-rules' && method === 'DELETE') {
    if (searchParams.get('all') === '1') {
      replaceRules.save(store.dataDir, []);
      return json(res, 200, { ok: true, total: 0 });
    }
    const index = Number(searchParams.get('index'));
    const rules = replaceRules.load(store.dataDir);
    if (!rules[index]) return json(res, 404, { error: '规则不存在' });
    rules.splice(index, 1);
    replaceRules.save(store.dataDir, rules);
    return json(res, 200, { ok: true, total: rules.length });
  }

  if (p === '/api/feeds' && method === 'GET') {
    return json(res, 200, { feeds: readJSON(FEEDS_FILE, []) });
  }

  if (p === '/api/feeds' && method === 'POST') {
    const body = await readJson(req);
    const list = readJSON(FEEDS_FILE, []);
    if (body && body.refresh) {
      const item = list.find((x) => x.id === body.refresh);
      if (!item) return json(res, 404, { error: '订阅不存在' });
      try {
        const feed = await fetchFeed(item.url);
        item.title = feed.title || item.title;
        item.link = feed.link;
        item.items = feed.items;
        item.fetchedAt = feed.fetchedAt;
        writeJSON(FEEDS_FILE, list);
        // 已加入书架的订阅，刷新后把新条目合并进同一本书
        const merged = mergeFeedIntoBook(item);
        return json(res, 200, { ok: true, feed: item, merged });
      } catch (e) {
        return json(res, 502, { error: String(e.message || e) });
      }
    }
    const url = String((body && body.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: '请填写完整的 RSS / Atom 地址' });
    try {
      const feed = await fetchFeed(url);
      const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
      const entry = {
        id,
        url,
        title: feed.title || url,
        link: feed.link,
        items: feed.items,
        fetchedAt: feed.fetchedAt,
      };
      const idx = list.findIndex((x) => x.url === url);
      if (idx >= 0) list[idx] = entry;
      else list.unshift(entry);
      writeJSON(FEEDS_FILE, list);
      return json(res, 200, { ok: true, feed: entry });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  // 订阅加入书架：同一个订阅永远对应同一本书，新条目自动合并
  if (p === '/api/feeds/to-book' && method === 'POST') {
    const body = await readJson(req);
    const list = readJSON(FEEDS_FILE, []);
    const feed = list.find((x) => x.id === body.id || x.url === body.url);
    if (!feed) return json(res, 404, { error: '订阅不存在' });

    const bookUrl = 'feed://' + feed.url;
    const chapters = (feed.items || []).map((it) => ({ title: it.title || '(无标题)', url: it.link || '' }));
    let book = store.books.find((b) => b.bookUrl === bookUrl);
    let added = 0;

    if (!book) {
      book = {
        bookUrl,
        name: feed.title || feed.url,
        author: '订阅',
        coverUrl: '',
        intro: '来自订阅：' + feed.url,
        kind: '订阅',
        origin: 'feed',
        originName: feed.title || '订阅',
        tocUrl: feed.url,
        chapters,
        durChapterIndex: 0,
        durChapterPos: 0,
        durChapterTitle: chapters[0] ? chapters[0].title : '',
        durChapterTime: Date.now(),
        totalChapterNum: chapters.length,
      };
      added = chapters.length;
    } else {
      const seen = new Set((book.chapters || []).map((c) => c.url || c.title));
      const fresh = chapters.filter((c) => !seen.has(c.url || c.title));
      // 新条目排在前面（订阅一般按时间倒序）
      book.chapters = fresh.concat(book.chapters || []);
      book.name = feed.title || book.name;
      book.originName = feed.title || book.originName;
      book.totalChapterNum = book.chapters.length;
      added = fresh.length;
    }
    store.upsertBook(book);
    return json(res, 200, { ok: true, bookUrl, name: book.name, added, total: book.chapters.length });
  }

  if (p === '/api/feeds' && method === 'DELETE') {
    const id = searchParams.get('id');
    writeJSON(
      FEEDS_FILE,
      readJSON(FEEDS_FILE, []).filter((x) => x.id !== id)
    );
    return json(res, 200, { ok: true });
  }

  if (p === '/api/searchcache' && method === 'GET') {
    return json(res, 200, searchCache.stats());
  }

  if (p === '/api/searchcache' && method === 'DELETE') {
    searchCache.clear();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/config' && method === 'GET') {
    const cfg = {
      ...store.config,
      directBase: directBase(),
      lanIp: lanIp(),
      lanIps: allLanIps().map((ip) => `http://${ip}:${process.env.TRIM_SERVICE_PORT || process.env.PORT || 1122}`),
      ipv6Lans: allLanIpv6().map((ip) => `http://[${ip}]:${process.env.TRIM_SERVICE_PORT || process.env.PORT || 1122}`),
    };
    // 令牌只给本机（fnOS 网关）或已带令牌的请求，避免局域网里随手读走
    const trusted = isLocalRequest(req) || checkApiToken(req, url);
    if (!trusted) {
      delete cfg.apiToken;
      cfg.tokenRequired = true;
    }
    return json(res, 200, cfg);
  }
  if (p === '/api/config' && method === 'POST') {
    const body = await readJson(req);
    if (body && body.downloadDir) {
      const wanted = String(body.downloadDir).trim();
      if (!wanted.startsWith('/')) return json(res, 400, { error: '请填写绝对路径，例如 /vol1/1000/Books' });
      try {
        fs.mkdirSync(wanted, { recursive: true });
      } catch {
        /* 已存在或建不了，下面再判 */
      }
      if (!isWritableDir(wanted)) return json(res, 400, { error: '目录不可写：' + wanted });
      body.downloadDir = wanted;
    }
    store.saveConfig(body || {});
    return json(res, 200, store.config);
  }

  if (p.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });

  return serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(res, 400, { error: 'bad request' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    // WebDAV 客户端需要 DAV 头，交给 dav 处理器
    if (url.pathname === '/dav' || url.pathname.startsWith('/dav/')) {
      return handleDav(
        { apiToken, readJSON, DOWNLOAD_INDEX, dataDir: store.dataDir, manifest: buildLibraryManifest },
        req,
        res,
        url,
        url.pathname,
        'OPTIONS'
      );
    }
    res.writeHead(204);
    return res.end();
  }
  route(req, res, url).catch((e) => {
    console.error('[error]', e);
    if (!res.headersSent) {
      const msg = String(e.message || e);
      const friendly = /Maximum call stack|递归/.test(msg)
        ? '书源规则递归过深，已中止解析（请检查该源的 ruleToc/ruleContent）'
        : msg;
      json(res, /Maximum call stack|递归/.test(msg) ? 502 : 500, { error: friendly });
    } else res.end();
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function main() {
  const sock = process.env.LEGADO_SOCKET || path.join(APP_DEST, 'app.sock');

  // 首次启动生成移动端访问令牌
  if (!store.config.apiToken) {
    store.saveConfig({ apiToken: crypto.randomBytes(12).toString('hex') });
  }

  // 启动时清理过期正文缓存，之后每 6 小时一次
  try {
    diskCache.prune();
  } catch {
    /* ignore */
  }
  const pruneTimer = setInterval(() => diskCache.prune(), 6 * 3600 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  if (process.platform !== 'win32') {
    try {
      fs.mkdirSync(path.dirname(sock), { recursive: true });
      if (fs.existsSync(sock)) fs.unlinkSync(sock);
      const gw = http.createServer(server.listeners('request')[0]);
      gw.listen(sock, () => console.log(`[legado-web] unix socket ${sock}`));
      gw.on('error', (e) => console.error('[legado-web] gateway socket error:', e.message));
    } catch (e) {
      console.error('[legado-web] gateway socket failed:', e.message);
    }
  }

  const tcp = http.createServer(server.listeners('request')[0]);
  
// 启动即整理一次书架：删掉墓碑里残留的、合并重复条目
(async () => {
  try {
    ensureTombstone();
    const gone = tombstone.all().map((x) => x.bookUrl);
    if (gone.length) {
      const kept = store.books.filter((b) => !gone.includes(b.bookUrl));
      if (kept.length !== store.books.length) store.saveBooks(kept);
    }
    const r = await dedupeShelf();
    if (r.removed) console.log('[legado-web] 启动去重：合并 ' + r.removed + ' 条重复书籍（' + r.via + '）');
  } catch (e) {
    console.log('[legado-web] 启动整理失败：' + e.message);
  }
})();

tcp.listen(PORT, '::', () => {
  console.log(`[legado-web] http://[::]:${PORT}（IPv4/IPv6 双栈）`);
  // 书城兜底：启动后台补全缺封面/简介的书（每次最多 6 本，顺序执行）
  if (store.config.metaFallback !== false) {
    setTimeout(async () => {
      try {
        const targets = store.books.filter((b) => metaenrich.shouldEnrich(b) && !b.metaAt).slice(0, 6);
        for (const b of targets) {
          await enrichShelfBook(b.bookUrl).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (targets.length) console.log('[legado-web] 书城兜底：处理 ' + targets.length + ' 本缺封面/简介的书');
      } catch { /* ignore */ }
    }, 15000);
  }
  // Java 21 目录引擎：默认随服务启动（设置里可关闭）
  if (store.config.javaEngine !== false) {
    javaWorker.start()
      .then((port) => console.log('[legado-web] Java 目录引擎已启动，端口 ' + port))
      .catch((e) => console.log('[legado-web] Java 目录引擎未启动：' + e.message));
  }
});
  tcp.on('error', (e) => console.error('[legado-web] tcp listen error:', e.message));

  // 本地电子书：定时扫描 + 长任务看门狗
  try {
    if (store.config.ebookEnabled !== false && ebookBus.ebookMode(store.config) !== 'off') {
      ebookScan.start(ebookCtx, (Number(store.config.ebookScanSec) || 60) * 1000);
      ebookBus.startWatchdog(ebookCtx);
      setTimeout(() => linkLocalEbooksToShelf(), 4000);
      console.log('[legado-web] 本地电子书引擎已启动，目录: ' + ebookScan.ebookDir(ebookCtx));
    }
  } catch (e) {
    console.error('[legado-web] 电子书引擎启动失败:', e.message);
  }

  // 单个请求/任务出错不应该拖垮整个服务
  process.on('unhandledRejection', (e) => console.error('[legado-web] unhandledRejection:', e && e.message ? e.message : e));
  process.on('uncaughtException', (e) => console.error('[legado-web] uncaughtException:', e && e.message ? e.message : e));

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

main();
