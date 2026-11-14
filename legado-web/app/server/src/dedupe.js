'use strict';
// 书架去重：同一本书在多个书源里被抓到时，只保留「最好」的一条
// 判定：书名 + 作者（归一化后）相同即视为同一本

function normText(s) {
  return String(s || '')
    .replace(/作者[:：]/g, '')
    .replace(/作\s*者[:：]/g, '')
    .replace(/[《》「」【】\[\]()（）\s·・.。,:：;；!！?？"'’“”]/g, '')
    .replace(/^第.{1,6}[章节回]/, '')
    .toLowerCase()
    .trim();
}

function keyOf(book) {
  if (!book) return '';
  const name = normText(book.name);
  const author = normText(book.author);
  return name + '|' + author;
}

/** 取一本书的章数（目录数组优先，其次各种计数字段） */
function chaptersOf(book) {
  if (!book) return 0;
  if (Array.isArray(book.chapters) && book.chapters.length) return book.chapters.length;
  return Number(book.totalChapterNum || book.chapterCount || book.numChapter || 0) || 0;
}

/**
 * 评分：**章数最多优先**，章数相同才比进度、简介、封面。
 * 章数权重给到 1e6，确保任何附加分都盖不过「多一章」。
 */
function scoreOf(book) {
  return (
    chaptersOf(book) * 1000000 +
    (book.cachedDir ? 500 : 0) +
    (Number(book.durChapterIndex) || 0) * 10 +
    (book.intro ? 5 : 0) +
    (book.coverUrl ? 3 : 0) +
    (book.viaPhone ? 1 : 0)
  );
}

/** 合并两条：保留 winner 的字段，缺失的用 loser 补，来源记进 altOrigins */
function mergeTwo(winner, loser) {
  const alt = Array.isArray(winner.altOrigins) ? winner.altOrigins.slice() : [];
  const key = loser.origin || loser.bookUrl;
  if (key && !alt.some((x) => (x.origin || x.bookUrl) === key) && key !== winner.origin) {
    alt.push({
      origin: loser.origin || '',
      originName: loser.originName || '',
      bookUrl: loser.bookUrl || '',
      chapters: (loser.chapters && loser.chapters.length) || loser.totalChapterNum || 0,
    });
  }
  return {
    ...loser,
    ...winner,
    // 缺失字段用 loser 补
    intro: winner.intro || loser.intro || '',
    coverUrl: winner.coverUrl || loser.coverUrl || '',
    author: winner.author || loser.author || '',
    kind: winner.kind || loser.kind || '',
    lastChapter: winner.lastChapter || loser.lastChapter || '',
    // 目录：谁章多就用谁的（源站有些书只在某个源是全本）
    chapters: chaptersOf(loser) > chaptersOf(winner) ? loser.chapters : winner.chapters,
    totalChapterNum: Math.max(chaptersOf(winner), chaptersOf(loser)),
    altOrigins: alt,
  };
}

/**
 * 对书架数组做原地去重，返回 { kept, removed, changed }
 * 同一 key 下保留 score 最高的那条
 */
function dedupeBooks(books) {
  const groups = new Map();
  for (const b of books || []) {
    const k = keyOf(b);
    if (!k || k === '|') continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }

  let changed = 0;
  let removed = 0;
  const next = [];
  const seen = new Set();

  for (const b of books || []) {
    const k = keyOf(b);
    if (!k || k === '|') {
      next.push(b);
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    const group = groups.get(k);
    if (group.length === 1) {
      next.push(b);
      continue;
    }
    // 选最好的那条，把其余的合进来
    const sorted = group.slice().sort((a, b2) => scoreOf(b2) - scoreOf(a));
    let winner = { ...sorted[0] };
    for (const loser of sorted.slice(1)) {
      winner = mergeTwo(winner, loser);
      removed++;
    }
    // 原地替换（保持对象引用，避免破坏已有引用）
    const idx = books.indexOf(sorted[0]);
    if (idx >= 0) books[idx] = winner;
    next.push(winner);
    changed++;
  }

  return { list: next, kept: next.length, removed, changed };
}

module.exports = { dedupeBooks, keyOf, normText, scoreOf, chaptersOf };
