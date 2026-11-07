'use strict';
// 章节正文磁盘缓存：第二次打开同一章直接命中，不再走网络
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.TRIM_PKGVAR || process.env.LEGADO_DATA || path.join(process.cwd(), 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const TTL = Number(process.env.LEGADO_CACHE_DAYS || 14) * 24 * 3600 * 1000;

function ensureDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function fileOf(key) {
  const h = crypto.createHash('sha1').update(String(key)).digest('hex');
  return path.join(CACHE_DIR, h.slice(0, 2), h + '.json');
}

function get(key) {
  const file = fileOf(key);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > TTL) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.paragraphs) ? data : null;
  } catch {
    return null;
  }
}

function set(key, payload) {
  ensureDir();
  const file = fileOf(key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...payload, t: Date.now() }), 'utf8');
  } catch {
    /* 缓存失败不影响功能 */
  }
}

/** 简单容量控制：超过 200MB 时清掉最旧的一半 */
function prune(maxBytes = 200 * 1024 * 1024) {
  let total = 0;
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = fs.statSync(p);
          total += st.size;
          files.push({ p, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(CACHE_DIR);
  if (total <= maxBytes) return;
  files.sort((a, b) => a.mtime - b.mtime);
  let freed = 0;
  for (const f of files) {
    if (total - freed <= maxBytes * 0.5) break;
    try {
      fs.unlinkSync(f.p);
      freed += f.size;
    } catch {
      /* ignore */
    }
  }
}

module.exports = { get, set, prune, dir: CACHE_DIR };
