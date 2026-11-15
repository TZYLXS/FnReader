'use strict';
// TXT 目录规则（来自 Legado 导出的 txtTocRule，仅内置 enable=true 的规则）
const RULES = [
  {
    "id": -1,
    "name": "目录(去空白)",
    "rule": "(?<=[　\\s])(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|集(?![合和]))).{0,30}$"
  },
  {
    "id": -2,
    "name": "目录",
    "rule": "^[ 　\\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|集(?![合和])|部(?![分赛游])|篇(?!张))).{0,30}$"
  },
  {
    "id": -8,
    "name": "数字 分隔符 标题名称",
    "rule": "^[ 　\\t]{0,4}\\d{1,5}[:：,.， 、_—\\-].{1,30}$"
  },
  {
    "id": -9,
    "name": "大写数字 分隔符 标题名称",
    "rule": "^[ 　\\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|[零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}章?)[ 、_—\\-].{1,30}$"
  },
  {
    "id": -11,
    "name": "正文 标题/序号",
    "rule": "^[ 　\\t]{0,4}正文[ 　]{1,4}.{0,20}$"
  },
  {
    "id": -12,
    "name": "Chapter/Section/Part/Episode 序号 标题",
    "rule": "^[ 　\\t]{0,4}(?:[Cc]hapter|[Ss]ection|[Pp]art|ＰＡＲＴ|[Nn][oO][.、]|[Ee]pisode|(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外)\\s{0,4}\\d{1,4}.{0,30}$"
  },
  {
    "id": -14,
    "name": "特殊符号 序号 标题",
    "rule": "(?<=[\\s　])[【〔〖「『〈［\\[](?:第|[Cc]hapter)[\\d零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,10}[章节].{0,20}$"
  },
  {
    "id": -16,
    "name": "特殊符号 标题(单个)",
    "rule": "(?<=[\\s　]{0,4})(?:[☆★✦✧].{1,30}|(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外)[ 　]{0,4}$"
  },
  {
    "id": -17,
    "name": "章/卷 序号 标题",
    "rule": "^[ \\t　]{0,4}(?:(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|[卷章][\\d零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8})[ 　]{0,4}.{0,30}$"
  },
  {
    "id": -21,
    "name": "书名 括号 序号",
    "rule": "^[一-龥]{1,20}[ 　\\t]{0,4}[(（][\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}[)）][ 　\\t]{0,4}$"
  },
  {
    "id": -22,
    "name": "书名 序号",
    "rule": "^[一-龥]{1,20}[ 　\\t]{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}[ 　\\t]{0,4}$"
  },
  {
    "id": -24,
    "name": "字数分割 分节阅读",
    "rule": "(?<=[ 　\\t]{0,4})(?:.{0,15}分[页节章段]阅读[-_ ]|第\\s{0,4}[\\d零一二两三四五六七八九十百千万]{1,6}\\s{0,4}[页节]).{0,30}$"
  }
];

// 预编译正则（忽略大小写，多行）
const COMPILED = RULES.map((r) => {
  try {
    return { ...r, re: new RegExp(r.rule, 'im') };
  } catch (e) {
    return { ...r, re: null, error: String(e.message || e) };
  }
}).filter((r) => r.re);

function isTitleLine(line) {
  const t = String(line || '');
  if (!t.trim() || t.length > 60) return false;
  return COMPILED.some((r) => r.re.test(t));
}

/**
 * 选择最合适的规则：对给定行集合逐条试，取命中数最多（>=2）的那条
 * @returns {{rule: object|null, hits: number}}
 */
function pickRule(lines) {
  let best = { rule: null, hits: 0 };
  for (const r of COMPILED) {
    let hits = 0;
    for (const line of lines) {
      if (line && line.length <= 60 && r.re.test(line)) hits++;
    }
    if (hits > best.hits) best = { rule: r, hits };
  }
  return best;
}

/** 用最优规则把整段文本切成章节 */
function splitTxtChapters(text, fallbackTitle) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const pick = pickRule(lines);
  const re = pick.rule ? pick.rule.re : null;
  const chapters = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/^\uFEFF/, '').trimEnd();
    const t = line.trim();
    if (!t) continue;
    if (re && t.length <= 60 && re.test(t) && (!cur || cur.paragraphs.length)) {
      if (cur && cur.paragraphs.length) chapters.push(cur);
      cur = { title: t, paragraphs: [] };
      continue;
    }
    if (!cur) cur = { title: fallbackTitle || '正文', paragraphs: [] };
    cur.paragraphs.push({ k: 'p', t });
  }
  if (cur && cur.paragraphs.length) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: fallbackTitle || '正文', paragraphs: [{ k: 'p', t: String(text || '').slice(0, 4000) }] });
  return { chapters, rule: pick.rule ? pick.rule.name : '', hits: pick.hits };
}

module.exports = { RULES, COMPILED, isTitleLine, pickRule, splitTxtChapters };
