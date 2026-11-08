'use strict';
// 解析桥端到端测试：
//  1) 起一个「假手机」：轮询 /api/m/remote/pending，领到任务就回结果
//  2) 触发一次搜索（指定那个必然失败的源 + remote=1）
//  3) 看服务端是否把手机的结果以 via:'phone' 推回来
const BASE = 'http://10.5.4.70:1122';
const FAILING_SOURCE = 'http://127.0.0.1:9';

async function token() {
  const r = await fetch(BASE + '/api/config');
  return (await r.json()).apiToken;
}

function phoneLoop(TOKEN, stopAt) {
  let handled = 0;
  const timer = setInterval(async () => {
    if (Date.now() > stopAt) return;
    try {
      const r = await fetch(BASE + '/api/m/remote/pending?wait=2000', {
        headers: { 'X-Api-Token': TOKEN },
      });
      const { jobs } = await r.json();
      for (const job of jobs || []) {
        handled++;
        console.log('  [手机] 领到任务', job.id, job.type, JSON.stringify(job.payload));
        await fetch(BASE + '/api/m/remote/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': TOKEN },
          body: JSON.stringify({
            id: job.id,
            ok: true,
            data: {
              books: [
                {
                  name: '手机解析出来的书',
                  author: '手机作者',
                  bookUrl: 'https://example.com/phone-book',
                  origin: job.payload.source,
                  originName: '手机解析器',
                  coverUrl: '',
                  intro: '这条结果来自手机端解析',
                  kind: '测试',
                },
              ],
            },
          }),
        });
        console.log('  [手机] 已回传结果');
      }
    } catch {
      /* ignore */
    }
  }, 500);
  return { timer, count: () => handled };
}

(async () => {
  const TOKEN = await token();
  console.log('令牌:', TOKEN.slice(0, 6) + '…');

  // --- 测试 1：直接建任务
  console.log('\n== 1. 直接建任务（不经过搜索）');
  const phone1 = phoneLoop(TOKEN, Date.now() + 15000);
  const jobPromise = fetch(BASE + '/api/remote/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'search', payload: { source: FAILING_SOURCE, key: '测试' }, waitMs: 8000 }),
  }).then((r) => r.json());
  const jobResult = await jobPromise;
  clearInterval(phone1.timer);
  console.log('  服务端收到:', JSON.stringify(jobResult).slice(0, 160));
  console.log('  结论:', jobResult.ok && jobResult.data && jobResult.data.books ? '✓ 通过' : '✗ 失败');

  // --- 测试 2：走搜索链路
  console.log('\n== 2. 搜索链路（remote=1）');
  const phone2 = phoneLoop(TOKEN, Date.now() + 30000);
  const url = `${BASE}/api/search?key=${encodeURIComponent('测试')}&sources=${encodeURIComponent(FAILING_SOURCE)}&remote=1`;
  const resp = await fetch(url);
  const text = await resp.text();
  clearInterval(phone2.timer);
  const lines = text.split('\n').filter((l) => l.startsWith('data: '));
  let viaPhone = null;
  let done = false;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line.slice(6));
      if (msg.type === 'result' && msg.via === 'phone') viaPhone = msg;
      if (msg.type === 'done') done = true;
    } catch {
      /* ignore */
    }
  }
  console.log('  SSE 事件数:', lines.length, '| done:', done);
  console.log('  手机结果:', viaPhone ? `${viaPhone.books.length} 本 · ${viaPhone.books[0].name} · 来源 ${viaPhone.source}` : '无');
  console.log('  结论:', viaPhone ? '✓ 通过' : '✗ 失败');
})();
