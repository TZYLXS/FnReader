'use strict';
// @js: 规则沙箱，兼容 Legado 常用 java.* API
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/** 用子进程做“同步”HTTP，供 java.ajax 使用（Node 没有同步 fetch） */
function syncFetch(url, options = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('java.ajax 需要完整 URL，收到: ' + target.slice(0, 60));
  }
  const code = `
    const url = Buffer.from(process.env.__U, 'base64').toString();
    const opts = JSON.parse(Buffer.from(process.env.__O, 'base64').toString());
    (async () => {
      const res = await fetch(url, { headers: opts.headers || {}, method: opts.method || 'GET', body: opts.body || undefined });
      const buf = Buffer.from(await res.arrayBuffer());
      process.stdout.write(buf.toString('base64'));
      process.stdout.write('\\n__META__' + res.url);
    })().catch(e => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
  `;
  const headers = options.headers || {};
  const out = execFileSync(process.execPath, ['-e', code], {
    timeout: options.timeout || 20000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      __U: Buffer.from(url, 'utf8').toString('base64'),
      __O: Buffer.from(JSON.stringify({ headers, method: options.method, body: options.body }), 'utf8').toString('base64'),
    },
  });
  const text = out.toString('utf8');
  const idx = text.lastIndexOf('\n__META__');
  const b64 = idx >= 0 ? text.slice(0, idx) : text;
  return Buffer.from(b64, 'base64').toString('utf8');
}

function md5(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

function base64Encode(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

function base64Decode(s) {
  return Buffer.from(String(s), 'base64').toString('utf8');
}

function timeFormat(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 执行 @js: 代码
 * @param {string} code
 * @param {object} ctx {result, baseUrl, book, source, key, page, getString(rule), log}
 */
function runJs(code, ctx = {}) {
  const store = new Map();
  const logs = [];
  const java = {
    ajax: (url, opts = {}) => syncFetch(String(url), opts),
    ajaxAll: (urls) => (Array.isArray(urls) ? urls : []).map((u) => syncFetch(String(u))),
    base64Encode,
    base64Decode,
    md5Encode: md5,
    md5Encode16: (s) => md5(s).slice(8, 24),
    encodeURI: (s) => encodeURIComponent(String(s)),
    timeFormat,
    log: (msg) => logs.push(String(msg)),
    put: (k, v) => store.set(String(k), v),
    get: (k) => (store.has(String(k)) ? store.get(String(k)) : undefined),
    getString: (rule) => (ctx.getString ? ctx.getString(String(rule)) : ''),
    getElements: (rule) => (ctx.getElements ? ctx.getElements(String(rule)) : []),
    toast: () => {},
    longToast: () => {},
  };
  const source = ctx.source || {};
  const book = ctx.book || {};
  const cookie = {
    getCookie: (u) => (ctx.getCookie ? ctx.getCookie(String(u)) : ''),
    setCookie: () => {},
  };
  const cache = {
    get: (k) => java.get(String(k)),
    put: (k, v) => java.put(String(k), v),
    delete: (k) => store.delete(String(k)),
  };
  const sandbox = {
    result: ctx.result,
    baseUrl: ctx.baseUrl || '',
    book,
    source,
    cookie,
    cache,
    java,
    key: ctx.key || '',
    page: ctx.page || 1,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    console: { log: (...a) => logs.push(a.join(' ')) },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  let value;
  try {
    value = vm.runInContext(String(code), context, { timeout: 8000 });
  } catch (e) {
    throw new Error(`JS规则执行失败: ${e.message}`);
  }
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

module.exports = { runJs };
