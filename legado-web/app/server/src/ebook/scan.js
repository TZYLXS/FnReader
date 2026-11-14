'use strict';
// 目录扫描：发现 ebook 目录里的新文件，算 sha1，复制副本，交给调度
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const bus = require('./bus');

const EXTS = ['.epub', '.mobi', '.azw', '.azw3', '.prc', '.pdf', '.txt'];
const SKIP_DIRS = new Set(['@eaDir', '#recycle', '.@#', '.git', 'node_modules']);

function ebookDir(ctx) {
  const cfg = ctx.config();
  if (cfg.ebookDir && String(cfg.ebookDir).trim()) return String(cfg.ebookDir).trim();
  const download = cfg.downloadDir || path.join(ctx.dataDir, 'downloads');
  return path.join(download, 'ebook');
}

function formatOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.epub') return 'epub';
  if (ext === '.mobi' || ext === '.prc' || ext === '.azw' || ext === '.azw3') return 'mobi';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.txt') return 'txt';
  return '';
}

function looksTemp(name) {
  return /\.(part|tmp|crdownload|download)$/i.test(name) || name.startsWith('._');
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function collect(root, maxDepth = 3, skipPaths = []) {
  const out = [];
  const skip = skipPaths.map((p) => path.resolve(p));
  async function walk(dir, depth) {
    let list = [];
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of list) {
      if (out.length > 5000) return;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skip.includes(path.resolve(full))) continue;
        if (SKIP_DIRS.has(ent.name) || depth >= maxDepth) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (looksTemp(ent.name)) continue;
      if (!formatOf(ent.name)) continue;
      out.push(full);
    }
  }
  await walk(root, 0);
  return out;
}

let scanning = false;

async function scanOnce(ctx) {
  if (scanning) return { skipped: true };
  scanning = true;
  const cfg = ctx.config();
  const root = ebookDir(ctx);
  const result = { root, found: 0, added: 0, skipped: 0, errors: 0 };
  try {
    await fsp.mkdir(root, { recursive: true }).catch(() => {});
    // ebookDir 可能被指到应用数据目录；跳过自建的 files/ 与 books/，避免把解析产物当新书
    const dataRoot = store.dataRoot(ctx.dataDir);
    const files = await collect(root, Number(cfg.ebookScanDepth) || 3, [
      path.join(dataRoot, 'files'),
      path.join(dataRoot, 'books'),
    ]);
    result.found = files.length;
    const index = store.loadIndex(ctx.dataDir);
    const known = new Map(index.map((e) => [e.sourcePath, e]));
    const maxBytes = (Number(cfg.ebookMaxMB) || 512) * 1024 * 1024;

    for (const file of files) {
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      if (!st.size) continue;
      if (st.size > maxBytes) {
        const prev = known.get(file);
        if (!prev) {
          store.upsertEntry(ctx.dataDir, {
            sha1: 'skip-' + crypto.createHash('sha1').update(file).digest('hex').slice(0, 16),
            name: path.basename(file, path.extname(file)),
            format: formatOf(file),
            sourcePath: file,
            size: st.size,
            status: 'ignored',
            error: '超过单文件上限',
          });
        }
        continue;
      }
      if (Date.now() - st.mtimeMs < 20000) continue; // 可能还在拷贝

      const prev = known.get(file);
      if (prev && prev.status !== 'ignored' && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.sha1) {
        continue;
      }
      if (prev && prev.status === 'complete' && prev.size === st.size) continue;

      let sha1;
      try {
        sha1 = await hashFile(file);
      } catch {
        result.errors++;
        continue;
      }
      const existing = store.getEntry(ctx.dataDir, sha1);
      if (existing) {
        if (existing.sourcePath !== file || existing.size !== st.size) {
          store.upsertEntry(ctx.dataDir, { sha1, sourcePath: file, size: st.size, mtimeMs: st.mtimeMs, status: existing.status || 'queued' });
        }
        if (existing.status === 'complete' || existing.status === 'parsing' || existing.status === 'queued') continue;
        if (existing.status === 'failed') continue;
      }

      const ext = path.extname(file).toLowerCase();
      const dest = path.join(store.filesDir(ctx.dataDir), sha1 + ext);
      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) await fsp.copyFile(file, dest);
        // 有些卷/ACL 复制过来是 0000，解析时读不了，这里统一放开读权限
        try {
          fs.chmodSync(dest, 0o644);
        } catch {
          /* 权限操作失败不阻断扫描 */
        }
      } catch (e) {
        result.errors++;
        ctx.log && ctx.log('[ebook] 复制失败 ' + file + ': ' + e.message);
        continue;
      }

      const entry = store.upsertEntry(ctx.dataDir, {
        sha1,
        name: path.basename(file, ext),
        format: formatOf(file),
        size: st.size,
        sourcePath: file,
        mtimeMs: st.mtimeMs,
        file: dest,
        status: existing && existing.status === 'complete' ? 'complete' : 'discovered',
        error: '',
      });
      result.added++;
      if (entry.status !== 'complete') {
        bus.dispatch(ctx, entry);
      }
    }

    // 原目录里被删掉的书只标记，不删已解析内容
    for (const e of store.loadIndex(ctx.dataDir)) {
      if (!e.sourcePath || e.status === 'ignored') continue;
      if (!files.includes(e.sourcePath) && e.status !== 'missing') {
        store.upsertEntry(ctx.dataDir, { sha1: e.sha1, status: 'missing' });
      }
    }
  } finally {
    scanning = false;
  }
  ctx.log && ctx.log(`[ebook] 扫描完成 ${root} 发现=${result.found} 新增=${result.added}`);
  return result;
}

function start(ctx, intervalMs) {
  const every = Math.max(15000, Number(intervalMs) || (Number(ctx.config().ebookScanSec) || 60) * 1000);
  setTimeout(() => scanOnce(ctx).catch(() => {}), 3000).unref?.();
  const timer = setInterval(() => scanOnce(ctx).catch(() => {}), every);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { scanOnce, start, ebookDir };
