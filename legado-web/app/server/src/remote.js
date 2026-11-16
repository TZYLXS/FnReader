'use strict';
// 手机端解析桥：服务端跑不了的书源（需要 WebView / 加密接口）交给 App 解析
//   网页 → POST /api/remote/job       建任务并等待结果
//   App  → GET  /api/m/remote/pending  领任务（长轮询）
//   App  → POST /api/m/remote/result   回结果
//
// 任务按「类」路由，并给每台设备一个隐藏性能分：
//   book    获取书籍（search / toc / rank / ebook-parse / ebook-chapter）→ 高分设备优先
//   content 获取正文（content）                                        → 高分设备优先
//   media   获取封面/简介（bookinfo / cover / intro）                  → 低分设备优先
//
// 领任务即锁定（dispatchedTo），其它设备不会再领到同一任务；结果幂等。
const crypto = require('node:crypto');
const weights = require('./busweights');

const jobs = new Map(); // id -> job
const devices = new Map(); // id -> device（含隐藏性能分 score）
const done = new Map(); // id -> {at, by, ok}  已完成后保留 5 分钟，用于幂等判断
const recent = []; // 最近回传，排查用

const ONLINE_MS = 60000; // 60 秒内有心跳算在线
const LOCK_MS = 30000; // 领任务后锁定 30 秒，超时可被其它设备重新领取
const DONE_TTL = 300000; // 完成记录保留 5 分钟
const WAIT_MS = 20000;
const MAX_AGE = 120000;

const { classOf } = weights;

/** 调试设备：ID 含 bus-debug/busmon/monitor/mock/fake/e2e/debug，或名称含调试/监控/测试机 */
function isDebugDevice(id, name) {
  const text = String(id || '') + ' ' + String(name || '');
  return /(bus[-_]?debug|busmon|\bmonitor\b|\bmock\b|\bfake\b|\be2e\b|\bdebug\b)/i.test(text) ||
    /(调试|监控|测试机)/.test(text);
}


// ---------------- 设备与隐藏性能分 ----------------

function clampScore(v) {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(v)));
}

/** App 报到 / 心跳 */
function hello(info = {}) {
  const id = String(info.id || info.deviceId || '').trim() || 'unknown';
  const prev = devices.get(id) || { handled: 0, enabled: true };
  const stat = weights.newDevice(prev, info);
  const dev = {
    id,
    name: String(info.name || prev.name || '未命名设备'),
    model: String(info.model || prev.model || ''),
    version: String(info.version || prev.version || ''),
    lastSeen: Date.now(),
    handled: prev.handled || 0,
    enabled: prev.enabled !== false,
    debug: isDebugDevice(id, info.name || prev.name),
    ...stat,
  };
  devices.set(id, dev);
  return dev;
}

function touch(id) {
  const dev = devices.get(id);
  if (dev) dev.lastSeen = Date.now();
}

function bumpHandled(id) {
  const dev = devices.get(id);
  if (dev) {
    dev.handled = (dev.handled || 0) + 1;
    dev.lastSeen = Date.now();
  }
}

function online(dev) {
  return dev && Date.now() - dev.lastSeen < ONLINE_MS;
}

function listDevices() {
  const now = Date.now();
  return [...devices.values()]
    .map((d) => ({
      ...d,
      online: now - d.lastSeen < ONLINE_MS,
      idle: Math.round((now - d.lastSeen) / 1000),
    }))
    .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.lastSeen - a.lastSeen);
}

function setEnabled(id, enabled) {
  const dev = devices.get(id);
  if (!dev) return false;
  dev.enabled = !!enabled;
  return true;
}

// ---------------- 任务队列 ----------------

function purge() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expireAt && now > job.expireAt) {
      releaseJob(job);
      jobs.delete(id);
      if (job.resolve) job.resolve({ ok: false, error: 'timeout' });
    }
  }
  for (const [id, rec] of done) {
    if (now - rec.at > DONE_TTL) done.delete(id);
  }
}

function releaseJob(job) {
  if (!job) return;
  const dev = devices.get(job.dispatchedTo || '');
  if (dev && dev.inflight > 0) dev.inflight--;
  job.dispatchedTo = '';
  job.dispatchedAt = 0;
}

/**
 * 建任务并返回 {id, promise}；ebook-parse 这类长任务用 ttlMs 单独放宽存活时间
 */
function create(type, payload, opts = {}) {
  purge();
  const waitMs = Number(opts.waitMs) || WAIT_MS;
  const ttlMs = Number(opts.ttlMs) || Math.max(waitMs, MAX_AGE);
  const id = crypto.randomBytes(6).toString('hex');
  const createdAt = Date.now();
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      const job = jobs.get(id);
      if (job) {
        releaseJob(job);
        jobs.delete(id);
      }
      resolve({ ok: false, error: 'timeout' });
    }, waitMs);
    jobs.set(id, {
      id,
      type,
      taskClass: classOf(type),
      payload,
      createdAt,
      expireAt: createdAt + ttlMs,
      resolve,
      timer,
      debug: !!(payload && payload.debug === true),
      dispatchedTo: '',
      dispatchedAt: 0,
    });
  });
  return { id, promise };
}

