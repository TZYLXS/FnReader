'use strict';

const _fs = require('node:fs');
const _path = require('node:path');
const _root = _path.resolve(__dirname, '..');
const APP_DIR = ['legado-web', 'fnos-legado'].find((d) => _fs.existsSync(_path.join(_root, d))) || 'legado-web';
// 用真实书源批量测试搜索，统计成功率与失败原因
const fs = require('node:fs');
const path = require('node:path');
const { normalizeSource, searchSource } = require('../' + APP_DIR + '/app/server/src/books');

const file = process.argv[2] || path.join(__dirname, 'real-sources.json');
const key = process.argv[3] || '斗破';
const limit = Number(process.argv[4] || 0);
const CONCURRENCY = 8;
const TIMEOUT = 20000;

const all = JSON.parse(fs.readFileSync(file, 'utf8')).map(normalizeSource);
const sources = limit ? all.slice(0, limit) : all;

let cursor = 0;
const stats = { ok: 0, empty: 0, error: 0 };
const errors = new Map();
const empties = [];
const results = [];

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), ms))]);
}

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= sources.length) return;
    const s = sources[i];
    const t0 = Date.now();
    try {
      const books = await withTimeout(searchSource(s, key, 1), TIMEOUT);
      if (books.length) {
        stats.ok++;
        results.push({ name: s.bookSourceName, count: books.length, ms: Date.now() - t0, sample: books[0].name });
      } else {
        stats.empty++;
        empties.push(s.bookSourceName);
      }
    } catch (e) {
      stats.error++;
      const msg = String(e.message || e).replace(/\d{2,}/g, 'N').slice(0, 90);
      errors.set(msg, (errors.get(msg) || 0) + 1);
      results.push({ name: s.bookSourceName, error: String(e.message || e) });
    }
  }
}

(async () => {
  console.log(`测试 ${sources.length} 个书源，关键字「${key}」...`);
  const t = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n用时 ${((Date.now() - t) / 1000).toFixed(1)}s`);
  console.log(`成功 ${stats.ok} | 空结果 ${stats.empty} | 报错 ${stats.error}  (共 ${sources.length})`);
  console.log('\n--- 报错分类 ---');
  [...errors.entries()].sort((a, b) => b[1] - a[1]).forEach(([m, c]) => console.log(`${String(c).padStart(3)}  ${m}`));
  if (empties.length) {
    console.log('\n--- 空结果 ---');
    console.log(empties.join('、').slice(0, 800));
  }
  console.log('\n--- 成功示例 ---');
  results
    .filter((r) => r.count)
    .slice(0, 15)
    .forEach((r) => console.log(`${r.name}: ${r.count} 本 / ${r.ms}ms / ${r.sample}`));
  fs.writeFileSync(path.join(__dirname, 'real-search-report.json'), JSON.stringify(results, null, 2));
})();
