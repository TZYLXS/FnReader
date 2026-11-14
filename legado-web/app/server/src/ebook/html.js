'use strict';
// HTML → 结构化段落（服务端与客户端保持同一套块级规则）
const cheerio = require('cheerio');

const HEADING = /^h[1-6]$/;
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'li', 'blockquote', 'pre', 'td', 'dd', 'dt',
  'figcaption', 'header', 'footer', 'aside', 'main', 'nav', 'center',
]);

function clean(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 超长段落按句号/问号/叹号切开，避免单段几万字 */
function splitLong(text, max = 4096) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (let i = max; i > max / 2; i--) {
      if ('。！？!?.；;'.includes(rest[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function pushText(out, kind, text) {
  const t = clean(text);
  if (!t) return;
  for (const piece of splitLong(t)) out.push({ k: kind, t: piece });
}

function hasBlockChild($, node) {
  return (node.children || []).some(
    (c) => c.type === 'tag' && (BLOCK.has((c.name || '').toLowerCase()) || HEADING.test((c.name || '').toLowerCase()))
  );
}

/**
 * @param {string} html 一章的 HTML
 * @param {{dropTitle?: string, defaultKind?: string}} opts
 * @returns {{k:string,t:string}[]}
 */
function htmlToBlocks(html, opts = {}) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: true });
  $('script,style,noscript,head,svg').remove();
  const root = $('body').length ? $('body').get(0) : $.root().get(0);
  const out = [];
  let buf = '';

  const flush = () => {
    if (buf.trim()) pushText(out, opts.defaultKind || 'p', buf);
    buf = '';
  };

  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'text') {
        buf += child.data || '';
        continue;
      }
      if (child.type !== 'tag') continue;
      const tag = (child.name || '').toLowerCase();
      if (tag === 'br') {
        flush();
        continue;
      }
      if (HEADING.test(tag)) {
        flush();
        pushText(out, tag, $(child).text());
        continue;
      }
      if (tag === 'img') {
        flush();
        const alt = clean($(child).attr('alt') || $(child).attr('title') || '');
        out.push({ k: 'img', t: alt });
        continue;
      }
      if (tag === 'hr') {
        flush();
        out.push({ k: 'hr', t: '' });
        continue;
      }
      if (BLOCK.has(tag)) {
        if (hasBlockChild($, child)) {
          flush();
          walk(child);
          flush();
          continue;
        }
        flush();
        const kind = tag === 'blockquote' ? 'quote' : tag === 'li' ? 'p' : 'p';
        pushText(out, kind, $(child).text());
        continue;
      }
      // 行内标签：文字并入当前段
      walk(child);
    }
  };

  walk(root);
  flush();

  // 首段与章节标题重复时丢掉
  if (opts.dropTitle) {
    const first = out[0];
    const title = clean(opts.dropTitle);
    if (first && title && clean(first.t) === title) out.shift();
  }
  return out;
}

module.exports = { htmlToBlocks, clean, splitLong };
