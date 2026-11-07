'use strict';
// 本地模拟书源站，用于端到端测试（不依赖任何真实站点）
const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT || 18080);

const chapters = [
  { id: 1, title: '第1章 初见' },
  { id: 2, title: '第2章 远行' },
  { id: 3, title: '第3章 归途' },
];

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (html) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  };

  if (url.pathname === '/search') {
    const key = url.searchParams.get('q') || '';
    const list =
      key.includes('无') || key === ''
        ? ''
        : `<div class="result">
             <a class="title" href="/book/1">${key}之书</a>
             <span class="author">作者甲</span>
             <span class="kind">玄幻</span>
             <img src="/cover/1.jpg" />
           </div>`;
    return send(page('搜索', `<div id="list">${list}</div>`));
  }

  if (url.pathname === '/book/1') {
    return send(
      page(
        '测试之书',
        `<div id="info">
           <h1>测试之书</h1>
           <p class="author">作者甲</p>
           <p class="kind">玄幻</p>
           <div class="intro">这是一本用于测试的书。</div>
           <a class="toc" href="/toc/1">查看目录</a>
         </div>`
      )
    );
  }

  if (url.pathname === '/toc/1') {
    return send(
      page(
        '目录',
        `<ul id="list">${chapters
          .map((c) => `<li><a href="/chapter/${c.id}">${c.title}</a></li>`)
          .join('')}</ul>`
      )
    );
  }


  if (url.pathname === '/chapter/1b') {
    return send(page('续页', `<div id="content"><p>这是分页后的第三段内容。</p></div>`));
  }

  if (url.pathname.startsWith('/chapter/')) {
    const id = Number(url.pathname.split('/')[2]);
    if (!Number.isFinite(id)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const c = chapters.find((x) => x.id === id) || chapters[0];
    const next = id === 1 ? `<a id="next" href="/chapter/1b">下一页</a>` : '';
    return send(
      page(
        c.title,
        `<h1>${c.title}</h1>
         <div id="content"><p>${c.title} 的第一段内容。</p><p>第二段内容，包含标点，用于验证分段。</p></div>
         ${next}`
      )
    );
  }


  if (url.pathname === '/feed.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>测试订阅</title><link>http://127.0.0.1:${PORT}/</link>
<item><title>第一条更新</title><link>http://127.0.0.1:${PORT}/post/1</link><pubDate>Wed, 05 Nov 2026 10:00:00 GMT</pubDate><description>hello one</description></item>
<item><title>第二条更新</title><link>http://127.0.0.1:${PORT}/post/2</link><pubDate>Thu, 06 Nov 2026 10:00:00 GMT</pubDate><description>hello two</description></item>
</channel></rss>`);
  }

  if (url.pathname.startsWith('/cover/')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#4a7ebb"/><text x="60" y="90" font-size="40" text-anchor="middle" fill="#fff">书</text></svg>'
    );
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock site on http://127.0.0.1:${PORT}`));
