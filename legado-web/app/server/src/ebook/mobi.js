'use strict';
// MOBI / AZW 解析：PalmDB 记录表 + PalmDOC 解压 + MOBI 头 + EXTH
// 纯 JS 实现，服务端兜底与客户端 Kotlin 版保持同一套规则。
const cheerio = require('cheerio');
const { htmlToBlocks, clean } = require('./html');

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeText(bytes, encoding) {
  if (encoding === 65001) return Buffer.from(bytes).toString('utf8');
  if (encoding === 1252) {
    let s = '';
    for (const b of bytes) s += CP1252[b] || String.fromCharCode(b);
    return s;
  }
  return Buffer.from(bytes).toString('latin1');
}

/** PalmDOC LZ77：把一组文本记录解压到同一个缓冲区（反向引用允许跨记录） */
function decompressRecords(records, compression, textLength) {
  const out = Buffer.alloc(Math.max(4096, textLength + 4096));
  let pos = 0;

  const append = (b) => {
    if (pos < out.length) out[pos++] = b;
  };
  const copyBack = (distance, length) => {
    let src = pos - distance;
    if (src < 0) src = 0;
    for (let i = 0; i < length; i++) append(out[src + i]);
  };

  for (const rec of records) {
    if (compression === 1) {
      for (const b of rec) append(b);
      continue;
    }
    // compression 2：每条记录前 2 字节是解压后长度，随后是 token 流
    let i = 2;
    while (i < rec.length) {
      const b = rec[i++];
      if (b === 0) {
        if (i < rec.length) append(rec[i++]);
      } else if (b <= 8) {
        for (let k = 0; k < b && i < rec.length; k++) append(rec[i++]);
      } else if (b <= 0x7f) {
        append(b);
      } else if (b <= 0xbf) {
        const next = rec[i++];
        const length = (b & 0x07) + 3;
        const distance = ((b & 0x78) << 5) | (next || 0);
        copyBack(distance, length);
      } else {
        append(0x20);
        append(b ^ 0x80);
      }
    }
    if (pos >= textLength) break;
  }
  return out.subarray(0, Math.min(pos, textLength));
}

function readExth(record0, mobiHeaderLen) {
  const buf = record0;
  let at = -1;
  const from = 16 + mobiHeaderLen;
  const limit = Math.min(buf.length - 4, from + 1024);
  for (let i = from; i <= limit; i++) {
    if (buf.toString('latin1', i, i + 4) === 'EXTH') {
      at = i;
      break;
    }
  }
  if (at < 0) return {};
  const count = buf.readUInt32BE(at + 8);
  const out = {};
  let p = at + 12;
  for (let n = 0; n < count && p + 8 <= buf.length; n++) {
    const type = buf.readUInt32BE(p);
    const len = buf.readUInt32BE(p + 4);
    if (len < 8 || p + len > buf.length) break;
    const data = buf.subarray(p + 8, p + len);
    if (type === 100) out.author = data.toString('utf8');
    if (type === 503) out.title = data.toString('utf8');
    if (type === 524) out.language = data.toString('utf8');
    p += len;
  }
  return out;
}

function stripHtmlTitle(html) {
  return clean(cheerio.load(`<x>${html}</x>`, null, false)('x').text());
}

/** 按 h1~h3 / pagebreak 切章；都找不到就整本一章 */
function splitChapters(html) {
  const headingRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const marks = [];
  let m;
  while ((m = headingRe.exec(html))) {
    marks.push({ start: m.index, contentStart: headingRe.lastIndex, level: Number(m[1]), rawTitle: m[2] });
  }
  if (marks.length >= 2) {
    const chapters = [];
    if (marks[0].start > 0) {
      const preface = html.slice(0, marks[0].start);
      if (clean(stripHtmlTitle(preface)).length > 200) {
        chapters.push({ title: '前言', html: preface });
      }
    }
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : html.length;
      chapters.push({
        title: stripHtmlTitle(mk.rawTitle) || `第 ${chapters.length + 1} 章`,
        html: html.slice(mk.contentStart, end),
      });
    });
    return chapters;
  }

  // 没有标题：按 pagebreak 分段，按字符预算合并
  const parts = html.split(/<mbp:pagebreak\b[^>]*\/?>|<\/?mbp:pagebreak\b[^>]*>/i).filter((s) => s.trim());
  if (parts.length > 5) {
    const chapters = [];
    let buf = '';
    let chars = 0;
    for (const part of parts) {
      buf += part;
      chars += clean(stripHtmlTitle(part)).length;
      if (chars > 200000) {
        chapters.push({ title: `第 ${chapters.length + 1} 章`, html: buf });
        buf = '';
        chars = 0;
      }
    }
    if (buf.trim()) chapters.push({ title: `第 ${chapters.length + 1} 章`, html: buf });
    if (chapters.length > 1) return chapters;
  }
  return [{ title: '', html }];
}

