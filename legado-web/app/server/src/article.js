'use strict';
// 订阅条目正文抽取：把文章页转成段落数组
const cheerio = require('cheerio');
const { request } = require('./util');

const CANDIDATES = [
  'article',
  '.article-content',
  '.article',
  '.post-content',
  '.entry-content',
  '.content',
  '#content',
  'main',
  '.markdown-body',
];

function looksLikeText(s, min = 30) {
  return typeof s === 'string' && s.replace(/\s+/g, '').length >= min;
}

function paragraphsFrom($, node) {
  const ps = $(node)
    .find('p, li, blockquote')
    .map((i, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((t) => looksLikeText(t, 10));
  if (ps.length >= 2) return ps;

  const text = $(node).text().replace(/\r/g, '');
  return text
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((t) => looksLikeText(t, 20));
}

async function getArticle(link) {
  if (!/^https?:\/\//i.test(String(link || ''))) throw new Error('条目没有可用链接');
  const resp = await request(link, { timeout: 20000 });
  const $ = cheerio.load(resp.body);
  $('script, style, nav, header, footer, aside, .comment, .comments').remove();

  let best = [];
  for (const sel of CANDIDATES) {
    const node = $(sel).first();
    if (!node.length) continue;
    const ps = paragraphsFrom($, node);
    if (ps.length > best.length) best = ps;
    if (ps.length >= 3) break;
  }
  if (!best.length) best = paragraphsFrom($, $.root());

  if (!best.length) throw new Error('没能从该页面提取到正文');
  return best;
}

module.exports = { getArticle };
