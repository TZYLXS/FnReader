'use strict';
// 缓存目录去重：<下载目录>/cache/ 下同一本书可能因为多次同步产生
// 「书名」「书名 (2)」… 这类重复目录，这里按 meta.json 的 bookUrl 归并
const fs = require('node:fs');
const path = require('node:path');

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 在 cache 根目录下找这本书已有的目录（按 meta.bookUrl 匹配，拿不到就按书名） */
function findExistingDir(root, bookUrl, name) {
  if (!fs.existsSync(root)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }
  let byName = null;
  for (const e of entries) {
    const dir = path.join(root, e.name);
    const meta = readMeta(dir);
    if (meta && bookUrl && meta.bookUrl === bookUrl) return dir;
    if (!byName && name && (e.name === name || e.name.startsWith(name + ' ('))) byName = dir;
  }
  return byName;
}

function countFiles(dir, limit = 10000) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (n >= limit) return;
      if (e.isDirectory()) walk(p);
      else n++;
    }
  };
  walk(dir);
  return n;
}

/** 把一个目录合并进目标目录（同名文件以源为准，不删目标独有文件） */
function mergeInto(srcDir, dstDir) {
  const walk = (d, rel) => {
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const from = path.join(d, e.name);
      const to = path.join(dstDir, rel, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(from, path.join(rel, e.name));
      } else {
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          if (!fs.existsSync(to)) fs.copyFileSync(from, to);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(srcDir, '');
}

/** 去掉「书名 (3)」这种后缀，恢复成书名 */
function canonicalName(dirName) {
  return dirName.replace(/\s*\(\d+\)$/, '');
}

/**
 * 清理 cache 根目录下的重复书本目录
 * @returns {{groups:number, removed:number, merged:number, renamed:number}}
 */
async function dedupeCache(root) {
  const result = { groups: 0, removed: 0, merged: 0, renamed: 0 };
  if (!fs.existsSync(root)) return result;
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return result;
  }

  const groups = new Map();
  for (const dir of dirs) {
    const meta = readMeta(dir);
    const key = (meta && meta.bookUrl) || canonicalName(path.basename(dir));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(dir);
  }

  const tick = () => new Promise((r) => setImmediate(r));
  for (const list of groups.values()) {
    await tick();
    if (list.length <= 1) {
      // 只有一个目录时，也把「书名 (2)」改回书名（如果书名目录空着）
      const only = list[0];
      const base = canonicalName(path.basename(only));
      if (base !== path.basename(only)) {
        const target = path.join(root, base);
        if (!fs.existsSync(target)) {
          try {
            fs.renameSync(only, target);
            result.renamed++;
          } catch {
            /* ignore */
          }
        }
      }
      continue;
    }
    result.groups++;
    // 保留文件最多、其次最新的一个
    const scored = list
      .map((d) => {
        let mtime = 0;
        try {
          mtime = fs.statSync(d).mtimeMs;
        } catch {
          /* ignore */
        }
        return { dir: d, files: countFiles(d), mtime };
      })
      .sort((a, b) => b.files - a.files || b.mtime - a.mtime);

    const keep = scored[0].dir;
    for (const item of scored.slice(1)) {
      await tick();
      mergeInto(item.dir, keep);
      try {
        fs.rmSync(item.dir, { recursive: true, force: true });
        result.removed++;
        result.merged++;
      } catch {
        /* ignore */
      }
    }
    // 重命名成规范书名
    const base = canonicalName(path.basename(keep));
    const target = path.join(root, base);
    if (base !== path.basename(keep) && !fs.existsSync(target)) {
      try {
        fs.renameSync(keep, target);
        result.renamed++;
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

module.exports = { dedupeCache, findExistingDir, canonicalName };