/** 创建任务并等待手机回传；超时返回 {ok:false,error:'timeout'} */
function request(type, payload, waitMs = WAIT_MS) {
  return create(type, payload, { waitMs }).promise;
}

/** 放弃任务（看门狗/兜底时用）：等待方立刻收到 abandoned */
function abandon(id) {
  const job = jobs.get(id);
  if (!job) return false;
  releaseJob(job);
  clearTimeout(job.timer);
  jobs.delete(id);
  if (job.resolve) job.resolve({ ok: false, error: 'abandoned' });
  return true;
}

/**
 * 手机领任务：
 * - 暂停设备 / 调试设备规则
 * - 按设备性能分决定能领哪些类
 * - 领走即锁定，其它设备看不到；锁定超时或任务超时后自动释放
 */
function pending(limit = 5, deviceId = '') {
  purge();
  const dev = devices.get(String(deviceId || ''));
  const debugDevice = !!(dev && dev.debug) || isDebugDevice(deviceId, '');
  const enabled = !dev || dev.enabled !== false;
  if (!enabled) return [];
  if (!dev) return [];

  const slots = Math.max(0, weights.maxInflight(dev) - (dev.inflight || 0));
  if (!slots) return [];
  const cap = Math.min(limit, slots);
  const now = Date.now();
  const classes = weights.eligibleClasses(dev, weights.hasHighOnline([...devices.values()].filter(online)));

  const eligible = [...jobs.values()]
    .filter((j) => (debugDevice ? j.debug : !j.debug))
    .filter((j) => (debugDevice ? true : classes.includes(j.taskClass)))
    .filter((j) => {
      if (!j.dispatchedTo) return true;
      if (j.dispatchedTo === dev.id) return true;
      return now - (j.dispatchedAt || 0) > LOCK_MS; // 锁过期可重新领取
    });
  const candidates = weights.sortJobs(eligible, dev, classes).slice(0, cap);

  for (const j of candidates) {
    if (j.dispatchedTo && j.dispatchedTo !== dev.id) releaseJob(j);
    j.dispatchedTo = dev.id;
    j.dispatchedAt = now;
    if (!j.lockedBy || j.lockedBy !== dev.id) dev.inflight = (dev.inflight || 0) + 1;
    j.lockedBy = dev.id;
  }

  return candidates.map((j) => ({
    id: j.id,
    type: j.type,
    taskClass: j.taskClass,
    payload: j.payload,
    age: now - j.createdAt,
  }));
}

function complete(id, ok, data, error, deviceId = '') {
  purge();
  const dev = devices.get(String(deviceId || ''));
  if ((dev && dev.debug) || isDebugDevice(deviceId, '')) {
    // 调试设备的回传一律丢弃：不 resolve、不写 recent，任务等真正设备或超时
    console.log('[softbus] 忽略调试设备回传 device=' + deviceId + ' job=' + id);
    return 'ignored';
  }

  const job = jobs.get(id);
  if (!job) {
    // 幂等：已经处理过的任务，重复回传直接告知，不再报错
    if (done.has(id)) return 'duplicate';
    return false;
  }

  // 结果只认「当前锁定的设备」或未锁定时的第一个回传
  if (job.dispatchedTo && deviceId && job.dispatchedTo !== deviceId) {
    console.log('[softbus] 非锁定设备回传已丢弃 device=' + deviceId + ' locked=' + job.dispatchedTo + ' job=' + id);
    return 'stale';
  }

  const ms = Date.now() - job.createdAt;
  if (dev) weights.updateScore(dev, !!ok, ms);
  releaseJob(job);

  try {
    recent.push({
      at: Date.now(),
      type: job.type,
      ok: !!ok,
      by: deviceId || '',
      keys: data && typeof data === 'object' ? Object.keys(data) : [],
      sample: JSON.stringify(data || error || '').slice(0, 300),
    });
    if (recent.length > 20) recent.shift();
  } catch {
    /* ignore */
  }

  clearTimeout(job.timer);
  jobs.delete(id);
  done.set(id, { at: Date.now(), by: deviceId || '', ok: !!ok, type: job.type });
  job.resolve(ok ? { ok: true, data } : { ok: false, error: error || 'failed' });
  return true;
}

function stats() {
  purge();
  return {
    pending: jobs.size,
    recent: recent.slice(-5),
    ...weights.summarize([...devices.values()], online),
  };
}

module.exports = {
  request, create, abandon, pending, complete, stats, hello, touch, bumpHandled,
  listDevices, setEnabled, isDebugDevice, classOf,
};
