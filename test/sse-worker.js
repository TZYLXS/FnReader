'use strict';
// 回归：搜索 SSE 的 worker 循环里，命中分支必须用 continue，不能用 return
// （曾因 return 导致 12 个 worker 提前退出，403 个源只跑 15 个就 done）
const fs = require('node:fs');
const path = require('node:path');

const _root = path.resolve(__dirname, '..');
// 可能有多个应用目录副本（例如旧的 legado-web），取 manifest 最新的那个
const APP_DIR =
  ['legado-web', 'fnos-legado']
    .filter((d) => fs.existsSync(path.join(_root, d, 'manifest')))
    .sort((a, b) => fs.statSync(path.join(_root, b, 'manifest')).mtimeMs - fs.statSync(path.join(_root, a, 'manifest')).mtimeMs)[0] ||
  'legado-web';
const src = fs.readFileSync(path.join(_root, APP_DIR, 'app', 'server', 'src', 'server.js'), 'utf8');

const lines = src.split('\n');
let ok = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    ok++;
    console.log('  ✓', label, extra);
  } else {
    fail++;
    console.log('  ✗', label, extra);
  }
};

// 找到 via: 'phone' / via: 'python' 所在的 source-done 块，看其后 4 行内是 continue 还是 return
for (const kind of ['phone', 'python']) {
  const idx = lines.findIndex((l) => l.trim() === `via: '${kind}',`);
  check(`存在 ${kind} 分支`, idx >= 0);
  if (idx < 0) continue;
  const tail = lines.slice(idx, idx + 6).join('\n');
  check(`${kind} 分支用 continue 而非 return`, /continue;/.test(tail) && !/^\s*return;\s*$/m.test(tail), tail.trim().split('\n').pop());
}

// while 循环内部不能出现裸 return（除了 i >= sources.length 那道守卫）
const workerStart = lines.findIndex((l) => l.includes('const worker = async () => {'));
const workerEnd = lines.findIndex((l, i) => i > workerStart && l.trim() === '};');
const body = lines.slice(workerStart, workerEnd).join('\n');
const bareReturns = body.match(/^\s*return;\s*$/gm) || [];
check('worker 内裸 return 只允许 1 处（游标越界）', bareReturns.length <= 1, `实际 ${bareReturns.length} 处`);

console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
