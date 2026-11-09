'use strict';
// 假手机：响应 bookinfo 任务，验证「简介由手机补全」
const BASE = 'http://10.5.4.70:1122';
const TOKEN = process.env.TOKEN;
const stopAt = Date.now() + Number(process.env.SECONDS || 45) * 1000;

(async () => {
  while (Date.now() < stopAt) {
    try {
      const r = await fetch(`${BASE}/api/m/remote/pending?id=intro-phone&name=%E7%AE%80%E4%BB%8B%E6%89%8B%E6%9C%BA&wait=1200`, {
        headers: { 'X-Api-Token': TOKEN },
      });
      const { jobs } = await r.json();
      for (const job of jobs || []) {
        if (job.type !== 'bookinfo') continue;
        await fetch(`${BASE}/api/m/remote/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': TOKEN },
          body: JSON.stringify({
            id: job.id,
            deviceId: 'intro-phone',
            ok: true,
            data: {
              intro: '【手机解析补全】高文穿越到一个即将被魔潮吞没的世界，带着地球的知识重建文明。',
              author: '远瞳',
              kind: '奇幻',
              wordCount: '500万字',
              lastChapter: '第1594章 8：05',
            },
          }),
        });
        console.log('answered bookinfo', job.id, job.payload && job.payload.bookUrl);
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
})();
