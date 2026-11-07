'use strict';
// 通用工具：HTTP 抓取（cookie/编码/重定向）、文本处理、JSON path

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/122.0 Safari/537.36';

const cookieJar = new Map(); // host -> Map(name -> value)

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function getCookieHeader(url) {
  const jar = cookieJar.get(hostOf(url));
  if (!jar || jar.size === 0) return '';
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(url, headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (!list.length) return;
  const host = hostOf(url);
  let jar = cookieJar.get(host);
  if (!jar) jar = new Map(), cookieJar.set(host, jar);
  for (const line of list) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function detectCharset(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  let m = ct.match(/charset=([\w-]+)/);
  if (m) return m[1];
  // 以 latin1 读取前 4KB 探测 meta
  const head = Buffer.from(buf.slice(0, 4096)).toString('latin1');
  m = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (m) return m[1];
  return 'utf-8';
}

function decodeBody(buf, contentType) {
  const cs = detectCharset(buf, contentType).toLowerCase();
  const normalized = cs === 'gb2312' ? 'gbk' : cs;
  try {
    return new TextDecoder(normalized).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * 抓取网页
 * @returns {Promise<{body:string, url:string, status:number, contentType:string}>}
 */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.LEGADO_MAX_CONCURRENCY || 4));
let activeSlots = 0;
const slotQueue = [];

function acquireSlot() {
  if (activeSlots < MAX_CONCURRENCY) {
    activeSlots++;
    return Promise.resolve();
  }
  return new Promise((resolve) => slotQueue.push(resolve));
}

function releaseSlot() {
  const next = slotQueue.shift();
  if (next) next();
  else activeSlots--;
}

async function requestOnce(url, options = {}) {
  const {
    method = 'GET',
    body = null,
    headers = {},
    timeout = 20000,
    charset = null,
    referer = null,
  } = options;

  const h = {
    'User-Agent': DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    ...headers,
  };
  if (referer) h.Referer = referer;
  const cookie = getCookieHeader(url);
  if (cookie) h.Cookie = cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: h,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (err) {
      const cause = err.cause ? err.cause.code || err.cause.message || '' : '';
      throw new Error(cause ? err.message + ' [' + cause + ']' : err.message);
    }
    storeCookies(res.url || url, res.headers);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    const text = charset ? new TextDecoder(charset).decode(buf) : decodeBody(buf, ct);
    return { body: text, url: res.url || url, status: res.status, contentType: ct, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取网页（全局限流 + 超时重试一次）
 * 并发刻意压低：NAS 的 NAT/带宽有限，并发过高会导致大量连接超时
 */
async function request(url, options = {}) {
  await acquireSlot();
  try {
    try {
      return await requestOnce(url, options);
    } catch (e) {
      if (/CONNECT_TIMEOUT|ECONNRESET|socket hang up|aborted|UND_ERR_SOCKET/i.test(String(e.message))) {
        await new Promise((r) => setTimeout(r, 400));
        return await requestOnce(url, options);
      }
      throw e;
    }
  } finally {
    releaseSlot();
  }
}

function absoluteUrl(base, maybeRelative) {
  if (!maybeRelative) return '';
  const s = String(maybeRelative).trim();
  if (!s) return '';
  if (/^(https?:|data:|file:)/i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  try {
    return new URL(s, base).toString();
  } catch {
    return s;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HTML_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', hellip: '…', mdash: '—' };

function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return HTML_ENTITIES[e] !== undefined ? HTML_ENTITIES[e] : m;
  });
}

/** 把 HTML 片段转成阅读用的纯文本段落 */
function htmlToParagraphs(html) {
  if (!html) return [];
  let s = String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split(/\r?\n/)
    .map((line) => line.replace(/\u00a0/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/** 极简 JSONPath：$.a.b[0].c / $..name / $.list[*].title */
function jsonPath(data, path) {
  let p = String(path || '').trim();
  if (!p) return data;
  if (p.startsWith('$')) p = p.slice(1);
  const tokens = [];
  const re = /\.\.([\w$]+)|\.(\*)|\.([\w$]+)|\[(\d+|\*|'[^']*'|"[^"]*")\]/g;
  let m;
  while ((m = re.exec(p))) {
    if (m[1]) tokens.push({ deep: true, key: m[1] });
    else if (m[2]) tokens.push({ any: true });
    else if (m[3]) tokens.push({ key: m[3] });
    else {
      let v = m[4];
      if (v === '*') tokens.push({ any: true });
      else if (v.startsWith("'") || v.startsWith('"')) tokens.push({ key: v.slice(1, -1) });
      else tokens.push({ index: Number(v) });
    }
  }
  let cur = [data];
  for (const t of tokens) {
    const next = [];
    for (const item of cur) {
      if (item == null) continue;
      if (t.deep) collectDeep(item, t.key, next);
      else if (t.any) {
        if (Array.isArray(item)) next.push(...item);
        else if (typeof item === 'object') next.push(...Object.values(item));
      } else if (t.index !== undefined) {
        if (Array.isArray(item) && item[t.index] !== undefined) next.push(item[t.index]);
      } else if (t.key !== undefined) {
        if (typeof item === 'object' && item[t.key] !== undefined) next.push(item[t.key]);
      }
    }
    cur = next;
  }
  return cur;
}

function collectDeep(obj, key, out) {
  if (obj == null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const v of obj) collectDeep(v, key, out);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) out.push(v);
    else collectDeep(v, key, out);
  }
}

/**
 * 抓取二进制内容（图片等），返回 Buffer 与 content-type
 */
async function requestBinary(url, options = {}) {
  const { headers = {}, timeout = 15000, referer = null } = options;
  const h = {
    'User-Agent': DEFAULT_UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    ...headers,
  };
  if (referer) h.Referer = referer;
  const cookie = getCookieHeader(url);
  if (cookie) h.Cookie = cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: h,
      redirect: 'follow',
      signal: controller.signal,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') || '', status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { DEFAULT_UA, request, requestBinary, absoluteUrl, decodeEntities, htmlToParagraphs, jsonPath, escapeRegExp };
