'use strict';
// 本地电子书：登记表 + 书目录 + 章节分片落盘
const fs = require('node:fs');
const path = require('node:path');

function dataRoot(dataDir) {
  return path.join(dataDir, 'ebook');
}
function indexPath(dataDir) {
  return path.join(dataRoot(dataDir), 'index.json');
}
function filesDir(dataDir) {
  return path.join(dataRoot(dataDir), 'files');
}
function bookDir(dataDir, sha1) {
  return path.join(dataRoot(dataDir), 'books', sha1);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function loadIndex(dataDir) {
  const list = readJson(indexPath(dataDir), []);
  return Array.isArray(list) ? list : [];
}

function saveIndex(dataDir, list) {
  writeJson(indexPath(dataDir), list);
}

function getEntry(dataDir, sha1) {
  return loadIndex(dataDir).find((e) => e.sha1 === sha1) || null;
}

function upsertEntry(dataDir, entry) {
  const list = loadIndex(dataDir);
  const idx = list.findIndex((e) => e.sha1 === entry.sha1);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry, updatedAt: Date.now() };
  else list.unshift({ ...entry, createdAt: entry.createdAt || Date.now(), updatedAt: Date.now() });
  saveIndex(dataDir, list);
  return getEntry(dataDir, entry.sha1);
}

function removeEntry(dataDir, sha1) {
  saveIndex(dataDir, loadIndex(dataDir).filter((e) => e.sha1 !== sha1));
}

function filePathOf(entry) {
  return entry && entry.file ? entry.file : '';
}

function readBook(dataDir, sha1) {
  return readJson(path.join(bookDir(dataDir, sha1), 'book.json'), null);
}

function writeBook(dataDir, sha1, book) {
  writeJson(path.join(bookDir(dataDir, sha1), 'book.json'), book);
}

function chapterPath(dataDir, sha1, index) {
  return path.join(bookDir(dataDir, sha1), 'ch', String(index).padStart(4, '0') + '.json');
}

function writeChapter(dataDir, sha1, chapter) {
  writeJson(chapterPath(dataDir, sha1, chapter.index), chapter);
}

function readChapter(dataDir, sha1, index) {
  return readJson(chapterPath(dataDir, sha1, index), null);
}

function partsDir(dataDir, sha1) {
  return path.join(bookDir(dataDir, sha1), 'parts');
}

function receivedParts(dataDir, sha1) {
  try {
    return fs
      .readdirSync(partsDir(dataDir, sha1))
      .filter((f) => f.endsWith('.done'))
      .map((f) => parseInt(f, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function markPart(dataDir, sha1, seq) {
  fs.mkdirSync(partsDir(dataDir, sha1), { recursive: true });
  fs.writeFileSync(path.join(partsDir(dataDir, sha1), String(seq).padStart(4, '0') + '.done'), '1');
}

function resetChapters(dataDir, sha1) {
  fs.rmSync(path.join(bookDir(dataDir, sha1), 'ch'), { recursive: true, force: true });
  fs.rmSync(partsDir(dataDir, sha1), { recursive: true, force: true });
}

module.exports = {
  dataRoot,
  filesDir,
  bookDir,
  loadIndex,
  saveIndex,
  getEntry,
  upsertEntry,
  removeEntry,
  filePathOf,
  readBook,
  writeBook,
  writeChapter,
  readChapter,
  receivedParts,
  markPart,
  resetChapters,
};
