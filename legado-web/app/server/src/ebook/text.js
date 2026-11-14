'use strict';
// TXT：编码嗅探 + 章节正则 + 兜底按长度切
const { clean, splitLong } = require('./html');

function decodeBuffer(buf) {
  const b = Buffer.from(buf);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return b.subarray(3).toString('utf8');
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    /* 继续试 GB18030 */
  }
  try {
    return new TextDecoder('gb18030').decode(b);
  } catch {
    return b.toString('latin1');
  }
}

const CHAPTER_RE = /^(?:\s*)(?:第[0-9一二三四五六七八九十百千零两]{1,8}[章节回卷部篇]|Chapter\s+\d+|\d{1,4}[、.．]\s*\S)/i;

function parseTxt(buf, opts = {}) {
  const text = decodeBuffer(buf).replace(/\r\n?/g, '\n');
  if (!text.trim()) {
    const err = new Error('文本为空');
    err.code = 'corrupt';
    throw err;
  }
  const lines = text.split('\n');
  const chapters = [];
  let title = '';
  let body = [];
  const flush = () => {
    const paragraphs = [];
    for (const line of body) {
      const t = clean(line);
      if (!t) continue;
      for (const piece of splitLong(t)) paragraphs.push({ k: 'p', t: piece });
    }
    if (paragraphs.length) {
      chapters.push({ title: title || `第 ${chapters.length + 1} 章`, paragraphs });
    }
    title = '';
    body = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (t && t.length <= 60 && CHAPTER_RE.test(t)) {
      flush();
      title = t;
      continue;
    }
    body.push(line);
  }
  flush();

  if (chapters.length <= 1) {
    // 没有章节结构：按 3000 字左右切块，尽量在空行/句号处断开
    const all = [];
    let buf2 = '';
    for (const line of lines) {
      buf2 += line + '\n';
      if (buf2.length >= 3000) {
        all.push(buf2);
        buf2 = '';
      }
    }
    if (buf2.trim()) all.push(buf2);
    chapters.length = 0;
    all.forEach((chunk, i) => {
      const paragraphs = [];
      for (const line of chunk.split('\n')) {
        const t = clean(line);
        if (!t) continue;
        for (const piece of splitLong(t)) paragraphs.push({ k: 'p', t: piece });
      }
      if (paragraphs.length) chapters.push({ title: `第 ${i + 1} 节`, paragraphs });
    });
  }

  return {
    meta: { title: clean(opts.name || ''), author: '' },
    chapters,
    chars: chapters.reduce((n, ch) => n + ch.paragraphs.reduce((m, p) => m + p.t.length, 0), 0),
  };
}

module.exports = { parseTxt, decodeBuffer };
