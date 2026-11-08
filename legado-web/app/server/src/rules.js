'use strict';
// 书源规则解析与求值（兼容 Legado 常用语法）
const cheerio = require('cheerio');
const { evaluateXPath, nodeText, normText } = require('./xpath');
const { jsonPath } = require('./util');
const { runJs } = require('./jsrules');

function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let buf = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      buf += ch;
      if (ch === quote && str[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (depth === 0 && str.startsWith(sep, i)) {
      out.push(buf);
      buf = '';
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

const GETTER_WORDS = /^(text|html|outerHtml|textNodes|ownText|href|src|title|alt|value|content)$/i;

/** 解析一个选择器片段：前缀 + 索引（支持 a.0 / a!0 / li.1:2:3 / .-1） */
/** 按分隔符拆分，忽略 [] () 与引号内部 */
function splitAtTop(str, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let buf = '';
  for (const ch of str) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function parsePart(part) {
  let p = String(part || '').trim();
  let indices = null;
  const m = p.match(/^(.*?)[.!](-?\d+(?::-?\d+)*)$/);
  if (m && m[1] && !/^\d+$/.test(m[1])) {
    p = m[1];
    indices = m[2].split(':').map(Number);
  }
  if (/^id\./i.test(p)) p = '#' + p.slice(3);
  else if (/^class\./i.test(p)) p = '.' + p.slice(6);
  else if (/^tag\./i.test(p)) p = p.slice(4);
  else if (/^text\./i.test(p)) p = { text: p.slice(5).trim() };
  return { base: p, indices };
}

/** 拆出 @put/@get/@js/##替换/:正则，其余按 @ 切成选择器链 */
function parseSegment(segment) {
  let s = String(segment || '').trim();
  const seg = { parts: [], js: null, regex: null, replace: null, put: null, get: null };

  const putM = s.match(/@put:\s*\{([^}]*)\}/i);
  if (putM) {
    seg.put = {};
    for (const pair of putM[1].split(',')) {
      const idx = pair.indexOf(':');
      if (idx > 0) seg.put[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    s = s.replace(putM[0], '');
  }
  const getM = s.match(/@get:\s*\{([^}]*)\}/i);
  if (getM) {
    seg.get = getM[1].trim();
    s = s.replace(getM[0], '');
  }

  const jsIdx = s.toLowerCase().lastIndexOf('@js:');
  if (jsIdx >= 0) {
    seg.js = s.slice(jsIdx + 4);
    s = s.slice(0, jsIdx);
  }

  if (s.includes('##')) {
    const parts = s.split('##');
    s = parts[0];
    if (parts[1]) seg.replace = { pattern: parts[1], replacement: parts[2] === undefined ? '' : parts[2] };
  }

  s = s.trim();
  // 尾部 :正则（忽略属性选择器里的冒号、li.1:2:3 索引和 URL）
  let lastColon = -1;
  {
    let depth = 0;
    let quote = null;
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ']' || ch === ')') depth++;
      else if (ch === '[' || ch === '(') depth--;
      else if (ch === ':' && depth === 0) {
        lastColon = i;
        break;
      }
    }
  }
  if (lastColon > 0) {
    const cand = s.slice(lastColon + 1);
    const isIndex = /^-?\d+(:-?\d+)*$/.test(cand);
    const isUrl = /\/\//.test(s.slice(Math.max(0, lastColon - 1), lastColon + 2));
    if (cand && !isIndex && !isUrl && !/^[a-zA-Z-]+\(.*\)$/.test(cand)) {
      try {
        new RegExp(cand);
        seg.regex = cand;
        s = s.slice(0, lastColon);
      } catch {
        /* ignore */
      }
    }
  }

  // 按 @ 拆分，但忽略 XPath 谓词 / CSS 属性选择器里的 @
  seg.parts = (/^(\/\/|\.\/|@xpath:)/i.test(s) ? [s] : splitAtTop(s, '@'))
    .map((x) => x.trim())
    .filter(Boolean);
  return seg;
}

function parseRule(ruleStr) {
  const raw = String(ruleStr == null ? '' : ruleStr).trim();
  if (!raw) return [];
  return splitTop(raw, '||')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      splitTop(part, '&&')
        .map(parseSegment)
        .filter((seg) => seg.parts.length || seg.js || seg.get)
    );
}

function makeDoc(html) {
  const $ = cheerio.load(String(html || ''));
  return { $, root: $.root()[0], html: String(html || '') };
}

/** JSON 列表项可能是「JSON 字符串」，取字段前先尝试解析 */
function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function descendantsOf(node, out = []) {
  for (const c of node.children || []) {
    out.push(c);
    descendantsOf(c, out);
  }
  return out;
}

/**
 * 在 nodes（为 null 表示整篇文档）里按一个片段选择
 */
function selectPart(ctx, nodes, part, fromRoot) {
  const $ = ctx.doc.$;
  // XPath 片段
  if (/^@xpath:/i.test(part) || part.startsWith('//') || part.startsWith('./')) {
    const expr = /^@xpath:/i.test(part) ? part.slice(7).trim() : part;
    const roots = fromRoot ? [ctx.doc.root] : nodes || [];
    const out = [];
    for (const r of roots) out.push(...evaluateXPath(r, expr));
    return out;
  }
  const info = parsePart(part);
  let out = [];

  if (info.base && typeof info.base === 'object' && info.base.text !== undefined) {
    const want = info.base.text;
    const pool = fromRoot ? [...$('*')] : nodes.flatMap((n) => descendantsOf(n));
    out = pool.filter((n) => n.type === 'tag' && $(n).text().trim() === want);
  } else {
    const sel = info.base;
    if (!sel) return [];
    if (fromRoot) {
      try {
        out = [...$(sel)];
      } catch {
        out = [];
      }
    } else {
      for (const n of nodes) {
        try {
          const $n = $(n);
          const found = $n.find(sel);
          if (found && found.length) out.push(...found);
          else if ($n.is(sel)) out.push(n);
        } catch {
          /* 忽略非法选择器 */
        }
      }
    }
  }

  if (info.indices) {
    out = info.indices.map((i) => (i < 0 ? out[out.length + i] : out[i])).filter(Boolean);
  }
  return out;
}

function getterValue($, node, getter) {
  if (node.type === 'json') {
    const v = node.value;
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  if (node.type === 'attribute') return node.value || '';
  if (node.type === 'text') return normText(node.data);
  const el = $(node);
  switch (getter) {
    case 'href':
      return el.attr('href') || '';
    case 'src':
      return el.attr('src') || el.attr('data-src') || el.attr('data-original') || el.attr('data-lazy-src') || '';
    case 'title':
      return el.attr('title') || '';
    case 'alt':
      return el.attr('alt') || '';
    case 'value':
      return el.attr('value') || '';
    case 'html':
      return el.html() || '';
    case 'outerhtml':
    case 'outerHtml':
      return $.html(node) || '';
    case 'innertext':
      return (el.text() || '').replace(/\s+/g, ' ').trim();
    case 'length':
    case 'size':
      return String(el.length);
    case 'ownText': {
      const clone = el.clone();
      clone.children().remove();
      return normText(clone.text());
    }
    case 'textNodes': {
      const texts = [];
      const walk = (n) => {
        if (!n) return;
        if (n.type === 'text') {
          const t = String(n.data || '').trim();
          if (t) texts.push(t);
        }
        for (const c of n.children || []) walk(c);
      };
      walk(node);
      return texts.join('\n');
    }
    default:
      return normText(el.text());
  }
}

function applySuffixes(values, seg) {
  let out = values;
  if (seg.regex) {
    const re = new RegExp(seg.regex);
    out = out
      .map((v) => {
        const m = String(v).match(re);
        if (!m) return '';
        return m.length > 1 && m[1] !== undefined ? m[1] : m[0];
      })
      .filter((v) => v !== '');
  }
  if (seg.replace) {
    const re = new RegExp(seg.replace.pattern, 'g');
    out = out.map((v) => String(v).replace(re, seg.replace.replacement));
  }
  return out;
}

/**
 * 求值一条规则
 * @param {string} ruleStr 规则
 * @param {object} ctx {doc, json, baseUrl, book, source, key, page, getString?}
 * @param {object} opts {scope: node, all: bool}
 * @returns {{values: string[], nodes: any[]}}
 */
function evalRule(ruleStr, ctx, opts = {}) {
  let rule = ruleStr == null ? '' : String(ruleStr);

  // JSON 节点里的 {{$.field}} / {$..field} / {{field}} 模板替换
  if (opts.scope && opts.scope.type === 'json' && rule.includes('{')) {
    const scopeVal = opts.scope.value;
    const lookup = (expr) => {
      const e = String(expr).trim();
      const path = e.startsWith('$') ? e : '$.' + e.replace(/^\./, '');
      let v;
      try {
        v = jsonPath(scopeVal, path)[0];
      } catch {
        v = undefined;
      }
      if (v === undefined || v === null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    };
    rule = rule
      .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, e) => lookup(e))
      .replace(/\{\s*([^{}\s]+)\s*\}/g, (m, e) => (e.startsWith('$') ? lookup(e) : m));

    // 替换完只剩文本（URL 或纯文字）时直接当结果
    const stripped = String(ruleStr)
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/\{\s*\$[^{}]*\}/g, '');
    const isUrl = /^https?:\/\//i.test(rule.trim());
    if (isUrl || !/[.$@\[\]()]/.test(stripped)) {
      return { values: [rule], nodes: [] };
    }
  }

  // {{变量}}（来自 @put）
  if (ctx.vars && rule.includes('{{')) {
    rule = rule.replace(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g, (m, k) =>
      ctx.vars[k] !== undefined ? String(ctx.vars[k]) : m
    );
  }
  // 纯 URL 视为字面量（书源的 bookUrl 常见写法）
  if (/^https?:\/\//i.test(rule.trim())) {
    return { values: [rule.trim()], nodes: [] };
  }

  // 顶层 JSONPath：书源规则直接写 $.a.b / $..list[*]
  const head = rule.trim();
  if ((head.startsWith('$') || head.startsWith('[')) && ctx.json !== undefined) {
    try {
      const vals = jsonPath(ctx.json, head);
      if (vals.length) {
        return {
          values: vals.map((v) =>
            v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
          ),
          nodes: vals.map((v) => ({ type: 'json', value: v })),
        };
      }
    } catch {
      /* 落到后面的通用解析 */
    }
  }

  // 显式前缀（@css: / @text: …）与 && 拼接
  const prefixed = evalWithPrefixes(rule, ctx, opts);
  if (prefixed) return prefixed;

  const alternatives = parseRule(rule);
  if (!alternatives.length) return { values: [], nodes: [] };

  for (const segments of alternatives) {
    const values = [];
    const outNodes = [];

    for (const seg of segments) {
      if (seg.put) {
        if (!ctx.vars) ctx.vars = {};
        for (const [k, r] of Object.entries(seg.put)) ctx.vars[k] = evalString(r, ctx, opts);
      }
      if (seg.get && !seg.parts.length) {
        const v = ctx.vars ? ctx.vars[seg.get] : '';
        if (v !== undefined && v !== null && String(v).trim() !== '') values.push(String(v));
        continue;
      }

      let localValues = [];
      let localNodes = [];

      // JSON 列表项：把片段当作字段路径
      if (opts.scope && opts.scope.type === 'json') {
        const raw = seg.parts.join('@') || '';
        const path = raw.startsWith('$') || raw.startsWith('[') ? raw : '$.' + raw;
        const vs = jsonPath(parseMaybeJson(opts.scope.value), path);
        localValues = vs
          .map((v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)))
          .filter((v) => String(v).trim() !== '');
        localValues = applySuffixes(localValues, seg);
      } else if (seg.parts.length) {
        const parts = seg.parts.slice();
        let getter = 'text';
        if (GETTER_WORDS.test(parts[parts.length - 1])) getter = parts.pop();

        if (!parts.length) {
          // 纯 getter（章节规则里的 text / href）
          if (opts.scope) {
            const v = getterValue(ctx.doc.$, opts.scope, getter.toLowerCase());
            if (v) localValues = [v];
          }
        } else {
          let nodes = opts.scope ? [opts.scope] : null;
          for (let i = 0; i < parts.length; i++) {
            nodes = selectPart(ctx, nodes, parts[i], !opts.scope && i === 0);
            if (!nodes || !nodes.length) break;
          }
          localNodes = nodes || [];
          const $ = ctx.doc.$;
          localValues = localNodes.map((n) => getterValue($, n, getter.toLowerCase()));
        }
        localValues = applySuffixes(localValues, seg);
      }

      if (seg.js) {
        const input = localValues.length <= 1 ? localValues[0] || '' : localValues.join('\n');
        const out = runJs(seg.js, {
          result: input,
          baseUrl: ctx.baseUrl,
          book: ctx.book,
          source: ctx.source,
          key: ctx.key,
          page: ctx.page,
          getString: (r) => evalRule(r, ctx, opts).values.join('\n'),
          getElements: (r) => evalRule(r, ctx, opts).nodes,
        });
        localValues = [String(out)];
        localNodes = [];
      }

      values.push(...localValues.filter((v) => v !== undefined && v !== null && String(v).trim() !== ''));
      outNodes.push(...localNodes);
    }

    if (values.length) return { values, nodes: outNodes };
  }
  return { values: [], nodes: [] };
}

