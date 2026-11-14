'use strict';
// EPUB 解析（服务端兜底）：zip → container.xml → OPF spine + NCX
const zlib = require('node:zlib');
const cheerio = require('cheerio');
const { htmlToBlocks, clean } = require('./html');

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function readZip(buf) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail('corrupt', '不是有效的 EPUB（找不到 zip 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, csize, usize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const lp = e.localOffset;
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw fail('corrupt', 'zip 本地头损坏');
    const nameLen = buf.readUInt16LE(lp + 26);
    const extraLen = buf.readUInt16LE(lp + 28);
    const start = lp + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) {
      try {
        return zlib.inflateRawSync(data);
      } catch {
        throw fail('corrupt', `解压失败：${name}`);
      }
    }
    throw fail('unsupported', `不支持的压缩方式 ${e.method}：${name}`);
  };

  return { entries, read };
}

function decodeXmlText(s) {
  const $ = cheerio.load(`<x>${s}</x>`, { xmlMode: true }, false);
  return clean($('x').text());
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}

function parseNcx(xml, baseDir) {
  const map = new Map();
  const navRe = /<navPoint\b[^>]*>|<\/navPoint>|<title>([\s\S]*?)<\/title>|<src[^>]*>([^<]*)<\/src>/gi;
  const stack = [];
  let current = null;
  let m;
  while ((m = navRe.exec(xml))) {
    const token = m[0];
    if (/^<navPoint/i.test(token)) {
      stack.push({ title: '', src: '' });
      current = stack[stack.length - 1];
    } else if (/^<\/navPoint/i.test(token)) {
      const done = stack.pop();
      if (done && done.src) {
        const href = done.src.split('#')[0];
        if (href) map.set(resolvePath(baseDir, href), { title: decodeXmlText(done.title), level: Math.max(1, stack.length + 1) });
      }
      current = stack[stack.length - 1] || null;
    } else if (m[1] !== undefined && current) {
      current.title = m[1];
    } else if (m[2] !== undefined && current) {
      current.src = m[2];
    }
  }
  return map;
}

function resolvePath(baseDir, href) {
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg) parts.push(seg);
  }
  return parts.join('/');
}

function parseEpub(buf, opts = {}) {
  const zip = readZip(buf);
  if (zip.entries.has('META-INF/encryption.xml')) {
    const enc = zip.read('META-INF/encryption.xml')?.toString('utf8') || '';
    if (/<EncryptedReference/i.test(enc)) throw fail('drm', '这本书带 DRM 加密');
  }
  const container = zip.read('META-INF/container.xml');
  if (!container) throw fail('corrupt', 'EPUB 缺少 container.xml');
  const cm = String(container.toString('utf8')).match(/full-path\s*=\s*"([^"]+)"/i);
  if (!cm) throw fail('corrupt', 'container.xml 里没有 OPF 路径');
  const opfPath = cm[1];
  const opfBuf = zip.read(opfPath);
  if (!opfBuf) throw fail('corrupt', 'OPF 文件不存在：' + opfPath);
  const opf = opfBuf.toString('utf8');
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const manifest = new Map();
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    if (a.id && a.href) manifest.set(a.id, { href: a.href, type: a['media-type'] || '', props: a.properties || '' });
  }
  const spine = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    if (a.idref && manifest.has(a.idref)) spine.push(manifest.get(a.idref));
  }
  if (!spine.length) throw fail('corrupt', 'EPUB spine 为空');

  const ncxItem = [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml');
  let tocMap = new Map();
  if (ncxItem) {
    const ncx = zip.read(resolvePath(baseDir, ncxItem.href));
    if (ncx) tocMap = parseNcx(String(ncx.toString('utf8')), baseDir);
  }

  const meta = {
    title: decodeXmlText((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || opts.name || ''),
    author: decodeXmlText((opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || ''),
    language: decodeXmlText((opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i) || [])[1] || ''),
    publisher: decodeXmlText((opf.match(/<dc:publisher[^>]*>([\s\S]*?)<\/dc:publisher>/i) || [])[1] || ''),
    publishedAt: decodeXmlText((opf.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i) || [])[1] || ''),
    isbn: decodeXmlText((opf.match(/<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/i) || [])[1] || ''),
    description: decodeXmlText((opf.match(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i) || [])[1] || ''),
  };

  const chapters = [];
  for (const item of spine) {
    if (chapters.length >= 3000) break;
    if (!/html|xml/.test(item.type) && !/\.(xhtml|html|htm)$/i.test(item.href)) continue;
    const path = resolvePath(baseDir, item.href);
    const file = zip.read(path);
    if (!file) continue;
    const html = file.toString('utf8');
    const tocEntry = tocMap.get(path);
    let title = tocEntry ? tocEntry.title : '';
    if (!title) {
      const h = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
      title = h ? decodeXmlText(h[1]) : '';
    }
    if (!title) title = `第 ${chapters.length + 1} 章`;
    const paragraphs = htmlToBlocks(html, { dropTitle: title });
    if (!paragraphs.length) continue;
    chapters.push({ title, level: tocEntry ? tocEntry.level : 1, paragraphs });
  }
  if (!chapters.length) throw fail('corrupt', 'EPUB 正文为空');

  return {
    meta,
    chapters,
    chars: chapters.reduce((n, ch) => n + ch.paragraphs.reduce((m, p) => m + p.t.length, 0), 0),
  };
}

module.exports = { parseEpub, readZip };
