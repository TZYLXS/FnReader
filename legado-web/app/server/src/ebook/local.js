'use strict';
// 本地解析 + 客户端分片入库
const fs = require('node:fs');
const { parseEpub } = require('./epub');
const { parseMobi } = require('./mobi');
const { parsePdf } = require('./pdf');
const { parseTxt } = require('./text');
const { clean } = require('./html');
const store = require('./store');

const SCHEMA = 'fnreader.ebook.v1';

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function parseByFormat(buf, format, name) {
  if (format === 'epub') return parseEpub(buf, { name });
  if (format === 'mobi') return parseMobi(buf, { name });
  if (format === 'pdf') return parsePdf(buf, { name });
  return parseTxt(buf, { name });
}

function buildToc(chapters) {
  return chapters.map((ch, index) => ({
    id: 'ch' + String(index + 1).padStart(4, '0'),
    title: ch.title || `第 ${index + 1} 章`,
    level: ch.level || 1,
    index,
  }));
}

/** 服务端本机解析一本，直接落盘 */
function parseLocal(dataDir, entry) {
  const file = entry.file;
  if (!fs.existsSync(file)) throw fail('missing', '原文件不存在');
  const buf = fs.readFileSync(file);
  const parsed = parseByFormat(buf, entry.format, entry.name);
  if (!parsed.chapters || !parsed.chapters.length) throw fail('corrupt', '解析不出任何章节');
  if (parsed.chapters.length > 3000) throw fail('too-large', `章节数超过 3000：${parsed.chapters.length}`);

  const toc = buildToc(parsed.chapters);
  const stats = {
    chapters: parsed.chapters.length,
    chars: parsed.chars || 0,
  };
  const book = {
    schema: SCHEMA,
    sha1: entry.sha1,
    format: entry.format,
    name: entry.name,
    meta: { ...parsed.meta, title: clean(parsed.meta.title || entry.name) },
    toc,
    stats,
    source: 'server',
    status: 'complete',
    updatedAt: Date.now(),
  };

  store.resetChapters(dataDir, entry.sha1);
  store.writeBook(dataDir, entry.sha1, book);
  parsed.chapters.forEach((ch, index) => {
    store.writeChapter(dataDir, entry.sha1, {
      schema: SCHEMA,
      sha1: entry.sha1,
      index,
      id: toc[index].id,
      title: toc[index].title,
      paragraphs: ch.paragraphs,
    });
  });
  store.upsertEntry(dataDir, {
    sha1: entry.sha1,
    status: 'complete',
    source: 'server',
    chapters: toc.length,
    parts: 1,
    totalParts: 1,
    error: '',
  });
  return { chapters: toc.length, chars: stats.chars, meta: book.meta, toc };
}

/** 校验客户端上传的分片并写盘 */
function acceptPart(dataDir, entry, seq, total, payload) {
  if (!payload || payload.schema !== SCHEMA) throw fail('schema', 'schema 不匹配');
  if (!payload.sha1 || payload.sha1 !== entry.sha1) throw fail('sha1', 'sha1 不一致');
  if (!Number.isInteger(total) || total < 1 || total > 10000) throw fail('total', 'total 不合法');
  if (!Number.isInteger(seq) || seq < 0 || seq >= total) throw fail('seq', 'seq 不合法');

  if (seq === 0) {
    if (!Array.isArray(payload.toc) || !payload.toc.length) throw fail('toc', 'part0 缺少 toc');
    if (payload.toc.length > 3000) throw fail('too-large', '目录超过 3000 条');
    const toc = payload.toc.map((t, i) => ({
      id: String(t.id || 'ch' + String(i + 1).padStart(4, '0')),
      title: String(t.title || `第 ${i + 1} 章`),
      level: Math.max(1, Math.min(6, Number(t.level) || 1)),
      index: i,
    }));
    const book = {
      schema: SCHEMA,
      sha1: entry.sha1,
      format: entry.format,
      name: entry.name,
      meta: payload.meta || { title: entry.name },
      toc,
      stats: {
        chapters: toc.length,
        parts: total,
        chars: Number(payload.stats && payload.stats.chars) || 0,
      },
      source: 'device',
      status: 'partial',
      updatedAt: Date.now(),
    };
    store.writeBook(dataDir, entry.sha1, book);
    store.markPart(dataDir, entry.sha1, 0);
    store.upsertEntry(dataDir, {
      sha1: entry.sha1,
      status: 'partial',
      source: 'device',
      chapters: toc.length,
      parts: store.receivedParts(dataDir, entry.sha1).length,
      totalParts: total,
      error: '',
    });
    return { chapters: toc.length, total };
  }

  if (!Array.isArray(payload.chapters) || !payload.chapters.length) throw fail('chapters', '分片里没有章节');
  if (payload.chapters.length > 200) throw fail('too-large', '单片章节超过 200');

  const book = store.readBook(dataDir, entry.sha1);
  if (!book || !book.toc) throw fail('no-toc', '还没收到 part0');

  for (const ch of payload.chapters) {
    const index = Number(ch.index);
    if (!Number.isInteger(index) || index < 0 || index >= book.toc.length) throw fail('index', '章节号越界');
    if (!Array.isArray(ch.paragraphs)) throw fail('paragraphs', '章节缺少 paragraphs');
    const paragraphs = ch.paragraphs
      .map((p) => ({ k: String((p && p.k) || 'p').slice(0, 8), t: String((p && p.t) || '') }))
      .filter((p) => p.t || p.k === 'hr');
    store.writeChapter(dataDir, entry.sha1, {
      schema: SCHEMA,
      sha1: entry.sha1,
      index,
      id: book.toc[index].id,
      title: book.toc[index].title,
      paragraphs,
    });
  }
  store.markPart(dataDir, entry.sha1, seq);

  const received = store.receivedParts(dataDir, entry.sha1);
  const complete = received.length >= total;
  if (complete) {
    book.status = 'complete';
    book.source = 'device';
    book.updatedAt = Date.now();
    store.writeBook(dataDir, entry.sha1, book);
    store.upsertEntry(dataDir, { sha1: entry.sha1, status: 'complete', source: 'device', chapters: book.toc.length, parts: received.length });
  } else {
    store.upsertEntry(dataDir, { sha1: entry.sha1, status: 'partial', parts: received.length });
  }
  return { chapters: book.toc.length, total, received, complete };
}

module.exports = { SCHEMA, parseLocal, acceptPart, parseByFormat };
