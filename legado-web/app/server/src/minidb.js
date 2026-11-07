'use strict';
// 极简嵌入式 KV 存储：内存索引 + 追加写 JSONL，用于搜索结果缓存
const fs = require('node:fs');
const path = require('node:path');

class MiniDB {
  constructor(file, options = {}) {
    this.file = file;
    this.maxEntries = options.maxEntries || 4000;
    this.ttl = options.ttl || 24 * 3600 * 1000;
    this.map = new Map();
    this.pending = 0;
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const text = fs.readFileSync(this.file, 'utf8');
      const now = Date.now();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (!row || !row.k) continue;
          if (row.exp && row.exp < now) continue;
          this.map.set(row.k, row);
          if (row.hits) this.hits = (this.hits || 0) + row.hits;
        } catch {
          /* 跳过损坏行 */
        }
      }
    } catch {
      /* 首次运行没有文件 */
    }
  }

  get(key) {
    const row = this.map.get(key);
    if (!row) return null;
    if (row.exp && row.exp < Date.now()) {
      this.map.delete(key);
      return null;
    }
    row.hits = (row.hits || 0) + 1;
    row.last = Date.now();
    return row;
  }

  set(key, value, ttl = this.ttl) {
    const row = { k: key, v: value, ts: Date.now(), exp: Date.now() + ttl, hits: 0 };
    this.map.set(key, row);
    this.append(row);
    if (this.map.size > this.maxEntries) this.compact();
  }

  append(row) {
    try {
      const line = JSON.stringify({ k: row.k, v: row.v, ts: row.ts, exp: row.exp, hits: row.hits || 0 }) + '\n';
      fs.appendFileSync(this.file, line, 'utf8');
      this.pending++;
      if (this.pending > 300) this.compact();
    } catch {
      /* 写失败不影响功能 */
    }
  }

  /** 重写文件，丢掉过期项，顺便把文件压小 */
  compact() {
    try {
      const now = Date.now();
      const rows = [];
      for (const [k, row] of this.map) {
        if (row.exp && row.exp < now) this.map.delete(k);
        else rows.push(JSON.stringify({ k, v: row.v, ts: row.ts, exp: row.exp, hits: row.hits || 0 }));
      }
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, rows.join('\n') + (rows.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, this.file);
      this.pending = 0;
    } catch {
      /* ignore */
    }
  }

  stats() {
    let bytes = 0;
    try {
      bytes = fs.statSync(this.file).size;
    } catch {
      /* ignore */
    }
    return { entries: this.map.size, bytes };
  }

  clear() {
    this.map.clear();
    try {
      fs.writeFileSync(this.file, '', 'utf8');
    } catch {
      /* ignore */
    }
  }
}

module.exports = { MiniDB };
