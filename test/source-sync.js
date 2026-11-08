'use strict';
// 书源双向同步测试：LWW（lastUpdateTime 大的赢）
const BASE = 'http://10.5.4.70:1122';

async function token() {
  const r = await fetch(BASE + '/api/config', { headers: { 'X-Api-Token': '' } });
  // 远程拿不到令牌时，从本机代理读（测试脚本跑在 Windows 上）
  return process.env.TOKEN;
}

const T = process.env.TOKEN;
const H = { 'Content-Type': 'application/json', 'X-Api-Token': T };
const URL_KEY = 'https://sync-test.example/src';

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return r.json();
}

async function getList() {
  const r = await fetch(BASE + '/api/sources', { headers: H });
  const j = await r.json();
  const arr = j.sources || j;
  return arr.find((s) => s.bookSourceUrl === URL_KEY);
}

(async () => {
  // 先清掉上次残留
  await fetch(BASE + '/api/sources/' + encodeURIComponent(URL_KEY), { method: 'DELETE', headers: H });
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

  console.log('== 1. 客户端新增（lastUpdateTime=2000000000000）');
  let r = await post('/api/m/sources/sync', {
    updated: [{ bookSourceUrl: URL_KEY, bookSourceName: '同步测试源', bookSourceGroup: 'v1', lastUpdateTime: 2000000000000 }],
  });
  check('apply', r.applied === 1 && r.total >= 1, JSON.stringify({ applied: r.applied, total: r.total }));
  let cur = await getList();
  check('已入库', !!cur && cur.bookSourceGroup === 'v1');

  console.log('== 2. 客户端推送更旧版本（应被忽略并回传服务端版本）');
  r = await post('/api/m/sources/sync', {
    updated: [{ bookSourceUrl: URL_KEY, bookSourceName: '同步测试源', bookSourceGroup: 'v0-old', lastUpdateTime: 1900000000000 }],
  });
  check('skip', r.skipped >= 1);
  check('pull 带回服务端版本', (r.pull || []).some((s) => s.bookSourceUrl === URL_KEY && s.bookSourceGroup === 'v1'));
  cur = await getList();
  check('数据库仍是 v1', cur && cur.bookSourceGroup === 'v1');

  console.log('== 3. 客户端推送更新版本（应覆盖）');
  r = await post('/api/m/sources/sync', {
    updated: [{ bookSourceUrl: URL_KEY, bookSourceName: '同步测试源', bookSourceGroup: 'v2-new', lastUpdateTime: 2100000000000 }],
  });
  check('apply', r.applied === 1);
  cur = await getList();
  check('数据库变为 v2-new', cur && cur.bookSourceGroup === 'v2-new');

  console.log('== 4. 增量拉取（since 早于最新修改）');
  const g = await (await fetch(BASE + '/api/m/sources/sync?since=2000000000000', { headers: H })).json();
  const hit = (g.sources || []).find((s) => s.bookSourceUrl === URL_KEY);
  check('拉到 v2-new', !!hit && hit.bookSourceGroup === 'v2-new');

  console.log('== 5. 删除同步（较新的删除生效）');
  r = await post('/api/m/sources/sync', { deleted: [{ bookSourceUrl: URL_KEY, lastUpdateTime: 2200000000000 }] });
  check('deleted', r.applied === 1);
  cur = await getList();
  check('已从服务端删除', !cur);

  console.log('== 6. 过期的删除不生效（先重建再删旧时间）');
  await post('/api/m/sources/sync', {
    updated: [{ bookSourceUrl: URL_KEY, bookSourceName: '同步测试源', bookSourceGroup: 'v3', lastUpdateTime: 2300000000000 }],
  });
  r = await post('/api/m/sources/sync', { deleted: [{ bookSourceUrl: URL_KEY, lastUpdateTime: 100 }] });
  check('旧删除被忽略', r.skipped >= 1);
  cur = await getList();
  check('仍在', !!cur);

  // 清理
  await fetch(BASE + '/api/sources/' + encodeURIComponent(URL_KEY), { method: 'DELETE', headers: H });
  console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
