'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const pyengine = require('../legado-web/app/server/src/pyengine');
const javaWorker = require('../legado-web/app/server/src/java-worker');

let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed++;
  console.log('  ✓', name);
}

async function main() {
  process.env.LEGADO_JAVA_WORKER = '1';
  process.env.LEGADO_PYTHON_WORKERS = '2';
  javaWorker.setEnabled(true);
  const site = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/search')) {
      return res.end('<ul class="books"><li><a href="/book/1">测试书</a><span class="author">测试作者</span></li></ul>');
    }
    if (req.url.startsWith('/book/1')) {
      return res.end('<ul><li><a href="/c/2">第二章</a></li><li><a href="/c/1">第一章</a></li><li><a href="/c/1">第一章</a></li><li><a href="/c/3">第三章</a></li><li><a href="/note">作者的话</a></li></ul>');
    }
    res.end('<p>正文</p>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const source = {
    bookSourceUrl: base,
    bookSourceName: 'Python 测试源',
    searchUrl: base + '/search?key={{key}}',
    ruleSearch: { bookList: 'class.books@tag.li', name: 'tag.a@text', author: 'class.author@text', bookUrl: 'tag.a@href' },
    ruleToc: { chapterList: 'tag.li', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
  };
  try {
    console.log('== Java / Python 引擎拆分');
    const python = await pyengine.probe(true);
    check('Python legado_rule 可用: ' + JSON.stringify(python), python.ok);
    const java = await javaWorker.health();
    check('Java worker 可启动: ' + JSON.stringify(java), java.ok);

    const found = await pyengine.call('search', { source, key: '测试' });
    check('Python 接管搜索规则', found.books && found.books.length === 1 && found.books[0].name === '测试书');
    const toc = await pyengine.call('toc', { source, tocUrl: base + '/book/1' });
    check('Python 接管 TOC 规则与清洗: ' + JSON.stringify(toc), toc.normalized === 'python' && toc.chapters.length === 3);
    check('Python TOC 去重并排序', toc.chapters.map((c) => c.title).join(',') === '第一章,第二章,第三章');

    const raw = [
      { title: '第二章', url: '/c/2' }, { title: '第一章', url: '/c/1' },
      { title: '第一章', url: '/c/1' }, { title: '第三章', url: '/c/3' }, { title: '作者的话', url: '/note' },
    ];
    const javaToc = await javaWorker.normalizeToc(raw);
    check('Java 与 Python TOC 结果一致', javaToc.map((c) => c.title).join(',') === '第一章,第二章,第三章');

    const replies = await Promise.all(Array.from({ length: 8 }, () => pyengine.call('probe', {})));
    check('Python 持久池并行响应 8 次', replies.every((r) => r.ok));
    const stats = pyengine.poolStats();
    check('Python 进程池保持 2 个 worker: ' + JSON.stringify(stats), stats.workers === 2 && stats.calls >= 10 && stats.responses >= 10);
    check('Python worker 复用进程', new Set(replies.map((r) => r.pid)).size <= 2);

    javaWorker.setEnabled(false);
    check('Java 设置开关关闭后停止接管', await javaWorker.normalizeToc(raw) === null);
    console.log(`结果: ${passed} 通过, 0 失败`);
  } finally {
    pyengine.closePool();
    javaWorker.close();
    await new Promise((resolve) => site.close(resolve));
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  pyengine.closePool();
  javaWorker.close();
  process.exitCode = 1;
});
