'use strict';

const _fs = require('node:fs');
const _path = require('node:path');
const _root = _path.resolve(__dirname, '..');
const APP_DIR = ['legado-web', 'fnos-legado'].find((d) => _fs.existsSync(_path.join(_root, d))) || 'legado-web';
// 用本地假 JSON API 验证：搜索 → 目录 → 正文 全链路（模拟 mgz0227 书源包的写法）
const http = require('node:http');
const { normalizeSource, searchSource, getToc, getContent } = require('../' + APP_DIR + '/app/server/src/books');

const PORT = 19090;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (u.pathname === '/search') {
    res.end(JSON.stringify({ data: { list: [
      { book_id: '1', name: '测试之书', author: '作者甲', abstract: '这是一段简介', category: '玄幻', score: 9.2 },
    ] } }));
    return;
  }
  if (u.pathname === '/toc') {
    res.end(JSON.stringify({ data: { item_list: [
      { item_id: '10', title: '第一章 开端' },
      { item_id: '11', title: '第二章 发展' },
    ] } }));
    return;
  }
  if (u.pathname === '/content') {
    res.end(JSON.stringify({ data: { content: '<div><p>第一段正文。</p><p>第二段正文。</p></div>' } }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

const SOURCE = {
  bookSourceName: 'JSON测试源',
  bookSourceUrl: 'http://127.0.0.1:' + PORT,
  searchUrl: `http://127.0.0.1:${PORT}/search?q={{key}}`,
  ruleSearch: {
    bookList: '$.data.list[*]',
    name: '$.name',
    author: '$.author',
    intro: '$.abstract',
    kind: '{{$.category}},{{$.score}}分',
    bookUrl: `http://127.0.0.1:${PORT}/toc?group_id={{$.book_id}}`,
  },
  ruleToc: {
    chapterList: '$.data.item_list[*]',
    chapterName: '$.title',
    chapterUrl: `http://127.0.0.1:${PORT}/content?id={$..item_id}`,
  },
  ruleContent: { content: '$.data.content<js>result</js>@@p@textNodes' },
};

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const src = normalizeSource(SOURCE);
  let ok = 0;
  let fail = 0;
  const check = (cond, label, extra) => {
    if (cond) {
      ok++;
      console.log('  ✓', label);
    } else {
      fail++;
      console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 120));
    }
  };

  try {
    console.log('\n== 搜索');
    const books = await searchSource(src, '测试', 1);
    check(books.length === 1, '搜到 1 本', books.length);
    if (books[0]) {
      check(books[0].name === '测试之书', '书名', books[0].name);
      check(books[0].kind === '玄幻,9.2分', '模板字段', books[0].kind);
      check(books[0].bookUrl.includes('group_id=1'), 'bookUrl 插值', books[0].bookUrl);
    }

    console.log('\n== 目录');
    const book = { ...books[0] };
    const chapters = await getToc(src, book);
    check(chapters.length === 2, '2 章', chapters.length);
    check(chapters[0] && chapters[0].title === '第一章 开端', '章节名', chapters[0] && chapters[0].title);
    check(chapters[0] && chapters[0].url.includes('id=10'), `{$..item_id} 插值`, chapters[0] && chapters[0].url);

    console.log('\n== 正文');
    const content = await getContent(src, book, chapters[0]);
    const paras = content.paragraphs || content;
    check(Array.isArray(paras) && paras.length === 2, '2 段正文', paras);
    check(String(paras[0] || '').includes('第一段正文'), '<js>+@@p 处理', paras[0]);
  } catch (e) {
    fail++;
    console.log('异常：', e.message);
  }

  console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
