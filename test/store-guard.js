'use strict';
// 导源链路回归测试：网页导入 / App 上传 / 直接赋值 —— 都不应该抛错
const path = require('node:path');
process.env.LEGADO_DATA_DIR = path.join(require('node:os').tmpdir(), 'legado-store-test-' + Date.now());

const store = require('../fnos-legado/app/server/src/store');

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

console.log('== store 兼容性');
check('upsertSource 存在', typeof store.upsertSource === 'function');

store.upsertSource({ bookSourceUrl: 'https://t.example/a', bookSourceName: 'A', bookSourceGroup: 'g1' });
check('新增成功', store.sources.length === 1 && store.sources[0].bookSourceName === 'A');

store.upsertSource({ bookSourceUrl: 'https://t.example/a', bookSourceName: 'A2' });
check('合并成功', store.sources.length === 1 && store.sources[0].bookSourceName === 'A2');

let threw = null;
try {
  store.sources = store.sources.filter((s) => s.bookSourceUrl !== 'https://t.example/a');
} catch (e) {
  threw = e;
}
check('直接赋值 sources 不再抛错', !threw, threw ? threw.message : '');
check('赋值后确实删除', store.sources.length === 0);

store.sources = [{ bookSourceUrl: 'https://t.example/b', bookSourceName: 'B' }];
check('赋值可新增', store.sources.length === 1 && store.sources[0].bookSourceName === 'B');

console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
