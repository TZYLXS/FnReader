'use strict';
// 轻量 Markdown 解析：文档渲染 + 电子书（.md）分章
// 只支持常用语法：标题、段落、粗斜体、行内代码、代码块、列表、引用、分隔线、链接、简单表格

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function mdToHtml(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 代码块
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      i++;
      const buf = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code"><code data-lang="${esc(lang)}">${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // 分隔线
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }
    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl} class="md-h${lvl}">${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    // 表格
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const head = line.split('|').map((s) => s.trim()).filter((s, idx, arr) => !(idx === 0 && !s) && !(idx === arr.length - 1 && !s));
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i])) {
        rows.push(lines[i].split('|').map((s) => s.trim()).filter((s, idx, arr) => !(idx === 0 && !s) && !(idx === arr.length - 1 && !s)));
        i++;
      }
      out.push(
        '<table class="md-table"><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>'
      );
      continue;
    }
    // 引用
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote class="md-quote">${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }
    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} class="md-list">` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${tag}>`);
      continue;
    }
    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }
    // 段落（连续非空行合并）
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|>|([-*+]|\d+\.)\s|---)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p class="md-p">${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** .md 电子书分章：按 # / ## 标题切，正文按段落/引用/代码 */
function mdToChapters(src, fallbackTitle) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let cur = null;
  let fence = false;
  const ensure = () => {
    if (!cur) cur = { title: fallbackTitle || '正文', paragraphs: [] };
  };
  for (const raw of lines) {
    const line = raw;
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence) {
      const h = /^(#{1,2})\s+(.*)$/.exec(line);
      if (h) {
        if (cur && cur.paragraphs.length) chapters.push(cur);
        cur = { title: h[2].trim(), paragraphs: [] };
        continue;
      }
    }
    ensure();
    const t = line.trim();
    if (!t) continue;
    if (/^(---|\*\*\*|___)$/.test(t)) {
      cur.paragraphs.push({ k: 'hr', t: '' });
      continue;
    }
    if (/^\s*>/.test(line)) {
      cur.paragraphs.push({ k: 'quote', t: line.replace(/^\s*>\s?/, '') });
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      cur.paragraphs.push({ k: 'p', t: '· ' + line.replace(/^\s*([-*+]|\d+\.)\s+/, '') });
      continue;
    }
    const h = /^(#{3,6})\s+(.*)$/.exec(line);
    if (h && !fence) {
      cur.paragraphs.push({ k: 'h' + h[1].length, t: h[2].trim() });
      continue;
    }
    cur.paragraphs.push({ k: 'p', t: t.replace(/[*`_]/g, '') });
  }
  if (cur && cur.paragraphs.length) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: fallbackTitle || '正文', paragraphs: [{ k: 'p', t: String(src || '').slice(0, 4000) }] });
  return chapters;
}

module.exports = { mdToHtml, mdToChapters, esc };