/** 显式前缀选择器：@text: / @css: / @xpath: / @json: / @regex: / @js: */
function evalPrefixed(piece, ctx, opts = {}) {
  let raw = String(piece).trim();
  // 拆出尾部的 ##正则##替换
  let clean = null;
  const cleanMatch = raw.match(/^(.*?)##([^#]+)##(.*)$/);
  if (cleanMatch) {
    raw = cleanMatch[1].trim();
    clean = { pattern: cleanMatch[2], replacement: cleanMatch[3] };
  }
  const m = raw.match(/^@(text|css|xpath|json|regex|js):([\s\S]*)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  let body = m[2];

  if (clean) {
    const inner = evalPrefixed(raw, ctx, opts);
    if (!inner) return null;
    try {
      const re = new RegExp(clean.pattern, 'g');
      return {
        values: inner.values.map((v) => String(v).replace(re, clean.replacement)),
        nodes: inner.nodes,
      };
    } catch {
      return inner;
    }
  }

  if (kind === 'text') return { values: [body], nodes: [] };

  if (kind === 'json') {
    if (ctx.json === undefined) return { values: [], nodes: [] };
    const vs = jsonPath(ctx.json, body.trim());
    return {
      values: vs.map((v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))),
      nodes: vs.map((v) => ({ type: 'json', value: v })),
    };
  }

  if (kind === 'regex') {
    const src = ctx.doc && ctx.doc.html ? ctx.doc.html : '';
    let re;
    try {
      re = new RegExp(body.trim());
    } catch {
      return { values: [], nodes: [] };
    }
    const mm = src.match(re);
    if (!mm) return { values: [], nodes: [] };
    return { values: [mm.length > 1 && mm[1] !== undefined ? mm[1] : mm[0]], nodes: [] };
  }

  if (kind === 'xpath') {
    // 我们的 XPath 支持 // 表达式，交给通用解析处理
    return evalRule(body.trim(), ctx, opts);
  }

  if (kind === 'css') {
    const raw = body.trim();
    const getterMatch = raw.match(/@([A-Za-z_][\w-]*)$/);
    const sel = (getterMatch ? raw.slice(0, getterMatch.index) : raw).trim();
    const getter = getterMatch ? getterMatch[1].toLowerCase() : 'text';
    if (!sel || !ctx.doc) return { values: [], nodes: [] };
    let nodes;
    try {
      const scoped = opts.scope && opts.scope.type !== 'json' && opts.scope.type !== 'attribute';
      nodes = scoped ? ctx.doc.$(opts.scope).find(sel).toArray() : ctx.doc.$(sel).toArray();
    } catch {
      return { values: [], nodes: [] };
    }
    const $ = ctx.doc.$;
    return { values: nodes.map((n) => getterValue($, n, getter)), nodes };
  }

  if (kind === 'js') {
    const out = runJs(body, {
      result: ctx.doc && ctx.doc.html ? ctx.doc.html : '',
      baseUrl: ctx.baseUrl,
      book: ctx.book,
      source: ctx.source,
      key: ctx.key,
      page: ctx.page,
      getString: (r) => evalRule(r, ctx, opts).values.join('\n'),
    });
    return { values: [String(out)], nodes: [] };
  }

  return null;
}

/** 带 && 拼接与前缀支持的段求值 */
function evalWithPrefixes(ruleStr, ctx, opts = {}) {
  const text = String(ruleStr || '');
  if (!/@(text|css|xpath|json|regex|js):/i.test(text)) return null;

  const alternatives = splitTop(text, '||');
  for (const alt of alternatives) {
    const pieces = splitTop(alt, '&&').map((x) => x.trim()).filter(Boolean);
    const values = [];
    const nodes = [];
    let first = null;
    for (const piece of pieces) {
      let target = piece;
      // 去掉外层括号，避免同一表达式被反复求值
      while (target.startsWith('(') && target.endsWith(')')) target = target.slice(1, -1).trim();
      // 分组里可能还有 ||，整体交给 evalRule 处理
      const r = target.includes('||')
        ? evalRule(target, ctx, opts)
        : evalPrefixed(target, ctx, opts) || evalRule(target, ctx, opts);
      if (!first) first = r;
      const v = (r.values || []).filter((x) => x !== undefined && x !== null && String(x) !== '');
      values.push(...v);
      if (r.nodes && r.nodes.length) nodes.push(...r.nodes);
    }
    // 单段规则（如列表选择器）要保留 nodes，供上层遍历
    if (pieces.length === 1 && first && (first.values.length || (first.nodes && first.nodes.length))) return first;
    if (values.length) return { values: [values.join('')], nodes };
  }
  return { values: [], nodes: [] };
}

function evalString(ruleStr, ctx, opts = {}) {
  const { values } = evalRule(ruleStr, ctx, opts);
  if (!values.length) return '';
  return opts.joinAll ? values.join('\n') : values[0];
}

function evalList(ruleStr, ctx, opts = {}) {
  return evalRule(ruleStr, ctx, opts).values;
}

module.exports = { makeDoc, evalRule, evalString, evalList, parseRule };
