'use strict';
// 假手机：响应软总线任务，用于验证「手机解析 → 落盘缓存」
const BASE = 'http://10.5.4.70:1122';
const TOKEN = process.env.TOKEN;
const stopAt = Date.now() + Number(process.env.SECONDS || 60) * 1000;

(async () => {
  while (Date.now() < stopAt) {
    try {
      const r = await fetch(`${BASE}/api/m/remote/pending?id=fake-phone&name=%E5%81%87%E6%89%8B%E6%9C%BA&wait=1500`, {
        headers: { 'X-Api-Token': TOKEN },
      });
      const { jobs } = await r.json();
      for (const job of jobs || []) {
        let data = null;
        if (job.type === 'toc') {
          data = {
            chapters: [
              { title: '第一章 手机目录', url: 'https://example.org/phone/c1' },
              { title: '第二章 手机目录', url: 'https://example.org/phone/c2' },
            ],
          };
        } else if (job.type === 'content') {
          data = { paragraphs: ['手机解析的第一段。', '手机解析的第二段。'] };
        }
        if (!data) continue;
        await fetch(`${BASE}/api/m/remote/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': TOKEN },
          body: JSON.stringify({ id: job.id, deviceId: 'fake-phone', ok: true, data }),
        });
        console.log('handled', job.type, job.id);
      }
    } catch (e) {
      console.error('poll err', e.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
})();
