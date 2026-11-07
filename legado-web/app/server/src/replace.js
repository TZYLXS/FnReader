'use strict';
// 正文/标题的「替换 · 屏蔽」规则（兼容 Legado 的 exportReplaceRule.json）
const fs = require('node:fs');
const path = require('node:path');
const { runJs } = require('./jsrules');

const FILE = 'replace-rules.json';

let cache = null;

function filePath(dataDir) {
  return path.join(dataDir, FILE);
}

function load(dataDir) {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(dataDir), 'utf8'));
  } catch {
    cache = [];
  }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

function save(dataDir, rules) {
  cache = rules;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath(dataDir), JSON.stringify(rules, null, 2), 'utf8');
}

function invalidate() {
  cache = null;
}

/** 把 PCRE 写法尽量翻译成 JS 正则 */
function toJsRegex(pattern, isRegex) {
  let src = String(pattern || '');
  if (!isRegex) return { literal: src };

  let flags = 'g';
  const m = src.match(/^\(\?([imsux]+)\)/);
  if (m) {
    for (const f of m[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
    src = src.slice(m[0].length);
  }
  src = src.replace(/\\h/g, '[ \\t]').replace(/\\R/g, '\\n');
  // 内联的 (?i) 等（出现在中间时）删掉，避免 SyntaxError
  src = src.replace(/\(\?[imsux]+\)/g, '');

  return { literal: null, source: src, flags };
}

function applyReplacement(rule, matched, compiled) {
  const rep = rule.replacement == null ? '' : String(rule.replacement);
  if (rep.startsWith('@js:')) {
    const code = rep.slice(4);
    try {
      const out = runJs(code, { result: matched });
      return out == null ? '' : String(out);
    } catch {
      return matched;
    }
  }
  return rep;
}

/**
 * 对整段文本应用规则
 * @param {string[]} rules
 * @param {string} text
 * @param {'content'|'title'} scope
 */
function applyText(rules, text, scope) {
  let out = String(text == null ? '' : text);
  for (const rule of rules) {
    if (!rule || rule.isEnabled === false) continue;
    const wantContent = rule.scopeContent !== false;
    const wantTitle = rule.scopeTitle === true;
    if (scope === 'title' && !wantTitle) continue;
    if (scope === 'content' && !wantContent) continue;

    try {
      const c = toJsRegex(rule.pattern, rule.isRegex);
      if (c.literal != null) {
        if (!c.literal) continue;
        out = out.split(c.literal).join(applyReplacement(rule, c.literal, c));
        continue;
      }
      const re = new RegExp(c.source, c.flags);
      out = out.replace(re, (m, ...rest) => applyReplacement(rule, m, c));
    } catch {
      // 单条规则写错不影响其它规则
    }
  }
  return out;
}

/** 正文按段落处理：合并成一段文本后统一替换，再按段落拆回 */
function applyToParagraphs(rules, paragraphs) {
  if (!rules.length || !Array.isArray(paragraphs) || !paragraphs.length) return paragraphs;
  const joined = paragraphs.join('\n');
  const replaced = applyText(rules, joined, 'content');
  if (replaced === joined) return paragraphs;
  return replaced
    .split('\n')
    .map((s) => s.replace(/\s+$/, ''))
    .filter((s) => s.trim().length > 0);
}

module.exports = { load, save, invalidate, applyText, applyToParagraphs, filePath, toJsRegex };
