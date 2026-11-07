'use strict';
// 起一个本地预览实例（模拟书源站 + 应用服务），用于截图检查阅读页
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 18200;
const MOCK_PORT = 18080;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-preview-'));
const SERVER = path.join(ROOT, 'fnos-legado/app/server/src/server.js');

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timeout ' + url);
}

(async () => {
  const mock = spawn(NODE, [path.join(__dirname, 'mock-site.js')], {
    env: { ...process.env, MOCK_PORT },
    stdio: 'ignore',
  });
  const server = spawn(NODE, [SERVER], {
    env: {
      ...process.env,
      PORT,
      TRIM_SERVICE_PORT: PORT,
      LEGADO_DATA: DATA,
      TRIM_APPDEST: path.join(DATA, 'target'),
      LEGADO_WEB: path.join(ROOT, 'fnos-legado/app/web'),
    },
    stdio: 'ignore',
  });

  const stop = () => {
    mock.kill();
    server.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await waitFor(`http://127.0.0.1:${PORT}/api/health`);
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/search?q=x`);

  const src = fs.readFileSync(path.join(__dirname, 'source.json'), 'utf8');
  await fetch(`http://127.0.0.1:${PORT}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: src,
  });

  const r = await fetch(`http://127.0.0.1:${PORT}/api/search?key=%E6%B5%8B%E8%AF%95&limit=1`).then((x) => x.text());
  const line = r.split('\n').find((l) => l.includes('"type":"result"'));
  const books = line ? JSON.parse(line.replace(/^data:\s*/, '')).books : [];
  if (!books.length) {
    console.log('no books');
    stop();
    process.exit(1);
  }
  const book = books[0];
  await fetch(`http://127.0.0.1:${PORT}/api/books`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(book),
  });

  console.log(`PORT=${PORT}`);
  console.log(`BOOK=${encodeURIComponent(book.bookUrl)}`);
  console.log(`DATA=${DATA}`);
  console.log('预览地址: http://127.0.0.1:' + PORT + '/#/read?url=' + encodeURIComponent(book.bookUrl));
  console.log('按 Ctrl+C 结束');
  setInterval(() => {}, 1 << 30);
})();
