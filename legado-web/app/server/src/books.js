'use strict';
// 书源模型与抓取流程：搜索 / 详情 / 目录 / 正文
const { request, absoluteUrl, htmlToParagraphs } = require('./util');
const { makeDoc, evalString, evalRule, jsonPath } = require('./rules');
const { runJs } = require('./jsrules');
const searchCache = require('./searchcache');
const { fixChapterOrder, normalizeChapterList } = require('./chapter-order');

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

function fillTemplate(tpl, vars, ctx) {
  const text = String(tpl || '');
  const jsonOf = () => (ctx && (ctx.json !== undefined ? ctx.json : ctx));
  const interp = (expr) => {
    const e = String(expr).trim();
    if (!e) return '';
    // {{key}} / {{page}} 之类的简单变量
    if (/^[\w.]+$/.test(e) && !e.startsWith('$')) {
      const v = vars[e];
      return v === undefined || v === null ? '' : String(v);
    }
    const json = jsonOf();
    // $.a.b / $..a[*] 之类的 JSONPath
    if (e.startsWith('$')) {
      try {
        const v = jsonPath(json, e);
        if (Array.isArray(v) && v.length === 1) return v[0] == null ? '' : String(v[0]);
        if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x))).join(',');
        return v == null ? '' : String(v);
      } catch {
        return '';
      }
    }
    // 其余当 JS 表达式跑（含 java.* 调用）
    try {
      const out = runJs('return (' + e + ')', {
        json,
        java: undefined,
        result: json,
        baseUrl: ctx && ctx.baseUrl,
        book: ctx && ctx.book,
        source: ctx && ctx.source,
        key: ctx && ctx.key,
      });
      return out == null ? '' : String(out);
    } catch {
      return '';
    }
  };

  return text
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, e) => interp(e))
    .replace(/\{\s*(\$(?:\.[^}\s]+|\.\.[^}\s]+)*)\s*\}/g, (m, e) => interp(e));
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


