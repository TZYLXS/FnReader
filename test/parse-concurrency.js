'use strict';
// 回归：含同步 java.ajax 的搜索不能阻塞主事件循环，且相同搜索仍应命中缓存。
// 全程使用本机临时数据目录与模拟站点，不连接任何生产服务。
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'legado-web', 'app', 'server', 'src', 'server.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-parse-concurrency-'));
const SLOW_MS = Number(process.env.SLOW_MS || 1200);
let passed = 0;
let failed = 0;
function check(cond, label, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}
async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务启动超时: ' + url);
}
function eventsOf(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

(async () => {
  let notifySlow;
  const slowStarted = new Promise((resolve) => {
    notifySlow = resolve;
  });
  let slowHits = 0;
  let origin = '';
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, origin || 'http://127.0.0.1');
    if (url.pathname === '/slow-url') {
      slowHits++;
      notifySlow();
      return setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(origin + '/search?q=js');
      }, SLOW_MS);
    }
    if (url.pathname === '/search') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<div class="result"><a class="title" href="/book/1">JS并发之书</a><span class="author">作者甲</span></div>');
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve, reject) => {
    mock.once('error', reject);
    mock.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${mock.address().port}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let serverLog = '';
  const server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: port,
      TRIM_SERVICE_PORT: port,
      LEGADO_DATA: DATA,
      TRIM_APPDEST: path.join(DATA, 'target'),
      LEGADO_WEB: path.join(ROOT, 'legado-web', 'app', 'web'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (serverLog += d.toString()));
  server.stderr.on('data', (d) => (serverLog += d.toString()));
  const cleanup = () => {
    server.kill();
    mock.close();
  };
  process.on('exit', cleanup);

  try {
    await waitFor(base + '/api/health');
    const source = {
      bookSourceName: 'JS阻塞回归源',
      bookSourceUrl: origin + '/js-source',
      bookSourceType: 0,
      enabled: true,
      searchUrl: '<js>java.ajax(' + JSON.stringify(origin + '/slow-url') + ')</js>',
      ruleSearch: {
        bookList: '.result',
        name: '.title@text',
        author: '.author@text',
        bookUrl: '.title@href',
      },
    };
    let r = await fetch(base + '/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: [source] }),
    });
    const imported = await r.json();
    check(imported.imported === 1, '导入慢 java.ajax 测试源');

    const firstStartedAt = Date.now();
    const firstPromise = fetch(base + '/api/search?key=js').then(async (resp) => eventsOf(await resp.text()));
    await Promise.race([
      slowStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('慢规则没有被触发')), 5000)),
    ]);
    await new Promise((r2) => setTimeout(r2, 100));
    const healthStartedAt = Date.now();
    const health = await fetch(base + '/api/health');
    const healthMs = Date.now() - healthStartedAt;
    check(health.ok, '搜索期间健康检查可访问');
    check(healthMs < 500, `搜索期间健康检查不被阻塞（${healthMs}ms）`, `慢请求 ${SLOW_MS}ms`);
    const first = await firstPromise;
    const firstMs = Date.now() - firstStartedAt;
    const books = first.filter((e) => e.type === 'result').flatMap((e) => e.books || []);
    check(books.length === 1 && books[0].name === 'JS并发之书', `慢规则搜索仍返回正确结果（${firstMs}ms）`);
    check(first.some((e) => e.type === 'done'), '慢规则搜索 SSE 正常结束');

    const secondStartedAt = Date.now();
    const second = eventsOf(await (await fetch(base + '/api/search?key=js')).text());
    const secondMs = Date.now() - secondStartedAt;
    const books2 = second.filter((e) => e.type === 'result').flatMap((e) => e.books || []);
    check(books2.length === 1, '第二次搜索返回相同结果');
    check(secondMs < 500 && slowHits === 1, `第二次搜索命中缓存（${secondMs}ms，慢 URL 请求 ${slowHits} 次）`);
    console.log(`\n指标: healthMs=${healthMs}, firstMs=${firstMs}, secondMs=${secondMs}, slowHits=${slowHits}`);
  } catch (e) {
    failed++;
    console.error('测试异常:', e.stack || e);
    if (serverLog.trim()) console.error('服务端日志:\n' + serverLog.trim());
  } finally {
    cleanup();
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