/**
 * @param {Buffer} buf 整个 MOBI 文件
 * @param {{name?:string}} opts
 * @returns {{meta:object, chapters:{title:string, paragraphs:{k:string,t:string}[]}[]}}
 */
function parseMobi(buf, opts = {}) {
  if (!buf || buf.length < 100) throw fail('corrupt', '文件太小');
  const type = buf.toString('latin1', 60, 64);
  const creator = buf.toString('latin1', 64, 68);
  if (type !== 'BOOK' || creator !== 'MOBI') {
    throw fail('unsupported', `不是 MOBI 文件（type=${type}, creator=${creator}）`);
  }
  const numRecords = buf.readUInt16BE(76);
  const offsets = [];
  for (let i = 0; i < numRecords; i++) {
    offsets.push(buf.readUInt32BE(78 + i * 8));
  }
  if (!offsets.length) throw fail('corrupt', '记录表为空');
  const rec = (i) => {
    if (i < 0 || i >= offsets.length) return Buffer.alloc(0);
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    return buf.subarray(start, end);
  };

  const record0 = rec(0);
  if (record0.length < 16) throw fail('corrupt', 'PalmDOC 头缺失');
  const compression = record0.readUInt16BE(0);
  const textLength = record0.readUInt32BE(4);
  const recordCount = record0.readUInt16BE(8);
  const encryption = record0.readUInt16BE(12);
  if (encryption !== 0) throw fail('drm', '这本书带 DRM 加密');

  let encoding = 1252;
  let version = 6;
  let headerLen = 0;
  let fullName = '';
  let exth = {};
  if (record0.toString('latin1', 16, 20) === 'MOBI') {
    headerLen = record0.readUInt32BE(20);
    encoding = record0.readUInt32BE(28);
    version = record0.readUInt32BE(36);
    // MOBI 头的字段偏移以 MOBI 头起点（record0 偏移 16）为基准
    const nameOff = record0.readUInt32BE(16 + 0x54);
    const nameLen = record0.readUInt32BE(16 + 0x58);
    if (nameOff > 0 && nameLen > 0 && nameOff + nameLen <= record0.length) {
      fullName = decodeText(record0.subarray(nameOff, nameOff + nameLen), encoding);
    }
    exth = readExth(record0, headerLen);
  }
  if (version >= 8) throw fail('kf8-unsupported', '这是 KF8（AZW3）结构，v1 暂不支持，请转 EPUB');

  const textRecords = [];
  const last = Math.min(recordCount, offsets.length - 1);
  for (let i = 1; i <= last; i++) textRecords.push(rec(i));
  if (!textRecords.length) throw fail('corrupt', '没有正文记录');

  const bytes = decompressRecords(textRecords, compression, textLength || 0);
  const html = decodeText(bytes, encoding);
  if (!html || !html.trim()) throw fail('corrupt', '正文解压为空');

  const chapters = splitChapters(html).map((ch, index) => {
    const title = ch.title || `第 ${index + 1} 章`;
    return { title, paragraphs: htmlToBlocks(ch.html, { dropTitle: title }) };
  });
  const totalChars = chapters.reduce(
    (n, ch) => n + ch.paragraphs.reduce((m, p) => m + p.t.length, 0),
    0
  );

  const meta = {
    title: clean(fullName || exth.title || opts.name || '未命名'),
    author: clean(exth.author || ''),
    language: clean(exth.language || ''),
  };
  return { meta, chapters, chars: totalChars, encoding };
}

module.exports = { parseMobi };
