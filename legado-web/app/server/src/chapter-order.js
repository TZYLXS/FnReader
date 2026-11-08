
/** 解析章节号：第123章 / 第一千零四十一章 / 第⑨章（站点常用带圈数字） */
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function normalizeCircled(text) {
  return String(text).replace(/[\u2460-\u2473\u3251-\u325f]/g, (ch) => {
    const code = ch.codePointAt(0);
    if (code >= 0x2460 && code <= 0x2473) return String(code - 0x2460 + 1);
    return String(code - 0x3251 + 21);
  });
}

function cnToNumber(text) {
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      number = number * 10 + Number(ch);
    } else if (CN_DIGITS[ch] !== undefined) {
      number = CN_DIGITS[ch];
    } else if (CN_UNITS[ch]) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + number) * unit;
        total += section;
        section = 0;
      } else {
        section += (number || 1) * unit;
      }
      number = 0;
    }
  }
  return total + section + number;
}

function chapterNumber(title) {
  const text = normalizeCircled(title);
  const m = text.match(/第\s*([零一二三四五六七八九十百千万两\d]+)\s*[章节回卷]/);
  if (!m) return 0;
  const raw = m[1];
  if (/^\d+$/.test(raw)) return Number(raw);
  return cnToNumber(raw);
}

/**
 * 目录若是「最新章节在前」（整站倒序），翻转为正常阅读顺序。
 * 只在多数标题能解析出章节号、且首章号明显大于末章号时翻转，
 * 避免把本身就乱序或按卷组织的目录改坏。
 */
function fixChapterOrder(chapters) {
  if (chapters.length < 5) return chapters;
  const nums = chapters.map((c) => chapterNumber(c.title));
  const known = nums.filter((n) => n > 0).length;
  if (known < chapters.length * 0.6) return chapters;

  const first = nums[0];
  const last = nums[nums.length - 1];
  if (!(first > 0 && last > 0 && first > last + 10)) return chapters;
  // 只有在整体严格递减时才反转，避免把分卷/乱序目录改坏
  let desc = 0;
  let pairs = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] > 0 && nums[i - 1] > 0) {
      pairs++;
      if (nums[i] <= nums[i - 1]) desc++;
    }
  }
  if (pairs < 5 || desc / pairs < 0.9) return chapters;
  return chapters.slice().reverse();
}

/**
 * 去重 + 按章节号排序。
 * 站点常常把「最新章节」区块和「全部目录」拼在一起：前者倒序、后者正序，
 * 合起来既重复又乱序。这里先按 url / 标题去重，再按章节号稳定排序。
 */
function normalizeChapterList(chapters) {
  if (!Array.isArray(chapters) || chapters.length < 2) return chapters || [];

  const seenUrl = new Set();
  const seenTitle = new Set();
  const list = [];
  for (const c of chapters) {
    const url = String((c && c.url) || '').trim();
    const title = String((c && c.title) || '').trim().replace(/\s+/g, '');
    if (url && seenUrl.has(url)) continue;
    if (title && seenTitle.has(title)) continue;
    if (url) seenUrl.add(url);
    if (title) seenTitle.add(title);
    list.push(c);
  }

  // 目录里混进「作者感言/更新通知」这类条目：多数标题以「第X章」开头时，把不像章节的剔掉
  const looksChapter = (t) => /^\s*第\s*[零一二三四五六七八九十百千万两\d]+\s*[章节回卷回]/.test(String(t || ''));
  const std = list.filter((c) => looksChapter(c.title)).length;
  const filtered = std >= list.length * 0.7 ? list.filter((c) => looksChapter(c.title)) : list;

  const nums = filtered.map((c) => chapterNumber(c.title));
  const known = nums.filter((n) => n > 0).length;
  if (known < filtered.length * 0.6) return filtered;

  // 稳定排序：已知章节号按号，未知的保持相对位置（用大数保证排到后面）
  const indexed = filtered.map((c, i) => ({ c, i, n: nums[i] }));
  indexed.sort((a, b) => {
    const an = a.n > 0 ? a.n : Number.MAX_SAFE_INTEGER;
    const bn = b.n > 0 ? b.n : Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return a.i - b.i;
  });
  return indexed.map((x) => x.c);
}

module.exports = { chapterNumber, cnToNumber, fixChapterOrder, normalizeChapterList, normalizeCircled };
