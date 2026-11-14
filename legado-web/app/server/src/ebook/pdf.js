'use strict';
// PDF 文本层抽取（轻量实现）：解压 FlateDecode 流 → 取 Tj/TJ → 按 Td/TD/T* 分行
// 扫描版（无文本层）会抛 no-text-layer，由网页提示先 OCR。
const zlib = require('node:zlib');
const { clean, splitLong } = require('./html');

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function inflateMaybe(data, dict) {
  if (/FlateDecode/.test(dict)) {
    try {
      return zlib.inflateSync(data);
    } catch {
      try {
        return zlib.inflateRawSync(data);
      } catch {
        return null;
      }
    }
  }
  return data;
}

function extractStreams(buf) {
  const out = [];
  const marker = Buffer.from('stream');
  let at = buf.indexOf(marker);
  while (at >= 0) {
    let start = at + marker.length;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf(Buffer.from('endstream'), start);
    if (end < 0) break;
    const dictStart = Math.max(0, at - 600);
    const dict = buf.toString('latin1', dictStart, at);
    const data = inflateMaybe(buf.subarray(start, end), dict);
    if (data && data.length) out.push({ dict, data });
    at = buf.indexOf(marker, end + 9);
  }
  return out;
}

function buildToUnicode(streams) {
  const map = new Map();
  for (const { data } of streams) {
    const s = data.toString('latin1');
    if (!/beginbfchar|beginbfrange/.test(s)) continue;
    const charRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m;
    while ((m = charRe.exec(s))) {
      const code = parseInt(m[1], 16);
      map.set(code, unicodeFromHex(m[2]));
    }
    const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((m = rangeRe.exec(s))) {
      const from = parseInt(m[1], 16);
      const to = parseInt(m[2], 16);
      const dst = parseInt(m[3], 16);
      if (to - from > 65535) continue;
      for (let c = from; c <= to && c - from < 4096; c++) map.set(c, String.fromCharCode(dst + (c - from)));
    }
  }
  return map;
}

function unicodeFromHex(hex) {
  const chars = [];
  for (let i = 0; i + 3 < hex.length; i += 4) {
    chars.push(String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)));
  }
  return chars.join('');
}

function unescapeLiteral(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (all, g) => {
    if (/^[0-7]/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[g] || g;
  });
}

function decodeHexString(hex, map) {
  const cleanHex = hex.replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < cleanHex.length; i += 2) bytes.push(parseInt(cleanHex.slice(i, i + 2), 16));
  if (!map.size) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return s;
    }
    return bytes.map((b) => String.fromCharCode(b)).join('');
  }
  // 双字节编码：逐个 code 查表，查不到就按 UTF-16BE 试着解
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    s += map.get(code) || (code >= 0x20 && code < 0xfffe ? String.fromCharCode(code) : '');
  }
  return s;
}

function extractPageText(content, map) {
  const lines = [];
  const parts = content.split(/\bT[dD]\b|\bT\*\b/);
  for (const part of parts) {
    let text = '';
    const tokenRe = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>/g;
    let m;
    while ((m = tokenRe.exec(part))) {
      if (m[1] !== undefined) text += unescapeLiteral(m[1]);
      else text += decodeHexString(m[2], map);
    }
    const t = clean(text);
    if (t) lines.push(t);
  }
  return lines;
}

function parsePdf(buf, opts = {}) {
  if (buf.length < 5 || buf.toString('latin1', 0, 5) !== '%PDF-') throw fail('unsupported', '不是 PDF 文件');
  const streams = extractStreams(buf);
  const map = buildToUnicode(streams);
  const lines = [];
  for (const { data } of streams) {
    const s = data.toString('latin1');
    if (!/\bBT\b/.test(s) || !/(Tj|TJ)\b/.test(s)) continue;
    lines.push(...extractPageText(s, map));
  }
  const text = lines.join('\n');
  if (clean(text).length < 20) throw fail('no-text-layer', 'PDF 没有文本层（可能是扫描件），请先 OCR 或转 EPUB');

  const paragraphs = [];
  for (const line of lines) {
    for (const piece of splitLong(line)) paragraphs.push({ k: 'p', t: piece });
  }
  if (paragraphs.length < 3) throw fail('no-text-layer', 'PDF 文本层抽取失败');

  // 按 5000 字左右分节，避免整本一章
  const chapters = [];
  let chunk = [];
  let chars = 0;
  const flush = () => {
    if (chunk.length) chapters.push({ title: `第 ${chapters.length + 1} 节`, paragraphs: chunk });
    chunk = [];
    chars = 0;
  };
  for (const p of paragraphs) {
    chunk.push(p);
    chars += p.t.length;
    if (chars >= 5000) flush();
  }
  flush();

  const tm = buf.toString('latin1').match(/\/Title\s*\(((?:\\.|[^\\()])*)\)/);
  return {
    meta: { title: clean(tm ? unescapeLiteral(tm[1]) : opts.name || ''), author: '' },
    chapters,
    chars: paragraphs.reduce((n, p) => n + p.t.length, 0),
  };
}

module.exports = { parsePdf };
