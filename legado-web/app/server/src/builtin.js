'use strict';
// 内置书源：微信读书 / 起点中文网
// 登录信息（Cookie）由用户在「设置 → 账号接入」里填写，存 config.accounts，只在本机使用。
const store = require('./store');

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

const SITES = {
  'builtin://weread': { kind: 'weread', name: '微信读书', home: 'https://weread.qq.com/' },
  'builtin://qidian': { kind: 'qidian', name: '起点中文网', home: 'https://www.qidian.com/' },
};

function siteOf(source) {
  return SITES[(source && source.bookSourceUrl) || ''] || null;
}

function isBuiltin(source) {
  return !!siteOf(source);
}

function account(kind) {
  const list = (store.config && store.config.accounts) || {};
  return list[kind] || {};
}

function cookieOf(kind) {
  return String(account(kind).cookie || '');
}

function requireCookie(kind) {
  const cookie = cookieOf(kind);
  if (!cookie) throw new Error(kind === 'weread' ? '未填写微信读书 Cookie（设置 → 账号接入）' : '未填写起点 Cookie（设置 → 账号接入）');
  return cookie;
}

async function fetchText(url, { cookie = '', ua = UA_PC, referer = '', method = 'GET', body = null } = {}) {
  const headers = { 'User-Agent': ua, 'Accept-Language': 'zh-CN,zh;q=0.9' };
  if (referer) headers.Referer = referer;
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text, url: res.url };
}

function decodeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function toParagraphs(html) {
  const blocks = [];
  const re = /<(?:p|div)[^>]*>([\s\S]*?)<\/(?:p|div)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripTags(m[1]).replace(/\s+/g, ' ').trim();
    if (text) blocks.push(text);
  }
  if (!blocks.length) {
    const text = stripTags(html).replace(/\n{2,}/g, '\n\n').trim();
    if (text) blocks.push(...text.split(/\n+/).map((x) => x.trim()).filter(Boolean));
  }
  return blocks;
}

