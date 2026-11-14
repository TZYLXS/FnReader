'use strict';
// ebook://<sha1> 的目录/正文渲染：只读 JSON，不再解析原文件
const store = require('./store');

function parseUrl(url) {
  const s = String(url || '');
  if (!s.startsWith('ebook://')) return '';
  const sha1 = s.slice('ebook://'.length).split(/[?#]/)[0];
  return /^[0-9a-f]{40}$/i.test(sha1) ? sha1.toLowerCase() : '';
}

function toc(dataDir, sha1) {
  const book = store.readBook(dataDir, sha1);
  if (!book) return null;
  const chapters = (book.toc || []).map((c, i) => ({
    index: i,
    title: c.title,
    url: 'ebook://' + sha1 + '#' + (c.id || i),
    level: c.level || 1,
  }));
  return {
    chapters,
    name: book.name,
    meta: book.meta || {},
    total: chapters.length,
    status: book.status || '',
    source: book.source || '',
    via: 'ebook-json',
  };
}

function paragraphsOf(chapter) {
  const out = [];
  for (const p of chapter.paragraphs || []) {
    const k = p.k || 'p';
    const t = String(p.t || '');
    if (k === 'hr') {
      out.push('· · ·');
    } else if (k === 'img') {
      out.push(t ? `〔插图：${t}〕` : '〔插图〕');
    } else if (k === 'quote') {
      out.push(`「${t}」`);
    } else {
      out.push(t);
    }
  }
  return out.filter((s) => s && s.trim());
}

function content(dataDir, sha1, index) {
  const book = store.readBook(dataDir, sha1);
  if (!book || !book.toc || !book.toc.length) return null;
  if (!Number.isInteger(index) || index < 0 || index >= book.toc.length) return null;
  const chapter = store.readChapter(dataDir, sha1, index);
  if (!chapter) return null;
  return {
    title: chapter.title || book.toc[index].title,
    index,
    total: book.toc.length,
    next: index + 1 < book.toc.length ? book.toc[index + 1].title : '',
    prev: index > 0 ? book.toc[index - 1].title : '',
    paragraphs: paragraphsOf(chapter),
    cached: true,
    via: 'ebook-json',
  };
}

module.exports = { parseUrl, toc, content };
