'use strict';
// 多客户端 / 多书源并发同步缓存时的合并器。
// 身份：作品 = 归一化书名 + 作者；章节 = 章号（解析不出则标题归一化）或正文 sha1。
// 同一作品的所有来源写到同一个目录，章节取并集，正文保留多版本，写入用临时文件原子替换。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const locks = new Map();

/** 同一作品串行、不同作品并行。 */
function withWorkLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const keep = run.catch(() => {});
  locks.set(key, keep);
  keep.then(() => {
    if (locks.get(key) === keep) locks.delete(key);
  });
  return run;
}

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

/** 中文数字 → 整数，支持「十二」「一百零三」「两千零一十」这类写法。 */
function cnNumber(text) {
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let section = 0;
  let number = 0;
  let matched = false;
  for (const ch of text) {
    if (CN_DIGITS[ch] !== undefined) {
      number = CN_DIGITS[ch];
      matched = true;
    } else if (CN_UNITS[ch]) {
      section += (number || 1) * CN_UNITS[ch];
      number = 0;
      matched = true;
    } else if (ch === '万') {
      total += (section + number) * 10000;
      section = 0;
      number = 0;
      matched = true;
    } else {
      return null;
    }
  }
  if (!matched) return null;
  return total + section + number;
}

/** 从标题里取章号：第12章 / 第十二回 / 12. / 12 标题 等。 */
function chapterNumber(title) {
  const text = String(title || '').trim();
  if (!text) return null;
  const cn = text.match(/第\s*([0-9零一二两三四五六七八九十百千万]+)\s*[章节回卷集篇]/);
  if (cn) {
    const n = cnNumber(cn[1]);
    if (n !== null) return n;
  }
  const lead = text.match(/^\s*(\d{1,6})(?:\s|[.、:：-])/);
  if (lead) return Number(lead[1]);
  return null;
}

/** 标题归一化：全角转半角、去空白标点、小写。 */
function normTitle(title) {
  return String(title || '')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[《》「」【】\[\]()（）<>〈〉·・.。,:：;；!！?？"'’“”~～—\-_\s]/g, '')
    .toLowerCase();
}

function normName(name) {
  return String(name || '')
    .replace(/作者[:：]/g, '')
    .replace(/[《》「」【】\[\]()（）\s·・.。,:：;；!！?？"'’“”]/g, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/(全本|精校|完结|校对版|无删减|TXT|txt)+$/, '')
    .toLowerCase()
    .trim();
}

function workId(book) {
  return crypto.createHash('sha1')
    .update(`${normName(book && book.name)}|${normName(book && book.author)}`)
    .digest('hex')
    .slice(0, 16);
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
}

function safeName(name, max = 60) {
  return String(name || '未命名')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, max)
    .trim() || '未命名';
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 在 cache 根目录里找工作目录：workId → bookUrl → 书名+作者 → 书名目录 */
function findWorkDir(root, book, id) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return '';
  }
  const wantName = normName(book.name);
  const wantAuthor = normName(book.author);
  let byNameAuthor = '';
  let byBookUrl = '';
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    const meta = readMeta(dir);
    if (!meta) continue;
    if (meta.workId === id) return dir;
    if (!byBookUrl && book.bookUrl && meta.bookUrl === book.bookUrl) byBookUrl = dir;
    if (!byNameAuthor && wantName && normName(meta.name) === wantName && normName(meta.author) === wantAuthor) {
      byNameAuthor = dir;
    }
  }
  return byBookUrl || byNameAuthor;
}

function parseVariantMeta(chapter) {
  const list = Array.isArray(chapter.variants) ? chapter.variants : [];
  return list.map((v) => ({
    src: String(v.src || ''),
    sha: String(v.sha || ''),
    size: Number(v.size) || 0,
    at: Number(v.at) || 0,
    raw: String(v.raw || ''),
  }));
}

/**
 * 合并一次上传。
 * @param {object} options
 * @param {string} options.root cache 根目录
 * @param {object} options.book {name, author, bookUrl, origin, originName}
 * @param {Array} options.incoming [{title, rawText, paragraphs, images, file, url}]
 * @param {string} options.layout
 * @param {number} [options.now]
 */
