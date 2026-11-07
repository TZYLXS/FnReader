'use strict';
// 书源模型与抓取流程：搜索 / 详情 / 目录 / 正文
const { request, absoluteUrl, htmlToParagraphs } = require('./util');
const { makeDoc, evalString, evalRule } = require('./rules');
const { runJs } = require('./jsrules');
const searchCache = require('./searchcache');
const { fixChapterOrder } = require('./chapter-order');

const DEFAULT_SEARCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function parseHeaders(header) {
  if (!header) return {};
  if (typeof header === 'object') return header;
  try {
    const obj = JSON.parse(header);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** 解析形如 url,{"method":"POST"} 的配置（兼容单引号/换行的 JS 对象字面量） */
function parseConfig(text) {
  const t = String(text || '').trim();
  try {
    return JSON.parse(t);
  } catch {
    /* 继续尝试 */
  }
  try {
    const vm = require('node:vm');
    const v = vm.runInNewContext(`(${t})`, Object.create(null), { timeout: 1000 });
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function parseUrlWithConfig(raw) {
  const s = String(raw || '').trim();
  let idx = s.indexOf(',{');
  while (idx >= 0) {
    const cfg = parseConfig(s.slice(idx + 1));
    if (cfg) return { url: s.slice(0, idx).trim(), config: cfg };
    idx = s.indexOf(',{', idx + 2);
  }
  return { url: s, config: {} };
}

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

function sourceId(source) {
  return source.bookSourceUrl || source.bookSourceName;
}

function normalizeSource(raw) {
  const s = { ...raw };
  s.bookSourceUrl = String(s.bookSourceUrl || '').trim();
  s.bookSourceName = String(s.bookSourceName || s.bookSourceUrl || '未命名书源').trim();
  s.bookSourceGroup = s.bookSourceGroup || '';
  s.enabled = s.enabled !== false;
  s.header = s.header || '';
  s.searchUrl = s.searchUrl || '';
  s.ruleSearch = s.ruleSearch || {};
  s.ruleBookInfo = s.ruleBookInfo || {};
  s.ruleToc = s.ruleToc || {};
  s.ruleContent = s.ruleContent || {};
  s.type = Number(s.bookSourceType || 0);
  // 供 @js: 规则调用的 Legado 兼容方法
  s.getKey = () => s.bookSourceUrl;
  s.getLoginHeader = () => null;
  s.getVariable = () => '';
  s.getBookSourceUrl = () => s.bookSourceUrl;
  return s;
}

async function fetchPage(url, source, extra = {}) {
  const headers = { ...DEFAULT_SEARCH_HEADERS, ...parseHeaders(source.header), ...(extra.headers || {}) };
  try {
    return await request(url, { ...extra, headers, referer: extra.referer });
  } catch (e) {
    throw new Error(`请求失败 ${String(url).slice(0, 120)}：${e.message}`);
  }
}

/** 搜索一本书 */
/** 过滤期刊/杂志期号这类噪音结果（如「2026年第11期」「2025-03-01」） */
const PERIODICAL_RE = /^\s*\d{4}\s*年\s*(第\s*)?\d{1,2}\s*期/;
const DATE_ONLY_RE = /^\s*\d{4}[-./年]\s*\d{1,2}([-./月]\s*\d{1,2})?\s*(日|号)?\s*$/;

function isJunkResult(name, author) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (PERIODICAL_RE.test(n)) return true;
  if (DATE_ONLY_RE.test(n)) return true;
  const a = String(author || '').trim();
  if (/第\s*\d{1,3}\s*期\s*$/.test(n) && n.length <= 20 && (!a || a === '未知作者' || a === '未知')) return true;
  return false;
}

async function searchSource(source, key, page = 1, opts = {}) {
  if (!source.searchUrl) throw new Error('书源未配置搜索地址');
  if (source.ruleSearch && source.ruleSearch.checkKeyWord) {
    // 预留：校验关键字规则
  }
  let { url: tpl, config } = parseUrlWithConfig(source.searchUrl);
  if (/^\s*<js>/i.test(tpl) || /^\s*@js:/i.test(tpl)) {
    const code = tpl
      .replace(/^\s*<js>/i, '')
      .replace(/<\/js>\s*$/i, '')
      .replace(/^\s*@js:/i, '');
    tpl = String(
      runJs(code, { result: '', baseUrl: source.bookSourceUrl, source, key, page, getString: () => '' }) || ''
    ).trim();
  }
  const vars = { key: encodeURIComponent(key), page };
  const url = absoluteUrl(source.bookSourceUrl, fillTemplate(tpl, vars));
  const method = (config.method || 'GET').toUpperCase();
  const body = method === 'POST' ? fillTemplate(config.body || '', vars) : null;

  // 命中缓存就直接返回（同一个搜索请求 URL 只抓一次）
  const cached = searchCache.get(url, body);
  if (cached) {
    const list = cached.map((b) => ({ ...b }));
    list.fromCache = true;
    return list;
  }
  const resp = await fetchPage(url, source, {
    method,
    body,
    headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
    charset: config.charset || null,
    timeout: opts.timeout || 15000,
  });

  const doc = makeDoc(resp.body);
  const rule = source.ruleSearch || {};
  const bookListRule = rule.bookList || 'body';
  const baseCtx = { doc, json: tryJson(resp.body), baseUrl: resp.url, source, key };

  const listNodes = evalRule(bookListRule, baseCtx).nodes;
  const books = [];
  for (const node of listNodes) {
    const local = { ...baseCtx, book: null, vars: {} };
    const get = (r, joinAll = false) => (r ? evalString(r, local, { scope: node, joinAll }) : '');
    const name = get(rule.name);
    const bookUrl = get(rule.bookUrl);
    if (!name && !bookUrl) continue;
    if (isJunkResult(name, get(rule.author))) continue;
    const absolute = absoluteUrl(resp.url, bookUrl);
    if (!/^https?:/i.test(absolute)) continue;
    books.push({
      name: name || '未知书名',
      author: get(rule.author) || '未知作者',
      kind: get(rule.kind) || '',
      intro: get(rule.introduce) || '',
      lastChapter: get(rule.lastChapter) || '',
      updateTime: get(rule.updateTime) || '',
      wordCount: get(rule.wordCount) || '',
      coverUrl: absoluteUrl(resp.url, get(rule.coverUrl)),
      bookUrl: absolute,
      origin: sourceId(source),
      originName: source.bookSourceName,
      tocUrl: '',
      chapters: [],
      durChapterIndex: 0,
      durChapterPos: 0,
      durChapterTitle: '',
      durChapterTime: 0,
      totalChapterNum: 0,
      group: 0,
      order: Date.now(),
    });
  }
  searchCache.set(url, body, books);
  return books;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 补全书籍详情（封面/简介/目录地址） */
async function getBookInfo(source, book, opts = {}) {
  const url = book.bookUrl;
  const resp = await fetchPage(url, source, { charset: null });
  const doc = makeDoc(resp.body);
  const rule = source.ruleBookInfo || {};
  const ctx = { doc, json: tryJson(resp.body), baseUrl: resp.url, source, book };

  if (rule.init) evalRule(rule.init, ctx);

  const get = (r) => (r ? evalString(r, ctx) : '');
  const patch = {};
  for (const [field, ruleName] of [
    ['name', 'name'],
    ['author', 'author'],
    ['kind', 'kind'],
    ['lastChapter', 'lastChapter'],
    ['updateTime', 'updateTime'],
    ['wordCount', 'wordCount'],
    ['intro', 'introduce'],
  ]) {
    const v = get(rule[ruleName]);
    if (v) patch[field] = v;
  }
  const cover = get(rule.coverUrl);
  if (cover) patch.coverUrl = absoluteUrl(resp.url, cover);
  const tocUrl = get(rule.tocUrl);
  const toc = tocUrl ? absoluteUrl(resp.url, tocUrl) : resp.url;
  Object.assign(book, patch, { tocUrl: toc });
  return book;
}

/** 拉取目录 */
async function parseTocFrom(startUrl, source, book) {
  let chapters = [];
  let pageGuard = 0;
  let nextUrl = startUrl;

  while (nextUrl && pageGuard < 5) {
    pageGuard++;
    const resp = await fetchPage(nextUrl, source, {});
    const doc = makeDoc(resp.body);
    const ctx = { doc, json: tryJson(resp.body), baseUrl: resp.url, source, book };
    const rule = source.ruleToc || {};
    if (rule.init) evalRule(rule.init, ctx);
    if (rule.formatJs) evalRule(rule.formatJs, ctx);

    const listRule = rule.chapterList || 'body';
    const listNodes = evalRule(listRule, ctx).nodes;
    for (const node of listNodes) {
      const local = { ...ctx, vars: {} };
      const name = rule.chapterName ? evalString(rule.chapterName, local, { scope: node }) : '';
      let href = rule.chapterUrl ? evalString(rule.chapterUrl, local, { scope: node }) : '';
      if (!href) {
        const $ = doc.$;
        href = $(node).find('a').attr('href') || '';
      }
      if (!name) continue;
      chapters.push({
        index: chapters.length,
        title: name.trim(),
        url: absoluteUrl(resp.url, href),
      });
    }

    nextUrl = '';
    if (rule.nextTocUrl) {
      const next = evalString(rule.nextTocUrl, ctx);
      if (next) nextUrl = absoluteUrl(resp.url, next);
    }
  }

  // 去重（分页可能重复返回同一批）
  const seen = new Set();
  const unique = [];
  for (const c of chapters) {
    if (c.url) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
    }
    unique.push(c);
  }
  // 有些站点「最新章节」在最前，翻回正常阅读顺序
  const ordered = fixChapterOrder(unique);
  ordered.forEach((c, i) => {
    c.index = i;
  });
  return ordered;
}

/** 目录只有「最新章节」时，找页面上的「全部章节 / 完整目录」链接再抓一次 */
const FULL_TOC_TEXT = /(全部|完整|查看|展开|更多)\s*(章节|目录)|章节列表|全部目录|查看目录/;

async function findFullTocUrls(source, book) {
  const urls = [];
  const pageUrl = book.tocUrl || book.bookUrl;

  // 1) 页面上的「全部章节 / 完整目录」链接
  try {
    const resp = await fetchPage(pageUrl, source, {});
    const $ = makeDoc(resp.body).$;
    $('a').each((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (!href || !text || text.length > 12) return;
      if (FULL_TOC_TEXT.test(text)) {
        const abs = absoluteUrl(resp.url, href);
        if (abs && !urls.includes(abs)) urls.push(abs);
      }
    });
  } catch {
    /* ignore */
  }

  // 2) 常见完整目录地址：<书页>/index.html
  for (const base of [book.bookUrl, book.tocUrl]) {
    if (!base) continue;
    const dir = base.replace(/[^/]*$/, '');
    for (const name of ['index.html', 'all.html']) {
      const abs = dir + name;
      if (/^https?:/i.test(abs) && !urls.includes(abs) && abs !== pageUrl) urls.push(abs);
    }
  }
  return urls.slice(0, 3);
}

async function getToc(source, book, opts = {}) {
  const tocUrl = book.tocUrl || book.bookUrl;
  let chapters = await parseTocFrom(tocUrl, source, book);

  // 少于 30 章且像「最新章节」列表时，尝试找完整目录
  if (chapters.length > 0 && chapters.length <= 30) {
    const candidates = await findFullTocUrls(source, book).catch(() => []);
    const oldUrls = new Set(chapters.map((c) => c.url));
    for (const fullUrl of candidates) {
      const more = await parseTocFrom(fullUrl, source, book).catch(() => []);
      // 只有「明显更全」且仍包含原来的章节时才采用
      if (more.length > chapters.length * 1.5) {
        const hit = more.filter((c) => oldUrls.has(c.url)).length;
        if (hit >= Math.ceil(chapters.length * 0.5)) {
          chapters = more;
          break;
        }
      }
    }
  }

  if (!chapters.length) throw new Error('目录为空，可能书源规则不匹配或站点改版');
  return chapters;
}

async function getContent(source, book, chapter) {
  const rule = source.ruleContent || {};
  let url = chapter.url;
  let paragraphs = [];
  let guard = 0;

  while (url && guard < 4) {
    guard++;
    const resp = await fetchPage(url, source, { referer: book.bookUrl });
    const doc = makeDoc(resp.body);
    const ctx = { doc, json: tryJson(resp.body), baseUrl: resp.url, source, book };

    // 说明：webJs 需要执行页面脚本，部分源会在其中调用阻塞式 java.ajax，
    // 在服务端会卡死事件循环，这里默认跳过（正文本就很少依赖它）。
    if (rule.sourceRegex) {
      const re = new RegExp(rule.sourceRegex, 's');
      const m = resp.body.match(re);
      if (m && m[1]) {
        ctx.doc = makeDoc(m[1]);
      }
    }

    const contentRule = rule.content || 'body';
    const html = evalRule(contentRule, ctx, { joinAll: true });
    let htmlText = '';
    if (html.nodes && html.nodes.length) {
      const $ = ctx.doc.$;
      htmlText = html.nodes.map((n) => (n.type === 'tag' ? $(n).html() : '')).join('\n');
    }
    if (!htmlText) htmlText = html.values.join('\n');

    let part = htmlToParagraphs(htmlText);
    if (part.length <= 1) {
      // 没有 HTML 结构时，按 text 规则取
      part = htmlToParagraphs(html.values.join('\n'));
    }
    paragraphs.push(...part);

    url = '';
    if (rule.nextContentUrl) {
      const next = evalString(rule.nextContentUrl, ctx);
      if (next) url = absoluteUrl(resp.url, next);
    }
  }

  if (rule.replaceRegex) paragraphs = paragraphs.map((p) => applyReplaceRules(p, rule.replaceRegex));
  return paragraphs.filter((p) => p && p.trim().length > 0);
}

module.exports = {
  isJunkResult,
  normalizeSource,
  sourceId,
  searchSource,
  getBookInfo,
  getToc,
  getContent,
  parseUrlWithConfig,
};
