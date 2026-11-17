'use strict';
// 软总线队列回归：同设备不重复领同一任务；交互式 TOC 优先于批量搜索。
const remote = require('../legado-web/app/server/src/remote');
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
function ids(jobs) {
  return jobs.map((j) => j.id);
}

(async () => {
  remote.hello({ id: 'queue-phone', name: '队列测试手机', version: 'test' });
  const first = remote.create('search', { source: 's1', key: 'k' }, { waitMs: 10000 });
  const one = remote.pending(1, 'queue-phone');
  check(ids(one).includes(first.id), '首个搜索任务可正常领取');
  const repeated = remote.pending(1, 'queue-phone');
  check(!ids(repeated).includes(first.id), '同一设备未重复收到已领取任务', JSON.stringify(ids(repeated)));
  remote.complete(first.id, true, { books: [] }, '', 'queue-phone');

  remote.hello({ id: 'priority-phone', name: '优先级测试手机', version: 'test' });
  const search = remote.create('search', { source: 's2', key: 'k' }, { waitMs: 10000 });
  const toc = remote.create('toc', { source: 's2', bookUrl: 'https://example.test/book' }, { waitMs: 10000 });
  const ordered = remote.pending(5, 'priority-phone');
  check(ordered.length === 2, '搜索与 TOC 均可领取', `实际 ${ordered.length}`);
  check(ordered[0] && ordered[0].id === toc.id, '后创建的交互式 TOC 排在批量搜索之前', JSON.stringify(ordered.map((j) => j.type)));
  remote.abandon(search.id);
  remote.abandon(toc.id);

  const search2 = remote.create('search', { source: 's3', key: 'k' }, { waitMs: 10000 });
  const toc2 = remote.create('toc', { source: 's3', bookUrl: 'https://example.test/book2' }, { waitMs: 10000 });
  const tocFirst = remote.pending(1, 'priority-phone');
  check(tocFirst[0] && tocFirst[0].id === toc2.id, '限领一个时优先派发 TOC');
  const next = remote.pending(1, 'priority-phone');
  check(next[0] && next[0].id === search2.id, 'TOC 已在途后派发等待中的搜索，不重复派 TOC', JSON.stringify(next.map((j) => j.type)));
  remote.abandon(search2.id);
  remote.abandon(toc2.id);

  check(remote.stats().pending === 0, '测试任务全部清理，无队列泄漏');
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e.stack || e);
  process.exit(1);
});
