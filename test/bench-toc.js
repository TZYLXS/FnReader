'use strict';
// 目录加载计时：node test/bench-toc.js <bookUrl>
const BASE = 'http://10.5.4.70:1122';

async function main() {
  const bookUrl = process.argv[2];
  if (!bookUrl) throw new Error('用法: bench-toc.js <bookUrl>');
  const engine = (await (await fetch(BASE + '/api/engine')).json()).engine;
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/api/toc?url=${encodeURIComponent(bookUrl)}&refresh=1`);
  const text = await resp.text();
  const ms = Date.now() - t0;
  let chapters = 0;
  let error = '';
  try {
    const j = JSON.parse(text);
    chapters = (j.chapters || []).length;
    error = j.error || '';
  } catch {
    error = text.slice(0, 120);
  }
  console.log(JSON.stringify({ engine, bookUrl, chapters, ms, error }, null, 1));
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
