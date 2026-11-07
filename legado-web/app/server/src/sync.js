'use strict';
// 生成 /api/m/sync 的响应：书架 + 阅读进度 + 书源配置
function buildSyncPayload(store, opts = {}) {
  const now = Date.now();
  const since = Number(opts.since) || 0;
  const full = opts.full === true || opts.full === '1';

  const books = Array.isArray(store.books) ? store.books : [];
  const shelf = books
    .filter((b) => !since || (b.durChapterTime || 0) > since)
    .map((b) => ({
      bookUrl: b.bookUrl,
      name: b.name,
      author: b.author || '',
      coverUrl: b.coverUrl || '',
      intro: String(b.intro || '').slice(0, 600),
      kind: b.kind || '',
      origin: b.origin || '',
      originName: b.originName || '',
      lastChapter: b.lastChapter || '',
      totalChapterNum: b.totalChapterNum || 0,
      durChapterIndex: b.durChapterIndex || 0,
      durChapterTitle: b.durChapterTitle || '',
      durChapterPos: b.durChapterPos || 0,
      durChapterTime: b.durChapterTime || 0,
    }));

  // 阅读进度单独列一份，方便 App 只做进度同步
  const progress = shelf.map((b) => ({
    bookUrl: b.bookUrl,
    index: b.durChapterIndex,
    title: b.durChapterTitle,
    pos: b.durChapterPos,
    time: b.durChapterTime,
  }));

  const sources = Array.isArray(store.sources) ? store.sources : [];
  const groupCount = new Map();
  for (const s of sources) {
    const g = s.bookSourceGroup || '未分组';
    groupCount.set(g, (groupCount.get(g) || 0) + 1);
  }
  const slimSource = (s) => ({
    bookSourceName: s.bookSourceName,
    bookSourceUrl: s.bookSourceUrl,
    bookSourceGroup: s.bookSourceGroup || '',
    bookSourceType: s.bookSourceType || 0,
    enabled: s.enabled !== false,
    searchUrl: s.searchUrl || '',
    checkStatus: s.checkStatus || '',
  });

  const sourcePayload = {
    total: sources.length,
    enabled: sources.filter((s) => s.enabled !== false).length,
    groups: [...groupCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    items: full ? sources : sources.map(slimSource),
    full,
  };

  return {
    app: 'FnReader',
    version: opts.version || '',
    serverTime: now,
    since,
    incr: since > 0,
    shelf,
    shelfCount: shelf.length,
    progress,
    progressCount: progress.length,
    sources: sourcePayload,
    endpoints: {
      sync: '/api/m/sync?token=…&since=0&full=1',
      sourcesFile: '/api/m/sources.json?token=…',
      toc: '/api/m/toc?token=…&url=<bookUrl>',
      content: '/api/m/content?token=…&url=<bookUrl>&index=<n>',
      progress: 'POST /api/m/progress  {bookUrl,index,pos,title}',
    },
  };
}

module.exports = { buildSyncPayload };
