'use strict';
// 极简 XPath 引擎（覆盖书源常用写法），运行在 cheerio 的 DOM 上

function isElement(n) {
  return n && (n.type === 'tag' || n.type === 'script' || n.type === 'style');
}

function childNodes(n) {
  return (n && n.children) || [];
}

function descendants(n, out = []) {
  for (const c of childNodes(n)) {
    out.push(c);
    descendants(c, out);
  }
  return out;
}

function nodeText(n) {
  if (!n) return '';
  if (n.type === 'text') return n.data || '';
  if (n.type === 'attribute') return n.value || '';
  let s = '';
  for (const c of childNodes(n)) s += nodeText(c);
  return s;
}

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** 去掉引号的字面量 */
function unquote(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
}

function splitSteps(expr) {
  // 按 '/' 切分，但忽略 [] 与引号内部
  const steps = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  let axis = '/';
  let i = 0;
  if (expr.startsWith('//')) {
    axis = '//';
    i = 2;
  } else if (expr.startsWith('/')) {
    i = 1;
  } else if (expr === '.' || expr.startsWith('./') || expr.startsWith('.//')) {
    // 相对路径
  }
  for (; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '/' && depth === 0) {
      steps.push({ axis, raw: buf });
      buf = '';
      axis = ch === '/' ? '/' : '/';
      if (expr[i + 1] === '/') {
        axis = '//';
        i++;
      }
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) steps.push({ axis, raw: buf });
  return steps.filter((s) => s.raw.trim() !== '');
}

function parseStep(raw) {
  let s = raw.trim();
  const predicates = [];
  // 取出末尾的 [..]
  for (;;) {
    const m = s.match(/^(.*)\[([^[\]]*)\]$/);
    if (!m) break;
    predicates.unshift(m[2]);
    s = m[1];
  }
  if (s === '.' || s === '') return { kind: 'self', predicates };
  if (s === '..') return { kind: 'parent', predicates };
  if (s === 'text()') return { kind: 'text', predicates };
  if (s === 'node()') return { kind: 'node', predicates };
  if (s === '*') return { kind: 'any', predicates };
  if (s.startsWith('@')) return { kind: 'attr', name: s.slice(1), predicates };
  return { kind: 'tag', name: s.replace(/^[\w-]+:/, ''), predicates };
}

function matchPredicate(node, expr, index, total) {
  const e = expr.trim();
  let m;
  if ((m = e.match(/^(\d+)$/))) return index + 1 === Number(m[1]);
  if (e === 'last()') return index + 1 === total;
  if (e === 'first()') return index === 0;
  if ((m = e.match(/^position\(\)\s*([<>=!]+)\s*(\d+)$/))) {
    const v = index + 1;
    const n = Number(m[2]);
    switch (m[1]) {
      case '>': return v > n;
      case '>=': return v >= n;
      case '<': return v < n;
      case '<=': return v <= n;
      case '=': return v === n;
      case '!=': return v !== n;
    }
  }
  if ((m = e.match(/^@([\w:-]+)$/))) {
    if (!isElement(node)) return false;
    const v = node.attribs && node.attribs[m[1]];
    return v !== undefined && v !== '';
  }
  if ((m = e.match(/^@([\w:-]+)\s*([!=]+)\s*(.+)$/))) {
    if (!isElement(node)) return false;
    const v = (node.attribs && node.attribs[m[1]]) || '';
    const want = unquote(m[3]);
    return m[2] === '=' ? v === want : v !== want;
  }
  if ((m = e.match(/^contains\(\s*@([\w:-]+)\s*,\s*(.+?)\s*\)$/))) {
    if (!isElement(node)) return false;
    const v = (node.attribs && node.attribs[m[1]]) || '';
    return v.includes(unquote(m[2]));
  }
  if ((m = e.match(/^contains\(\s*text\(\)\s*,\s*(.+?)\s*\)$/))) {
    return normText(nodeText(node)).includes(unquote(m[1]));
  }
  if ((m = e.match(/^text\(\)\s*([!=]+)\s*(.+)$/))) {
    const want = unquote(m[2]);
    const have = normText(nodeText(node));
    return m[1] === '=' ? have === want : have !== want;
  }
  if ((m = e.match(/^not\((.+)\)$/))) return !matchPredicate(node, m[1], index, total);
  // 无法识别：忽略该谓词
  return true;
}

function applyPredicates(nodes, predicates) {
  let out = nodes;
  for (const p of predicates) {
    const total = out.length;
    out = out.filter((n, i) => matchPredicate(n, p, i, total));
  }
  return out;
}

function stepNodes(context, step) {
  const parsed = parseStep(step.raw);
  const pool = [];
  for (const ctx of context) {
    if (parsed.kind === 'self') pool.push(ctx);
    else if (parsed.kind === 'parent') {
      if (ctx.parent) pool.push(ctx.parent);
    } else if (parsed.kind === 'attr') {
      // /@href 作用于节点本身
      if (isElement(ctx) && ctx.attribs && ctx.attribs[parsed.name] !== undefined) {
        pool.push({ type: 'attribute', value: ctx.attribs[parsed.name], parent: ctx });
      }
    } else {
      const cands = step.axis === '//' ? descendants(ctx) : childNodes(ctx);
      for (const c of cands) {
        if (parsed.kind === 'any') {
          if (isElement(c)) pool.push(c);
        } else if (parsed.kind === 'text') {
          if (c.type === 'text' && String(c.data || '').trim() !== '') pool.push(c);
        } else if (parsed.kind === 'node') {
          pool.push(c);
        } else if (parsed.kind === 'attr') {
          if (isElement(c) && c.attribs && c.attribs[parsed.name] !== undefined) {
            pool.push({ type: 'attribute', value: c.attribs[parsed.name], parent: c });
          }
        } else if (isElement(c) && c.name === parsed.name) {
          pool.push(c);
        }
      }
    }
  }
  return applyPredicates(pool.filter(Boolean), parsed.predicates);
}

/**
 * 在 cheerio 根节点上求值
 * @returns {Array} 节点数组（element / text / attribute）
 */
function evaluateXPath(root, expr) {
  const e = String(expr || '').trim();
  if (!e) return [];
  if (e === '//text()') return descendants(root).filter((n) => n.type === 'text' && String(n.data || '').trim());
  const parts = e.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const out = [];
    for (const p of parts) out.push(...evaluateXPath(root, p));
    return out;
  }
  let context = [root];
  for (const step of splitSteps(e)) context = stepNodes(context, step);
  return context;
}

function xpathResults(root, expr) {
  return evaluateXPath(root, expr).map((n) => {
    if (n.type === 'attribute') return { value: n.value, isAttr: true };
    if (n.type === 'text') return { value: normText(n.data), isText: true };
    return { value: normText(nodeText(n)), node: n };
  });
}

module.exports = { evaluateXPath, xpathResults, nodeText, normText, isElement };