// ---------------- 微信读书 ----------------
function wereadId(bookUrl) {
  const m = String(bookUrl || '').match(/^weread:\/\/book\/([^/?#]+)/);
  return m ? m[1] : '';
}

function wereadChapter(bookUrl, chapterUrl) {
  const m = String(chapterUrl || '').match(/^weread:\/\/ch\/([^/]+)\/([^/?#]+)/);
  return m ? { bookId: m[1], uid: m[2] } : null;
}

async function wereadSearch(key) {
  const url = `https://weread.qq.com/web/search/global?keyword=${encodeURIComponent(key)}&maxIdx=0&fragmentSize=120&searchType=0`;
  const { status, text } = await fetchText(url, { ua: UA_PC, referer: 'https://weread.qq.com/' });
  if (status !== 200) throw new Error(`微信读书搜索失败（HTTP ${status}）`);
  const data = decodeJson(text) || {};
  const list = [];
  const push = (info) => {
    if (!info || !info.bookId || !info.title) return;
    list.push({
      name: String(info.title),
      author: String(info.author || ''),
      bookUrl: `weread://book/${info.bookId}`,
      coverUrl: String(info.cover || ''),
      intro: String(info.intro || info.soldout || ''),
      kind: '微信读书',
      lastChapter: '',
      origin: 'builtin://weread',
      originName: '微信读书',
    });
  };
  for (const item of Array.isArray(data.books) ? data.books : []) push(item.bookInfo || item);
  if (!list.length) {
    const scan = (node, depth) => {
      if (depth > 4 || !node) return;
      if (Array.isArray(node)) return node.forEach((x) => scan(x, depth + 1));
      if (typeof node !== 'object') return;
      if (node.bookId && node.title) push(node);
      for (const v of Object.values(node)) scan(v, depth + 1);
    };
    scan(data, 0);
  }
  return list;
}

async function wereadInfo(book) {
  const bookId = wereadId(book.bookUrl);
  if (!bookId) throw new Error('微信读书书籍地址不合法');
  const cookie = requireCookie('weread');
  const { text } = await fetchText(`https://weread.qq.com/web/book/info?bookId=${bookId}`, { cookie, referer: 'https://weread.qq.com/' });
  const data = decodeJson(text) || {};
  if (data.errCode) throw new Error(`微信读书详情失败：${data.errMsg || data.errCode}`);
  if (data.title) book.name = String(data.title);
  if (data.author) book.author = String(data.author);
  if (data.cover) book.coverUrl = String(data.cover);
  if (data.intro) book.intro = String(data.intro).slice(0, 2000);
  return book;
}

async function wereadToc(book) {
  const bookId = wereadId(book.bookUrl);
  if (!bookId) throw new Error('微信读书书籍地址不合法');
  const cookie = requireCookie('weread');
  const { text } = await fetchText('https://weread.qq.com/web/book/chapterInfos', {
    cookie,
    ua: UA_PC,
    referer: 'https://weread.qq.com/',
    method: 'POST',
    body: JSON.stringify({ bookIds: [bookId] }),
  });
  const data = decodeJson(text) || {};
  if (data.errCode) throw new Error(`微信读书目录失败：${data.errMsg || data.errCode}`);
  const updated = (Array.isArray(data.data) && data.data[0] && data.data[0].updated) || [];
  const chapters = updated.map((c, i) => ({
    index: i,
    title: String(c.title || `第${i + 1}章`),
    url: `weread://ch/${bookId}/${c.chapterUid}`,
    paid: Number(c.price) > 0,
  }));
  if (!chapters.length) throw new Error('微信读书目录为空（Cookie 可能已过期）');
  return chapters;
}

async function wereadContent(book, chapter) {
  const ids = wereadChapter(book.bookUrl, chapter.url);
  if (!ids) throw new Error('微信读书章节地址不合法');
  const cookie = requireCookie('weread');
  const { text } = await fetchText(`https://weread.qq.com/web/book/chapterContent?bookId=${ids.bookId}&chapterUid=${ids.uid}&pf=1`, {
    cookie,
    referer: 'https://weread.qq.com/',
  });
  const data = decodeJson(text);
  if (data && data.errCode) throw new Error(`微信读书正文失败：${data.errMsg || data.errCode}（可能需要会员或该章未购买）`);
  const html = (data && (data.content || (data.data && data.data.content))) || (data ? '' : text);
  const paragraphs = toParagraphs(html);
  if (!paragraphs.length) throw new Error('微信读书正文为空（可能需要会员或 Cookie 过期）');
  return { title: chapter.title, paragraphs };
}

// ---------------- 起点中文网 ----------------
function qidianId(bookUrl) {
  const m = String(bookUrl || '').match(/^qidian:\/\/book\/(\d+)/);
  return m ? m[1] : '';
}

async function qidianSearch(key) {
  const cookie = cookieOf('qidian');
  const url = `https://www.qidian.com/so/${encodeURIComponent(key)}.html`;
  const { status, text } = await fetchText(url, { cookie, referer: 'https://www.qidian.com/' });
  if (status === 202 || /x-waf-captcha|verify/.test(text.slice(0, 800))) {
    throw new Error('起点返回反爬验证：请在设置 → 账号接入更新起点 Cookie（浏览器登录后复制）');
  }
  if (status !== 200) throw new Error(`起点搜索失败（HTTP ${status}）`);
  const map = new Map();
  const re = /href="(?:https?:)?\/\/(?:book\.qidian\.com\/info|www\.qidian\.com\/book)\/(\d+)[^"]*"[^>]*>([^<]{1,40})</g;
  let m;
  while ((m = re.exec(text))) {
    const id = m[1];
    const name = stripTags(m[2]);
    if (!name || /更多|排行|分类/.test(name)) continue;
    if (!map.has(id)) map.set(id, { name, author: '', intro: '', coverUrl: '', kind: '起点中文网' });
  }
  const list = [...map.entries()].map(([id, b]) => ({
    ...b,
    bookUrl: `qidian://book/${id}`,
    lastChapter: '',
    origin: 'builtin://qidian',
    originName: '起点中文网',
  }));
  if (!list.length) throw new Error('起点搜索没有解析到结果（站点结构可能变化或 Cookie 失效）');
  return list.slice(0, 30);
}

async function qidianInfo(book) {
  const id = qidianId(book.bookUrl);
  const cookie = cookieOf('qidian');
  const { status, text } = await fetchText(`https://book.qidian.com/info/${id}/`, { cookie, referer: 'https://www.qidian.com/' });
  if (status !== 200 || /x-waf-captcha/.test(text.slice(0, 500))) throw new Error('起点详情被反爬拦截，请更新 Cookie');
  const title = (text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const author = (text.match(/作者[:：]?\s*<a[^>]*>([^<]+)</i) || [])[1];
  const cover = (text.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) || [])[1];
  const intro = (text.match(/<p[^>]*class="[^"]*intro[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
  if (title) book.name = stripTags(title);
  if (author) book.author = stripTags(author);
  if (cover) book.coverUrl = cover.startsWith('//') ? 'https:' + cover : cover;
  if (intro) book.intro = stripTags(intro).slice(0, 2000);
  return book;
}

async function qidianToc(book) {
  const id = qidianId(book.bookUrl);
  const cookie = cookieOf('qidian');
  const { status, text } = await fetchText(`https://book.qidian.com/info/${id}/`, { cookie, referer: 'https://www.qidian.com/' });
  if (status !== 200) throw new Error('起点目录被反爬拦截，请更新 Cookie');
  const chapters = [];
  const re = /href="(?:https?:)?\/\/(?:read\.qidian\.com|www\.qidian\.com)\/chapter\/(\d+)\/(\d+)[^"]*"[^>]*>([^<]{1,60})</g;
  let m;
  while ((m = re.exec(text))) {
    chapters.push({ index: chapters.length, title: stripTags(m[3]), url: `qidian://ch/${m[1]}/${m[2]}` });
  }
  if (!chapters.length) throw new Error('起点目录为空（页面可能改版，或需要登录后 Cookie）');
  return chapters;
}

async function qidianContent(book, chapter) {
  const m = String(chapter.url || '').match(/^qidian:\/\/ch\/(\d+)\/(\d+)/);
  if (!m) throw new Error('起点章节地址不合法');
  const cookie = requireCookie('qidian');
  const { status, text } = await fetchText(`https://read.qidian.com/chapter/${m[1]}/${m[2]}/`, { cookie, referer: `https://book.qidian.com/info/${m[1]}/` });
  if (status === 202) throw new Error('起点正文被反爬拦截，请更新 Cookie');
  if (/订阅|购买|VIP章节/.test(text.slice(0, 3000)) && !/class="[^"]*content[^"]*"/.test(text)) {
    throw new Error('起点该章需要购买或订阅，当前账号无权限');
  }
  const paragraphs = toParagraphs(text);
  if (!paragraphs.length) throw new Error('起点正文为空（可能需要登录/购买该章）');
  return { title: chapter.title, paragraphs };
}

// ---------------- 对外统一入口 ----------------
async function search(source, key, page = 1) {
  const site = siteOf(source);
  if (!site) return [];
  if (site.kind === 'weread') return wereadSearch(key);
  return qidianSearch(key);
}

async function info(source, book) {
  const site = siteOf(source);
  if (!site) return book;
  if (site.kind === 'weread') return wereadInfo(book);
  return qidianInfo(book);
}

async function toc(source, book) {
  const site = siteOf(source);
  if (!site) return [];
  if (site.kind === 'weread') return wereadToc(book);
  return qidianToc(book);
}

async function content(source, book, chapter) {
  const site = siteOf(source);
  if (!site) throw new Error('不是内置书源');
  if (site.kind === 'weread') return wereadContent(book, chapter);
  return qidianContent(book, chapter);
}

module.exports = {
  isBuiltin,
  siteOf,
  search,
  info,
  toc,
  content,
  cookieOf,
  SITES,
};
