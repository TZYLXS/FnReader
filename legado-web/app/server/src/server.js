'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const store = require('./store');
const diskCache = require('./cache');
const { execFileSync } = require('node:child_process');
const { normalizeSource } = require('./books');
const { searchSource, getBookInfo, getToc, getContent } = require('./books');
const { request, requestBinary, absoluteUrl } = require('./util');
const { fetchFeed } = require('./feeds');
const { detectAcademic } = require('./academic');
const { handleDav } = require('./dav');
const searchCache = require('./searchcache');

const APPNAME = process.env.TRIM_APPNAME || 'legado-web';
const WEB_DIR = path.resolve(process.env.LEGADO_WEB || path.join(__dirname, '..', 'web'));
const PORT = Number(process.env.TRIM_SERVICE_PORT || process.env.PORT || 1122);
const APP_DEST = process.env.TRIM_APPDEST || path.join(process.cwd(), 'target');
const APP_VERSION = process.env.TRIM_APPVER || '1.6.8';
const BUILD_ID = process.env.TRIM_APPVER || '1.6.8';

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
  if (contentCache.size > 300) contentCache.delete(contentCache.keys().next().value);
  contentCache.set(key, val);
}

const prefetching = new Set();
const inflight = new Map(); // 同一章并发请求只抓一次

/** 取章节正文：内存 → 磁盘 → 网络 */
async function loadChapterContent(book, index) {
  const chapter = book.chapters[index];
  if (!chapter) throw new Error('章节不存在');
  const key = chapter.url || `${book.bookUrl}#${index}`;
  const mem = cacheGet(key);
  if (mem) return { paragraphs: mem, cached: true };
  const disk = diskCache.get(key);
  if (disk && disk.paragraphs) {
    cacheSet(key, disk.paragraphs);
    return { paragraphs: disk.paragraphs, cached: true };
  }
  if (inflight.has(key)) {
    const paragraphs = await inflight.get(key);
    return { paragraphs, cached: true };
  }
  const source = store.findSource(book.origin);
  if (!source) throw new Error('书源不存在');
  const promise = getContent(source, book, chapter).then((paragraphs) => {
    cacheSet(key, paragraphs);
    diskCache.set(key, { paragraphs, title: chapter.title });
    return paragraphs;
  });
  inflight.set(key, promise);
  try {
    const paragraphs = await promise;
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
  const { chapters, ...rest } = book;
  return { ...rest, chapterCount: chapters ? chapters.length : book.chapterCount || 0 };
}

/* ---------------- 业务处理 ---------------- */

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

  let sources = store.sources.filter((s) => s.enabled);

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
  let cursor = 0;
  let found = 0;
  let doneCount = 0;
  const worker = async () => {
    while (!closed) {
      const i = cursor++;
      if (i >= sources.length) return;
      const source = sources[i];
      const startedAt = Date.now();
      send({ type: 'source-start', source: source.bookSourceName, id: source.bookSourceUrl });
      try {
        const books = await searchSource(source, key, 1);
        if (closed) return;
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
        });
      } catch (e) {
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
    if (!closed) {
      send({ type: 'done', found });
      res.end();
    }
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
    file: job.file ? path.basename(job.file) : '',
    error: job.error || '',
  };
}

