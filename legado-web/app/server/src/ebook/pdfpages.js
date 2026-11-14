'use strict';
// PDF 原页渲染：用 Ghostscript 把每一页转成 PNG，阅读器可按页看图（含图表）
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const jobs = new Map(); // sha1 -> Promise

function pagesDir(dataDir, sha1) {
  return path.join(dataDir, 'ebook', 'books', sha1, 'pages');
}

function pageMetaPath(dataDir, sha1) {
  return path.join(pagesDir(dataDir, sha1), 'pages.json');
}

function readMeta(dataDir, sha1) {
  try {
    return JSON.parse(fs.readFileSync(pageMetaPath(dataDir, sha1), 'utf8'));
  } catch {
    return null;
  }
}

function pageCount(dataDir, sha1) {
  const meta = readMeta(dataDir, sha1);
  if (!meta) return 0;
  try {
    return fs.readdirSync(pagesDir(dataDir, sha1)).filter((f) => /^\d+\.png$/.test(f)).length;
  } catch {
    return 0;
  }
}

function pageFile(dataDir, sha1, n) {
  return path.join(pagesDir(dataDir, sha1), String(n).padStart(4, '0') + '.png');
}

/** 渲染所有页（幂等；同一本书同时只跑一个任务） */
function renderPages(dataDir, sha1, pdfFile, opts = {}) {
  if (jobs.has(sha1)) return jobs.get(sha1);
  const dpi = Math.max(72, Math.min(200, Number(opts.dpi) || 100));
  const dir = pagesDir(dataDir, sha1);
  fs.mkdirSync(dir, { recursive: true });
  const promise = new Promise((resolve, reject) => {
    const args = [
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-sDEVICE=png16m',
      '-r' + dpi,
      '-dTextAlphaBits=4',
      '-dGraphicsAlphaBits=4',
      '-sOutputFile=' + path.join(dir, '%04d.png'),
      pdfFile,
    ];
    execFile('gs', args, { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (err) => {
      jobs.delete(sha1);
      if (err) return reject(err);
      try {
        const count = fs.readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).length;
        fs.writeFileSync(
          pageMetaPath(dataDir, sha1),
          JSON.stringify({ dpi, count, renderedAt: Date.now() }, null, 2),
          'utf8'
        );
        resolve({ count, dpi });
      } catch (e) {
        reject(e);
      }
    });
  });
  jobs.set(sha1, promise);
  return promise;
}

function isRendering(sha1) {
  return jobs.has(sha1);
}

module.exports = { renderPages, pageCount, pageFile, pagesDir, readMeta, isRendering };