/** 正文净化：##正则##替换 / ##正则 只取匹配 / ###正则##替换 只替首个 */
function applyReplaceRules(text, rule) {
  const raw = String(rule == null ? '' : rule);
  if (!raw.trim() || !String(text)) return text;
  const firstOnly = raw.startsWith('###');
  const body = firstOnly ? raw.slice(3) : raw.replace(/^##/, '');
  const parts = body.split('##');
  const pattern = parts[0];
  if (!pattern) return text;
  const isExtract = parts.length === 1;
  let re;
  try {
    // 只取匹配时必须用非全局正则，否则拿不到捕获组
    re = new RegExp(pattern, firstOnly || isExtract ? '' : 'g');
  } catch {
    return text;
  }
  if (!isExtract) return String(text).replace(re, parts[1] || '');
  const m = String(text).match(re);
  if (!m) return '';
  return m[1] !== undefined ? m[1] : m[0];
}

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
  const tplCtx = { json: null, baseUrl: source.bookSourceUrl, source, key };
  const url = absoluteUrl(source.bookSourceUrl, fillTemplate(tpl, vars, tplCtx));
  const method = (config.method || 'GET').toUpperCase();
  const body = method === 'POST' ? fillTemplate(config.body || '', vars, tplCtx) : null;

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

  // tocUrl 里可能有 {{$.field}} 模板（QQ阅读这类接口书源），要用详情页 JSON 填值
  const fillTpl = (text) =>
    String(text || '').replace(/\{\{\s*\$([^{}]*?)\s*\}\}/g, (m, expr) => {
      const key = expr.replace(/^\./, '');
      if (!key) return '';
      try {
        const v = jsonPath(ctx.json, key)[0];
        if (v === undefined || v === null) return m;
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      } catch {
        return m;
      }
    });

  const rawTocUrl = fillTpl(get(rule.tocUrl));
  const tocUrl = rawTocUrl && !/\{\{/.test(rawTocUrl) ? rawTocUrl : '';
  const toc = tocUrl ? absoluteUrl(resp.url, tocUrl) : resp.url;
  Object.assign(book, patch, { tocUrl: toc });
  return book;
}

/** 拉取目录 */
async function parseTocFrom(startUrl, source, book) {
  let chapters = [];
  let pageGuard = 0;
  let nextUrl = startUrl;
  const visitedTocPages = new Set();

  // 目录可能分很多页：上限放宽到 40，并做循环检测 + 无新增即停
  while (nextUrl && pageGuard < 40) {
    if (visitedTocPages.has(nextUrl)) break;
    visitedTocPages.add(nextUrl);
    pageGuard++;
    const chaptersBeforePage = chapters.length;
    const resp = await fetchPage(nextUrl, source, {});
    const doc = makeDoc(resp.body);
    const ctx = { doc, json: tryJson(resp.body), baseUrl: resp.url, source, book };
    const rule = source.ruleToc || {};
    if (rule.init) evalRule(rule.init, ctx);

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
    // 书源没写 nextTocUrl，但页面自己有「下一页」链接时兜底跟一页
    if (!nextUrl) {
      const $ = doc.$;
      let found = '';
      $('a').each((i, el) => {
        if (found) return;
        const t = $(el).text().replace(/\s+/g, '');
        const href = $(el).attr('href') || '';
        if (!href) return;
        if (/^(下一页|下页|下一頁|下一页»|下一页>|next|›|»)$/i.test(t)) found = absoluteUrl(resp.url, href);
      });
      if (found && !visitedTocPages.has(found)) nextUrl = found;
    }

    // 这一页没有拿到任何新章节，说明翻页逻辑已经空了，停止
    if (chapters.length === chaptersBeforePage) nextUrl = '';

    // 目录格式化：formatJs 拿 result（本页标题按行拼接）返回处理后文本
    if (rule.formatJs && chapters.length) {
      try {
        const pageStart = chapters.length - listNodes.length;
        const before = chapters.slice(0, pageStart);
        const current = chapters.slice(pageStart);
        const text = current.map((c) => c.title).join('\n');
        const out = runJs(rule.formatJs, { result: text, baseUrl: resp.url, source, book });
        const lines = String(out || '')
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean);
        if (lines.length === current.length) {
          current.forEach((c, i) => {
            c.title = lines[i];
          });
        }
      } catch {
        /* formatJs 失败不影响主流程 */
      }
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
  const ordered = normalizeChapterList(fixChapterOrder(unique));
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

    // 正文规则：支持 `规则<js>代码</js>@@选择器@@选择器` 的链式写法
    const rawRule = String(rule.content || 'body');
    const segments = rawRule.split('@@');
    let head = segments[0];
    let jsCode = '';
    const jsMatch = head.match(/<js>([\s\S]*?)<\/js>/i);
    if (jsMatch) {
      jsCode = jsMatch[1];
      head = head.replace(jsMatch[0], '').trim();
    }
    const html = evalRule(head || 'body', ctx, { joinAll: true });
    let htmlText = '';
    if (html.nodes && html.nodes.length) {
      const $ = ctx.doc.$;
      htmlText = html.nodes.map((n) => (n.type === 'tag' ? $(n).html() : '')).join('\n');
    }
    if (!htmlText) htmlText = html.values.join('\n');

    // <js>result</js>：对取到的文本做二次加工
    if (jsCode) {
      try {
        const out = runJs(jsCode, { result: htmlText, baseUrl: ctx.baseUrl, source, book });
        if (out != null) htmlText = String(out);
      } catch {
        /* 脚本失败就用原文本 */
      }
    }

    // @@ 之后的每一段都是对文本再做一次 HTML 选择
    for (const extra of segments.slice(1)) {
      const sel = extra.trim();
      if (!sel || !htmlText) continue;
      const sub = makeDoc(htmlText);
      const picked = evalRule(sel, { doc: sub, json: htmlText, baseUrl: ctx.baseUrl, source, book });
      const $s = sub.$;
      const text =
        picked.nodes && picked.nodes.length
          ? picked.nodes.map((n) => (n.type === 'tag' ? $s(n).text() : '')).join('\n')
          : picked.values.join('\n');
      if (text) htmlText = text;
    }

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
  applyReplaceRules,
  isJunkResult,
  normalizeSource,
  sourceId,
  searchSource,
  getBookInfo,
  getToc,
  getContent,
  parseUrlWithConfig,
};
