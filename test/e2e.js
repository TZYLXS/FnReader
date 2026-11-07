'use strict';
// 端到端测试：模拟站点 -> 书源规则 -> 搜索/目录/正文/进度
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'fnos-legado', 'app', 'server', 'src', 'server.js');
const MOCK = path.join(__dirname, 'mock-site.js');
const PORT = 18100;
const MOCK_PORT = 18080;
const MOCK_ORIGIN = 'http://127.0.0.1:18080';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-test-'));

const CSS_SOURCE = {
  bookSourceName: '本地测试源-CSS',
  bookSourceUrl: 'http://127.0.0.1:18080',
  bookSourceGroup: '测试',
  bookSourceType: 0,
  enabled: true,
  searchUrl: 'http://127.0.0.1:18080/search?q={{key}}',
  ruleSearch: {
    bookList: '.result',
    name: '.title@text',
    author: '.author@text',
    kind: '.kind@text',
    bookUrl: '.title@href',
    coverUrl: 'img@src',
  },
  ruleBookInfo: {
    name: '#info h1@text',
    author: '#info .author@text',
    kind: '#info .kind@text',
    introduce: '#info .intro@text',
    tocUrl: 'a.toc@href',
  },
  ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '#content@html', nextContentUrl: '#next@href' },
};

const XPATH_SOURCE = {
  bookSourceName: '本地测试源-XPath',
  bookSourceUrl: 'http://127.0.0.1:18080/x',
  bookSourceType: 0,
  enabled: true,
  searchUrl: 'http://127.0.0.1:18080/search?q={{key}}',
  ruleSearch: {
    bookList: '//div[@class="result"]',
    name: '//a[@class="title"]/text()',
    author: '//span[@class="author"]/text()',
    bookUrl: '//a[@class="title"]/@href',
  },
  ruleBookInfo: { name: "//div[@id=\"info\"]/h1/text()", tocUrl: "//a[@class=\"toc\"]/@href" },
  ruleToc: { chapterList: "//ul[@id=\"list\"]/li", chapterName: './/a/text()', chapterUrl: './/a/@href' },
  ruleContent: { content: '//div[@id="content"]' },
};

let passed = 0;
let failed = 0;
function check(cond, label, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

function waitFor(url, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = async (n) => {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve();
      } catch {
        /* retry */
      }
      if (n <= 0) return reject(new Error('timeout ' + url));
      setTimeout(() => tick(n - 1), 200);
    };
    tick(tries);
  });
}

async function readSSE(url) {
  const res = await fetch(url);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const p of parts) {
      const line = p.trim();
      if (line.startsWith('data:')) {
        try {
          events.push(JSON.parse(line.slice(5).trim()));
        } catch {
          /* ignore */
        }
      }
    }
  }
  return events;
}

