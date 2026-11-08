'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.TRIM_PKGVAR || process.env.LEGADO_DATA || path.join(process.cwd(), 'data');
const FILES = {
  sources: path.join(DATA_DIR, 'sources.json'),
  books: path.join(DATA_DIR, 'books.json'),
  config: path.join(DATA_DIR, 'config.json'),
};

const DEFAULT_CONFIG = {
  theme: 'light',
  fontSize: 19,
  lineHeight: 1.85,
  fontFamily: '',
  pageWidth: 720,
};

let cache = null;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  const read = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  cache = {
    sources: read(FILES.sources, []),
    books: read(FILES.books, []),
    config: { ...DEFAULT_CONFIG, ...read(FILES.config, {}) },
  };
  return cache;
}

function persist(key) {
  ensureDir();
  const data = load()[key];
  const tmp = FILES[key] + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, key === 'config' ? 2 : 0), 'utf8');
  fs.renameSync(tmp, FILES[key]);
}

const store = {
  dataDir: DATA_DIR,
  get sources() {
    return load().sources;
  },
  // 兼容旧写法：允许直接赋值 store.sources = [...]（等价 saveSources）
  set sources(list) {
    if (Array.isArray(list)) this.saveSources(list);
  },
  get books() {
    return load().books;
  },
  get config() {
    return load().config;
  },
  saveSources(list) {
    load().sources = list;
    persist('sources');
  },
  saveBooks(list) {
    load().books = list;
    persist('books');
  },
  saveConfig(cfg) {
    load().config = { ...load().config, ...cfg };
    persist('config');
  },
  /**
   * 按 bookSourceUrl 合并一条书源（存在则覆盖字段，不存在则新增）
   * 任何调用方都可以用，避免各处重复实现
   */
  upsertSource(src) {
    if (!src || !src.bookSourceUrl) return null;
    const list = load().sources;
    const idx = list.findIndex((x) => x.bookSourceUrl === src.bookSourceUrl);
    if (idx >= 0) list[idx] = { ...list[idx], ...src };
    else list.push({ ...src, enabled: src.enabled !== false });
    persist('sources');
    return idx >= 0 ? list[idx] : list[list.length - 1];
  },

  findBook(bookUrl) {
    return load().books.find((b) => b.bookUrl === bookUrl) || null;
  },
  findSource(id) {
    return load().sources.find((s) => s.bookSourceUrl === id) || null;
  },
  upsertBook(book) {
    const books = load().books;
    const idx = books.findIndex((b) => b.bookUrl === book.bookUrl);
    if (idx >= 0) books[idx] = { ...books[idx], ...book };
    else books.unshift(book);
    persist('books');
    return idx >= 0 ? books[idx] : books[0];
  },
  removeBook(bookUrl) {
    const books = load().books;
    const next = books.filter((b) => b.bookUrl !== bookUrl);
    load().books = next;
    persist('books');
  },
};

module.exports = store;