/** 后台把整本书抓成 txt（复用正文缓存，2 并发） */
function startDownload(book) {
  const existing = downloadJobs.get(book.bookUrl);
  if (existing && existing.running) return existing;

  const job = {
    running: true,
    done: 0,
    total: book.chapters.length,
    failed: 0,
    file: null,
    error: '',
    cancel: false,
  };
  downloadJobs.set(book.bookUrl, job);

  (async () => {
    const chunks = [];
    chunks.push({
      i: -1,
      text: `${book.name}\n作者：${book.author || '未知'}\n来源：${book.originName || book.origin || ''}\n`,
    });
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
        // 每几章让出一次事件循环，保证下载期间网页仍然可用
        if (job.done % 5 === 0) await new Promise((r) => setImmediate(r));
      }
    };
    try {
      await Promise.all([worker(), worker()]);
      if (job.cancel) {
        job.error = '已取消';
        return;
      }
      const outDir = resolveDownloadDir();
      fs.mkdirSync(outDir, { recursive: true });
      chunks.sort((a, b) => a.i - b.i);
      const text = '\uFEFF' + chunks.map((c) => c.text).join('');
      const file = path.join(outDir, `${safeFileName(book.name)}.txt`);
      fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o644 });
      try {
        fs.chmodSync(file, 0o644);
      } catch {
        /* 某些文件系统不支持 chmod */
      }
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

/* ---------------- 移动端接入 API ---------------- */
// 供安卓 App / 第三方客户端读取书架、目录、正文
function apiToken() {
  if (!store.config.apiToken) store.saveConfig({ apiToken: crypto.randomBytes(12).toString('hex') });
  return store.config.apiToken;
}

function checkApiToken(req, url) {
  const t = req.headers['x-api-token'] || url.searchParams.get('token');
  return !!t && t === apiToken();
}

/* ---------------- 应用内更新 ---------------- */
const UPDATE_REPO = 'TZYLXS/FnReader';
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