(async () => {
  const procs = [];
  const cleanup = () => procs.forEach((p) => p.kill());
  process.on('exit', cleanup);

  const mock = spawn(NODE, [MOCK], { env: { ...process.env, MOCK_PORT } , stdio: 'ignore' });
  procs.push(mock);

  const server = spawn(NODE, [SERVER], {
    env: {
      ...process.env,
      PORT,
      TRIM_SERVICE_PORT: PORT,
      LEGADO_DATA: DATA,
      TRIM_APPDEST: path.join(DATA, 'target'),
      LEGADO_WEB: path.join(ROOT, 'fnos-legado', 'app', 'web'),
    },
    stdio: 'ignore',
  });
  procs.push(server);

  await waitFor(`http://127.0.0.1:${PORT}/api/health`);
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/search?q=x`);
  const base = `http://127.0.0.1:${PORT}`;
  console.log('\n== 1. 书源导入 ==');
  let r = await fetch(base + '/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources: [CSS_SOURCE, XPATH_SOURCE] }),
  });
  let d = await r.json();
  check(d.imported === 2, '导入 2 个书源', JSON.stringify(d));

  r = await fetch(base + '/api/sources');
  d = await r.json();
  check(d.sources.length === 2, '书源列表返回 2 个');

  console.log('\n== 2. 搜索（SSE 流式） ==');
  const events = await readSSE(base + '/api/search?key=' + encodeURIComponent('测试'));
  const results = events.filter((e) => e.type === 'result');
  const books = results.flatMap((e) => e.books);
  check(results.length === 2, '两个书源都返回结果', `got ${results.length}`);
  check(books.length === 2, '共 2 条搜索结果', `got ${books.length}`);
  check(!!books[0].name, '书名非空: ' + (books[0] && books[0].name));
  check(/^https?:\/\//.test(books[0].bookUrl), 'bookUrl 已是绝对地址: ' + books[0].bookUrl);
  check(!!books[0].coverUrl, '封面地址已解析: ' + books[0].coverUrl);

  // 搜索结果缓存：同一个 URL 第二次走缓存
  const cache1 = await (await fetch(base + '/api/searchcache')).json();
  check(cache1.entries >= 1, '搜索缓存已写入 ' + cache1.entries + ' 条');
  const t0 = Date.now();
  const events2 = await readSSE(base + '/api/search/' + '?key=' + encodeURIComponent('测试'));
  const t1 = Date.now();
  const books2 = events2.filter((e) => e.type === 'result').flatMap((e) => e.books);
  check(books2.length === books.length, '缓存命中返回相同数量的结果');
  check(t1 - t0 < 1500, '第二次搜索走缓存（' + (t1 - t0) + 'ms）');

  console.log('\n== 3. 加入书架 ==');
  const cssBook = books.find((b) => b.originName.includes('CSS'));
  r = await fetch(base + '/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cssBook),
  });
  d = await r.json();
  check(d.ok === true, '加入书架成功');

  console.log('\n== 4. 目录 ==');
  r = await fetch(base + '/api/toc?url=' + encodeURIComponent(cssBook.bookUrl));
  d = await r.json();
  check(Array.isArray(d.chapters) && d.chapters.length === 3, '目录 3 章', JSON.stringify(d).slice(0, 200));
  check(d.chapters && d.chapters[0].title === '第1章 初见', '章节标题正确');
  check(d.chapters && /^http:\/\/127\.0\.0\.1:18080\/chapter\/1$/.test(d.chapters[0].url), '章节地址绝对化');

  console.log('\n== 5. 正文（含分页） ==');
  r = await fetch(base + '/api/content?url=' + encodeURIComponent(cssBook.bookUrl) + '&index=0');
  d = await r.json();
  check(d.title === '第1章 初见', '正文标题正确');
  check(d.paragraphs.length === 3, '正文两页合并为 3 段', JSON.stringify(d.paragraphs));
  check(d.paragraphs[2].includes('分页后的第三段'), '第二页内容已拼接');
  check(d.total === 3, '总章节数 3');

  console.log('\n== 6. 阅读进度 ==');
  r = await fetch(base + '/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookUrl: cssBook.bookUrl, index: 1, title: '第2章 远行' }),
  });
  d = await r.json();
  check(d.ok, '进度保存成功');
  r = await fetch(base + '/api/books');
  d = await r.json();
  const saved = d.books.find((b) => b.bookUrl === cssBook.bookUrl);
  check(saved && saved.durChapterIndex === 1, '进度已落库');
  check(saved && saved.durChapterTitle === '第2章 远行', '章节标题已记录');

  console.log('\n== 7. XPath 书源 ==');
  const xbook = books.find((b) => b.originName.includes('XPath'));
  r = await fetch(base + '/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(xbook),
  });
  await r.json();
  r = await fetch(base + '/api/toc?url=' + encodeURIComponent(xbook.bookUrl));
  d = await r.json();
  check(d.chapters && d.chapters.length === 3, 'XPath 目录 3 章', JSON.stringify(d).slice(0, 200));
  r = await fetch(base + '/api/content?url=' + encodeURIComponent(xbook.bookUrl) + '&index=1');
  d = await r.json();
  check(d.paragraphs && d.paragraphs.length === 2, 'XPath 正文 2 段', JSON.stringify(d.paragraphs));

  console.log('\n== 8. 静态页面 ==');
  r = await fetch(base + '/');
  const html = await r.text();
  check(r.ok && html.includes('阅读'), '首页可访问');

  console.log('\n== 9. 整本下载为 TXT ==');
  r = await fetch(base + '/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: cssBook.bookUrl }),
  });
  d = await r.json();
  check(d.ok && d.total === 3, '下载任务已启动（3 章）', JSON.stringify(d));
  let st = d;
  for (let i = 0; i < 40 && st.running; i++) {
    await new Promise((res) => setTimeout(res, 300));
    st = await (await fetch(base + '/api/download/status?url=' + encodeURIComponent(cssBook.bookUrl))).json();
  }
  check(!st.running && !!st.file, '下载完成并生成文件', JSON.stringify(st));
  r = await fetch(base + '/api/download/file?url=' + encodeURIComponent(cssBook.bookUrl));
  const txt = await r.text();
  check(r.ok && String(r.headers.get('content-disposition')).includes('attachment'), '文件以附件形式返回');
  check(
    txt.includes('测试之书') && txt.includes('第1章 初见') && txt.includes('第3章 归途'),
    'TXT 含书名与全部章节'
  );
  check((txt.match(/第一段内容/g) || []).length >= 1, 'TXT 含正文内容');

  console.log('\n== 10. 封面代理 / 下载目录 / 已下载列表 ==');
  r = await fetch(base + '/api/image?url=' + encodeURIComponent(MOCK_ORIGIN + '/cover/1.jpg') + '&book=' + encodeURIComponent(cssBook.bookUrl));
  check(r.ok && (r.headers.get('content-type') || '').includes('image'), '封面代理返回图片');
  let dirs = await (await fetch(base + '/api/download/dirs')).json();
  check(Array.isArray(dirs.dirs) && dirs.dirs.length >= 1, '返回可选下载目录');
  let dl = await (await fetch(base + '/api/downloads')).json();
  check(dl.items.length === 1 && dl.items[0].exists, '已下载列表含 1 条');

  console.log('\n== 11. 订阅 RSS ==');
  r = await fetch(base + '/api/feeds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: MOCK_ORIGIN + '/feed.xml' }),
  });
  d = await r.json();
  check(r.ok && d.feed && d.feed.items.length === 2, '订阅解析出 2 条', JSON.stringify(d).slice(0, 160));
  check(d.feed && d.feed.title === '测试订阅', '订阅标题正确');
  const feeds = await (await fetch(base + '/api/feeds')).json();
  check(feeds.feeds.length === 1, '订阅列表 1 条');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
