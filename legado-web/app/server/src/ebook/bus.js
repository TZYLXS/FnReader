'use strict';
// 软总线调度：有手机派任务，没手机/超时本地兜底
const store = require('./store');
const local = require('./local');

const jobsBySha = new Map(); // sha1 -> { jobId, fellBack }
const localQueue = [];
let localRunning = 0;

function deps(ctx) {
  return ctx;
}

function onlineDevices(ctx) {
  return ctx.remote.listDevices().filter((d) => d.online && d.enabled !== false);
}

function enqueueLocal(ctx, entry, reason) {
  const sha1 = entry.sha1;
  const row = jobsBySha.get(sha1);
  if (row && row.fellBack) return;
  if (row) row.fellBack = true;
  localQueue.push({ entry, reason });
  store.upsertEntry(ctx.dataDir, { sha1, status: 'parsing', source: 'server', error: '', fallbackReason: reason || '' });
  pumpLocal(ctx);
}

function pumpLocal(ctx) {
  const limit = Math.max(1, Number(ctx.config().ebookLocalConcurrency) || 2);
  while (localRunning < limit && localQueue.length) {
    const task = localQueue.shift();
    localRunning++;
    setImmediate(() => {
      const entry = store.getEntry(ctx.dataDir, task.entry.sha1) || task.entry;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = local.parseLocal(ctx.dataDir, entry);
          jobsBySha.delete(entry.sha1);
          ctx.log && ctx.log(`[ebook] 本地解析完成 ${entry.name} 章=${r.chapters} 来源=${task.reason}`);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          ctx.log && ctx.log(`[ebook] 本地解析失败(${attempt + 1}/3) ${entry.name}: ${e.code || ''} ${e.message}`);
        }
      }
      if (lastError) {
        store.upsertEntry(ctx.dataDir, {
          sha1: entry.sha1,
          status: 'failed',
          source: 'server',
          error: String(lastError.code || 'local-parse') + ': ' + String(lastError.message || ''),
        });
        jobsBySha.delete(entry.sha1);
      }
      localRunning--;
      pumpLocal(ctx);
    });
  }
}

function dispatch(ctx, entry) {
  const cfg = ctx.config();
  if (!cfg.ebookEnabled) return;
  const existing = jobsBySha.get(entry.sha1);
  if (existing) return;
  if (entry.status === 'complete' || entry.status === 'parsing') return;
  // PDF/TXT 手机端不解析，直接本机处理；只有 EPUB/MOBI 才值得走软总线
  if (entry.format !== 'epub' && entry.format !== 'mobi') {
    enqueueLocal(ctx, entry, 'server-format');
    return;
  }

  const devices = onlineDevices(ctx);
  if (!devices.length || cfg.ebookFallbackEnabled === false) {
    if (!devices.length && cfg.ebookFallbackEnabled !== false) {
      enqueueLocal(ctx, entry, 'no-device');
      return;
    }
    if (!devices.length) {
      store.upsertEntry(ctx.dataDir, { sha1: entry.sha1, status: 'queued', error: '没有在线设备' });
      return;
    }
  }

  const payload = {
    sha1: entry.sha1,
    name: entry.name,
    format: entry.format,
    size: entry.size,
    fileUrl: `/api/m/ebook/file/${entry.sha1}`,
    token: ctx.token(),
    schema: local.SCHEMA,
    partMaxBytes: 4194304,
  };
  const ttlMs = Math.max(120000, Number(cfg.ebookJobTtlMs) || 600000);
  const created = ctx.remote.create('ebook-parse', payload, { ttlMs, waitMs: ttlMs });
  const row = { jobId: created.id, fellBack: false, at: Date.now() };
  jobsBySha.set(entry.sha1, row);
  store.upsertEntry(ctx.dataDir, { sha1: entry.sha1, status: 'queued', jobId: created.id, error: '' });

  const fallbackMs = Math.max(60000, (Number(cfg.ebookFallbackAfterMin) || 10) * 60 * 1000);
  const timer = setTimeout(() => {
    const cur = jobsBySha.get(entry.sha1);
    if (!cur || cur.fellBack) return;
    const fresh = store.getEntry(ctx.dataDir, entry.sha1);
    const received = fresh ? store.receivedParts(ctx.dataDir, entry.sha1) : [];
    if (received.length) return; // 已经开工，交给 watchdog
    ctx.remote.abandon(created.id);
    jobsBySha.delete(entry.sha1);
    enqueueLocal(ctx, entry, 'device-idle');
  }, fallbackMs);
  if (timer.unref) timer.unref();
  row.timer = timer;

  created.promise.then((result) => {
    const cur = jobsBySha.get(entry.sha1);
    if (!cur || cur.fellBack) return;
    if (timer) clearTimeout(timer);
    jobsBySha.delete(entry.sha1);
    const fresh = store.getEntry(ctx.dataDir, entry.sha1);
    if (result.ok) {
      const data = result.data || {};
      const total = Number(data.parts) || 0;
      const received = store.receivedParts(ctx.dataDir, entry.sha1);
      if (fresh && fresh.status === 'complete') return;
      if (total && received.length >= total) {
        store.upsertEntry(ctx.dataDir, { sha1: entry.sha1, status: 'complete', source: 'device' });
      } else {
        store.upsertEntry(ctx.dataDir, { sha1: entry.sha1, status: 'partial', source: 'device' });
      }
      return;
    }
    const err = String(result.error || '');
    if (err === 'abandoned') return;
    if (err === 'drm' || err === 'corrupt' || err === 'unsupported' || err === 'kf8-unsupported') {
      store.upsertEntry(ctx.dataDir, { sha1: entry.sha1, status: 'failed', error: err });
      return;
    }
    enqueueLocal(ctx, entry, 'device-' + (err || 'failed'));
  });
}

/** 分片到达：刷新进度时间，并给「解析中掉线」用 */
function touchProgress(ctx, sha1) {
  store.upsertEntry(ctx.dataDir, { sha1, lastProgressAt: Date.now() });
}

/** 看门狗：手机解析中长时间没有新分片 → 本地接手 */
function startWatchdog(ctx, intervalMs = 30000) {
  const timer = setInterval(() => {
    const cfg = ctx.config();
    if (!cfg.ebookEnabled || cfg.ebookFallbackEnabled === false) return;
    const grace = Math.max(30000, (Number(cfg.ebookOfflineGraceSec) || 120) * 1000);
    const now = Date.now();
    for (const entry of store.loadIndex(ctx.dataDir)) {
      if (entry.status !== 'partial' && entry.status !== 'parsing') continue;
      if (entry.source !== 'device') continue;
      const last = Math.max(entry.lastProgressAt || 0, entry.updatedAt || 0);
      if (now - last < grace) continue;
      const received = store.receivedParts(ctx.dataDir, entry.sha1);
      if (!received.length) continue;
      const row = jobsBySha.get(entry.sha1);
      if (row) {
        ctx.remote.abandon(row.jobId);
        jobsBySha.delete(entry.sha1);
      }
      enqueueLocal(ctx, entry, 'device-offline');
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { dispatch, enqueueLocal, touchProgress, startWatchdog, jobsBySha };
