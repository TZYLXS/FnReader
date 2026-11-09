'use strict';
// 冒烟测试：统计一次「全量搜索」的完成时间与结果数
// 用法：node test/bench-search.js <keyword> [sourcesCsv]
const BASE = 'http://10.5.4.70:1122';

async function main() {
  const key = process.argv[2] || '黎明之剑';
  const sources = process.argv[3] || '';
  const url = `${BASE}/api/search?key=${encodeURIComponent(key)}${sources ? '&sources=' + encodeURIComponent(sources) : ''}`;
  const t0 = Date.now();
  const resp = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let results = 0;
  let books = 0;
  let doneMs = null;
  let doneCount = 0;
  let total = 0;
  const slow = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const chunk of parts) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (msg.type === 'start') total = msg.total || 0;
      if (msg.type === 'result') {
        results++;
        books += (msg.books || []).length;
      }
      if (msg.type === 'source-done') {
        doneCount = msg.done;
        if ((msg.ms || 0) > 8000) slow.push(`${msg.source}:${Math.round(msg.ms / 1000)}s`);
      }
      if (msg.type === 'done') {
        doneMs = Date.now() - t0;
        break;
      }
    }
    if (doneMs != null) break;
  }

  const engine = await (await fetch(BASE + '/api/engine')).json();
  console.log(
    JSON.stringify(
      {
        engine: engine.engine,
        keyword: key,
        totalSources: total,
        doneSources: doneCount,
        resultSources: results,
        books,
        elapsedMs: doneMs == null ? null : Date.now() - Date.now() + doneMs,
        wallMs: doneMs,
        slowTop: slow.slice(0, 5),
      },
      null,
      1
    )
  );
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