async function fetchLatestRelease(force) {
  if (!force && updateCache.data && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.data;
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'FnReader', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => /\.fpk$/i.test(a.name)) || null;
  const data = {
    tag: rel.tag_name,
    version: String(rel.tag_name || '').replace(/^v/i, ''),
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
  let sources = store.sources.filter((s) => s.enabled && s.checkStatus === 'ok');
  if (group) sources = sources.filter((s) => (s.bookSourceGroup || '') === group);
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

async function handleRefreshToc(book) {
  const source = store.findSource(book.origin);
  if (!source) throw new Error('未找到书源，可能已被删除');
  if (!book.tocUrl) await getBookInfo(source, book);
  const chapters = await getToc(source, book);
  store.upsertBook(book);
  // 拿到目录后先把「当前阅读位置」和第一章缓存起来
  prefetchChapter(book, book.durChapterIndex || 0);
  if (!book.durChapterIndex) prefetchChapter(book, 1);
  return chapters;
}

async function route(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method.toUpperCase();

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
    return json(res, 200, { ok: true, app: APPNAME, version: APP_VERSION, build: BUILD_ID });

  if (p === '/api/m/info') {
    if (!checkApiToken(req, url)) return json(res, 401, { error: 'token 无效' });
    return json(res, 200, {
      app: '阅读',
      version: APP_VERSION,
      tokenRequired: true,
      endpoints: ['/api/m/shelf', '/api/m/search', '/api/m/toc', '/api/m/content', '/api/m/progress', '/api/m/cover'],
    });
  }

  if (p === '/api/update/check' && method === 'GET') {
    try {
      const rel = await fetchLatestRelease(searchParams.get('force') === '1');
      return json(res, 200, {
        current: APP_VERSION,
        latest: rel.version,
        hasUpdate: semverGt(rel.version, APP_VERSION),
        name: rel.name,
        notes: rel.body,
        publishedAt: rel.publishedAt,
        htmlUrl: rel.htmlUrl,
        asset: rel.asset,
      });
    } catch (e) {
      return json(res, 502, { error: '检查更新失败：' + (e.message || e) });
    }
  }

  if (p === '/api/update/download' && method === 'POST') {
    try {
      const rel = await fetchLatestRelease(true);
      if (!rel.asset) return json(res, 404, { error: '最新版本没有附带 fpk 文件' });
      if (!semverGt(rel.version, APP_VERSION)) {
        return json(res, 200, { ok: true, upToDate: true, current: APP_VERSION, latest: rel.version });
      }
      const dir = path.join(store.dataDir, 'updates');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `legado-web-${rel.version}.fpk`);
      const r = await fetch(rel.asset.url, {
        headers: { 'User-Agent': 'FnReader' },
        redirect: 'follow',
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
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

  if (p.startsWith('/api/m/') && !checkApiToken(req, url)) {
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
      return json(res, 200, {
        bookUrl: book.bookUrl,
        title: chapter.title,
        index,
        total: book.chapters.length,
        prev: index > 0 ? book.chapters[index - 1].title : '',
        next: index + 1 < book.chapters.length ? book.chapters[index + 1].title : '',
        paragraphs: result.paragraphs,
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
    return json(res, 200, { ok: true });
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
      map.set(s.bookSourceUrl, { ...(map.get(s.bookSourceUrl) || {}), ...s, enabled: true });
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
      list[idx] = { ...list[idx], enabled: body.enabled !== false };
    }
    store.saveSources(list);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/books' && method === 'GET') {
    const books = [...store.books].sort((a, b) => (b.durChapterTime || 0) - (a.durChapterTime || 0));
    return json(res, 200, { books: books.map(sanitizeBook) });
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
    store.upsertBook(book);
    return json(res, 200, { ok: true, book: sanitizeBook(store.findBook(book.bookUrl)) });
  }

  if (p === '/api/books' && method === 'DELETE') {
    const bookUrl = searchParams.get('url');
    if (!bookUrl) return json(res, 400, { error: '缺少 url' });
    store.removeBook(bookUrl);
    return json(res, 200, { ok: true });
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
    const book = store.findBook(bookUrl);
    if (!book) return json(res, 404, { error: '书籍不存在' });
    const force = searchParams.get('refresh') === '1';
    if (!force && book.chapters && book.chapters.length) return json(res, 200, { chapters: book.chapters });
    try {
      const chapters = await handleRefreshToc(book);
      return json(res, 200, { chapters });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/content' && method === 'GET') {
    const bookUrl = searchParams.get('url');
    const index = Number(searchParams.get('index') || 0);
    const book = store.findBook(bookUrl);
    if (!book) return json(res, 404, { error: '书籍不存在' });
    if (!book.chapters || !book.chapters.length) await handleRefreshToc(book);
    if (!book.chapters[index]) return json(res, 404, { error: '章节不存在' });
    let result;
    try {
      result = await loadChapterContent(book, index);
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
    const chapter = book.chapters[index];
    // 后台预取后面两章，翻页时直接命中
    prefetchChapter(book, index + 1);
    prefetchChapter(book, index + 2);
    return json(res, 200, {
      title: chapter.title,
      index,
      total: book.chapters.length,
      next: index + 1 < book.chapters.length ? book.chapters[index + 1].title : '',
      prev: index > 0 ? book.chapters[index - 1].title : '',
      paragraphs: result.paragraphs,
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
    if (job) job.cancel = true;
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
        return json(res, 200, { ok: true, feed: item });
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

  if (p === '/api/config' && method === 'GET') return json(res, 200, store.config);
  if (p === '/api/config' && method === 'POST') {
    const body = await readJson(req);
    if (body && body.downloadDir) {
      const ok = allowedDownloadDirs().some((d) => d.path === body.downloadDir);
      if (!ok) return json(res, 400, { error: '该目录未授权，请先在 fnOS 应用设置里授权文件夹' });
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
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else res.end();
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
  tcp.listen(PORT, '0.0.0.0', () => console.log(`[legado-web] http://0.0.0.0:${PORT}`));
  tcp.on('error', (e) => console.error('[legado-web] tcp listen error:', e.message));

  // 单个请求/任务出错不应该拖垮整个服务
  process.on('unhandledRejection', (e) => console.error('[legado-web] unhandledRejection:', e && e.message ? e.message : e));
  process.on('uncaughtException', (e) => console.error('[legado-web] uncaughtException:', e && e.message ? e.message : e));

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

main();