async function mergeCache({ root, book, incoming, layout, now = Date.now() }) {
  const id = workId(book);
  const srcHash = sha1(`${book.bookUrl || ''}|${book.origin || ''}`).slice(0, 8);
  return withWorkLock(id, async () => {
    fs.mkdirSync(root, { recursive: true });
    let dir = findWorkDir(root, book, id);
    if (!dir) {
      dir = path.join(root, safeName(book.name, 80));
      for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${safeName(book.name, 80)} (${i})`);
    }
    fs.mkdirSync(path.join(dir, 'raw', srcHash), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });

    const oldMeta = readMeta(dir) || {};
    const oldChapters = Array.isArray(oldMeta.chapters) ? oldMeta.chapters : [];
    const incomingKeys = new Set();
    for (const ch of incoming) {
      const num = chapterNumber(ch.title);
      incomingKeys.add(num !== null ? `n:${num}` : `t:${normTitle(ch.title)}`);
    }

    // 旧章节：meta 里已有 key/sha 的直接用；只有「本次可能命中且缺 sha」的才读文件。
    // meta v2 的章节表本身就是增量索引，正常重传不再全量读盘。
    const canonical = oldChapters.map((c, i) => {
      const num = chapterNumber(c.title);
      const key = c.key || (num !== null ? `n:${num}` : `t:${normTitle(c.title)}`);
      return {
        key,
        num,
        title: String(c.title || `第${i + 1}章`),
        file: String(c.file || ''),
        url: String(c.url || ''),
        images: Array.isArray(c.images) ? c.images : [],
        len: Number(c.len) || 0,
        sha: String(c.sha || ''),
        variants: parseVariantMeta(c),
      };
    });

    // 只补算会被本次命中的旧章（并行读，避免 1375 次串行 readFileSync）
    const needHash = canonical.filter((c) => !c.sha && incomingKeys.has(c.key) && c.file);
    const PAR = 16;
    for (let i = 0; i < needHash.length; i += PAR) {
      await Promise.all(needHash.slice(i, i + PAR).map(async (c) => {
        try {
          const buf = await fs.promises.readFile(path.join(dir, c.file));
          c.sha = crypto.createHash('sha1').update(buf).digest('hex');
          if (!c.len) c.len = buf.toString('utf8').length;
        } catch { /* 文件缺失就当没有 sha */ }
      }));
    }

    const bySha = new Map();
    const byKey = new Map();
    canonical.forEach((c, index) => {
      if (c.sha) bySha.set(c.sha, index);
      if (c.key) byKey.set(c.key, index);
    });

    const stats = {
      workId: id,
      source: srcHash,
      sources: 0,
      incoming: incoming.length,
      added: 0,
      merged: 0,
      duplicates: 0,
      replaced: 0,
      splitMismatch: 0,
      canonical: 0,
      bytes: 0,
      rawSkipped: 0,
    };

    // 已经落地过的正文哈希（chosen + variants）：相同内容不再重复存 .nb
    const knownShas = new Set();
    for (const c of canonical) {
      if (c.sha) knownShas.add(c.sha);
      for (const v of c.variants || []) if (v.sha) knownShas.add(v.sha);
    }

    for (let i = 0; i < incoming.length; i++) {
      const ch = incoming[i];
      const title = String(ch.title || `第${i + 1}章`).trim();
      const text = String(ch.paragraphs.join('\n\n'));
      const rawText = String(ch.rawText || '');
      const len = text.length;
      const sha = sha1(text || rawText);
      const num = chapterNumber(title);
      const key = num !== null ? `n:${num}` : `t:${normTitle(title)}`;

      // 原文按来源分目录保存；内容与已存章节完全相同时不再重复落盘
      if (rawText) {
        if (knownShas.has(sha)) {
          stats.rawSkipped++;
        } else {
          const rawFile = safeName(ch.file || `${String(i + 1).padStart(4, '0')}-${normTitle(title)}.nb`);
          writeAtomic(path.join(dir, 'raw', srcHash, rawFile), rawText);
          stats.bytes += Buffer.byteLength(rawText, 'utf8');
          knownShas.add(sha);
        }
      }

      let index = bySha.has(sha) ? bySha.get(sha) : undefined;
      if (index === undefined && byKey.has(key)) index = byKey.get(key);

      if (index === undefined) {
        canonical.push({
          key, num, title, file: '', url: String(ch.url || ''),
          images: Array.isArray(ch.images) ? ch.images : [],
          len, sha, variants: [{ src: srcHash, sha, size: len, at: now, raw: '' }],
          __text: text,
        });
        index = canonical.length - 1;
        byKey.set(key, index);
        bySha.set(sha, index);
        stats.added++;
        continue;
      }

      const target = canonical[index];
      const variants = target.variants;
      // 正文与已选版本、或与已有变体完全相同 → 重复内容，不新增也不覆盖
      if (target.sha === sha || variants.some((v) => v.sha === sha)) {
        stats.duplicates++;
        continue;
      }
      // 同一章不同来源、正文不同 → 记 variant，正文取更长的一份
      variants.push({ src: srcHash, sha, size: len, at: now, raw: '' });
      stats.merged++;
      if (len > target.len) {
        if (target.len > 0 && len > target.len * 2.2) stats.splitMismatch++;
        target.len = len;
        target.sha = sha;
        target.title = title;
        target.__text = text;
        stats.replaced++;
      }
    }

    // 主顺序：有章号的按章号，无章号的追加在后面
    canonical.sort((a, b) => {
      const an = a.num;
      const bn = b.num;
      if (an !== null && bn !== null && an !== bn) return an - bn;
      return 0;
    });

    // 重新编号 + 写正文（未变化的文件不重写）
    const used = new Set();
    const chapters = [];
    for (let i = 0; i < canonical.length; i++) {
      const c = canonical[i];
      const idx = String(i + 1).padStart(4, '0');
      const file = `${idx} ${safeName(c.title)}.txt`;
      used.add(file);
      let text = c.__text;
      if (text === undefined) {
        try {
          text = c.file ? fs.readFileSync(path.join(dir, c.file), 'utf8') : '';
        } catch {
          text = '';
        }
      }
      if (c.__text !== undefined || file !== c.file) {
        if (text) writeAtomic(path.join(dir, file), text);
        stats.bytes += Buffer.byteLength(text || '', 'utf8');
        c.file = file;
      }
      chapters.push({
        index: i,
        title: c.title,
        url: c.url,
        file: c.file,
        key: c.key,
        num: c.num,
        sha: c.sha,
        len: c.len,
        variants: c.variants || [],
        images: c.images || [],
        imageFile: '',
        raw: '',
      });
      delete c.__text;
    }

    // 清掉被重新编号后遗留的旧正文
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.txt')) continue;
        if (used.has(name)) continue;
        try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // 统计各来源的 .nb 数量，供缓存页直接读 meta（不再每次递归扫目录）
    let nbFiles = 0;
    try {
      for (const name of fs.readdirSync(path.join(dir, 'raw'))) {
        try {
          nbFiles += fs.readdirSync(path.join(dir, 'raw', name)).filter((f) => f.endsWith('.nb')).length;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    oldMeta.counts = { ...(oldMeta.counts || {}), nbFiles };

    const srcKey = srcHash;
    const sources = { ...(oldMeta.sources || {}) };
    sources[srcKey] = {
      bookUrl: book.bookUrl || '',
      origin: book.origin || '',
      originName: book.originName || '',
      name: book.name || '',
      author: book.author || '',
      chapters: incoming.length,
      lastSync: now,
    };
    stats.sources = Object.keys(sources).length;
    stats.canonical = chapters.length;

    const meta = {
      version: 2,
      workId: id,
      layout,
      name: String(book.name || ''),
      author: String(book.author || ''),
      bookUrl: book.bookUrl || '',
      origin: String(book.origin || ''),
      originName: String(book.originName || ''),
      intro: String(book.intro || '').slice(0, 1000),
      totalChapterNum: chapters.length,
      durChapterIndex: Number(book.durChapterIndex || 0),
      savedAt: now,
      sources,
      counts: oldMeta.counts,
      stats: {
        added: stats.added,
        merged: stats.merged,
        duplicates: stats.duplicates,
        rawSkipped: stats.rawSkipped,
        replaced: stats.replaced,
        splitMismatch: stats.splitMismatch,
      },
      chapters,
    };
    writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    return { dir, meta, chapters, stats, sourceHash: srcHash };
  });
}

module.exports = { mergeCache, withWorkLock, workId, chapterNumber, normTitle, normName, sha1, cnNumber, writeAtomic };
