'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const { normalizeSource, getContent, getToc, getBookInfo, searchSource } = require('../fnos-legado/app/server/src/books');

const src = normalizeSource({
  bookSourceName: 'dbg',
  bookSourceUrl: 'http://127.0.0.1:18080',
  searchUrl: 'http://127.0.0.1:18080/search?q={{key}}',
  ruleSearch: { bookList: '.result', name: '.title@text', author: '.author@text', bookUrl: '.title@href', coverUrl: 'img@src' },
  ruleBookInfo: { name: '#info h1@text', tocUrl: 'a.toc@href', introduce: '#info .intro@text' },
  ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '#content@html', nextContentUrl: '#next@href' },
});

const mock = spawn(NODE, [path.join(__dirname, 'mock-site.js')], { stdio: 'ignore' });

(async () => {
  await new Promise((r) => setTimeout(r, 600));
  const books = await searchSource(src, '测试', 1);
  console.log('search:', books.length, books[0] && books[0].name);
  const book = books[0];
  await getBookInfo(src, book);
  console.log('tocUrl:', book.tocUrl, 'intro:', book.intro);
  const toc = await getToc(src, book);
  console.log('toc:', toc.length, toc[0]);
  const paras = await getContent(src, book, toc[0]);
  console.log('paragraphs:', paras);
  mock.kill();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  mock.kill();
  process.exit(1);
});
