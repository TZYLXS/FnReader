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
    counts: prev.counts || { toc: 0, search: 0, content: 0, other: 0 },
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
    .map((d) => {
      // 隐藏性能分与内部统计：对外只保留设备身份与在线状态
      const { score, ok, fail, totalMs, samples, inflight, lockedBy, lastResultAt, caps, classes, ...pub } = d;
      return {
        ...pub,
        online: now - d.lastSeen < ONLINE_MS,
        idle: Math.round((now - d.lastSeen) / 1000),
      };
    })
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
      // 传输建模：等待方愿意等多久（服务端口径），派发时再按设备实测收紧/放宽，下发前不超过它
      waitMs,
      timeoutMs: Math.max(1000, waitMs - 500),
      attempts: 0,
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

  // 以实际锁定在手的任务重算在途数，避免异常路径导致 inflight 泄漏把设备卡死
  // 2.6.19 起同时按「任务类」重算：每类一条独立额度（Lane），慢任务不再挤占快任务的槽
  const now = Date.now();
  const usedByClass = { book: 0, content: 0, media: 0 };
  let realInflight = 0;
  for (const j of jobs.values()) {
    if (j.dispatchedTo !== dev.id) continue;
    realInflight++;
    const k = j.taskClass || classOf(j.type);
    if (Object.prototype.hasOwnProperty.call(usedByClass, k)) usedByClass[k]++;
  }
  dev.inflight = realInflight;
  const classes = weights.eligibleClasses(dev, weights.hasHighOnline([...devices.values()].filter(online)));
  const alloc = weights.slotsByClass(dev, classes);
  const totalLeft = Math.max(0, alloc.total - realInflight);
  if (!totalLeft) return [];
  const cap = Math.min(limit, totalLeft);

  const eligible = [...jobs.values()]
    .filter((j) => (debugDevice ? j.debug : !j.debug))
    .filter((j) => (debugDevice ? true : classes.includes(j.taskClass)))
    .filter((j) => {
      if (!j.dispatchedTo) return true;
      // 当前设备已经在处理的任务不要再次派发；把剩余槽位留给等待中的任务。
      if (j.dispatchedTo === dev.id) return false;
      return now - (j.dispatchedAt || 0) > LOCK_MS; // 锁过期可重新领取
    });
  const sorted = weights.sortJobs(eligible, dev, classes, now);
  const picked = [];
  const pickCount = {};
  for (const j of sorted) {
    if (picked.length >= cap) break;
    const k = j.taskClass || classOf(j.type);
    if (!alloc[k]) continue; // 该类没额度（低分设备拿不到 book/content）
    const used = (usedByClass[k] || 0) + (pickCount[k] || 0);
    if (used >= alloc[k]) continue; // 该类 Lane 已满，留给别的类
    pickCount[k] = (pickCount[k] || 0) + 1;
    picked.push(j);
  }

  for (const j of picked) {
    if (j.dispatchedTo && j.dispatchedTo !== dev.id) releaseJob(j);
    j.dispatchedTo = dev.id;
    j.dispatchedAt = now;
    j.attempts = (Number(j.attempts) || 0) + 1;
    // 传输建模：本次派发的执行预算 = min(等待方口径剩多少, 按该设备该类实测放宽后的超时)
    const model = weights.timeoutFor(j.type, dev);
    const budget = Math.max(1000, (Number(j.waitMs) || WAIT_MS) - 500);
    j.timeoutMs = Math.min(budget, Math.max(1000, model));
    if (!j.lockedBy || j.lockedBy !== dev.id) dev.inflight = (dev.inflight || 0) + 1;
    j.lockedBy = dev.id;
  }

  return picked.map((j) => ({
    id: j.id,
    type: j.type,
    taskClass: j.taskClass,
    payload: j.payload,
    age: now - j.createdAt,
    timeoutMs: j.timeoutMs,
    serverTime: now,
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
  if (dev) {
    weights.updateScore(dev, !!ok, ms);
    // 按类感知：成功率 EWMA + 平均耗时，供下次派发的超时建模使用
    weights.updateClassStat(dev, job.taskClass, !!ok, ms);
  }
  releaseJob(job);
  if (ok && dev) {
    dev.handled = (dev.handled || 0) + 1;
    const bucket = /toc/i.test(job.type) ? 'toc'
      : /search/i.test(job.type) ? 'search'
        : /content|chapter/i.test(job.type) ? 'content'
          : 'other';
    dev.counts = dev.counts || { toc: 0, search: 0, content: 0, other: 0 };
    dev.counts[bucket] = (dev.counts[bucket] || 0) + 1;
    dev.lastResultAt = Date.now();
  }

  try {
    recent.push({
      at: Date.now(),
      type: job.type,
      cls: job.taskClass,
      ok: !!ok,
      ms: ms,
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

/** 调试快照：保留 score / caps / classes / inflight，仅供 /api/bus/debug 使用（带令牌） */
function debugSnapshot() {
  purge();
  const now = Date.now();
  return [...devices.values()].map((d) => ({
    id: d.id,
    name: d.name,
    model: d.model,
    version: d.version,
    online: now - d.lastSeen < ONLINE_MS,
    idle: Math.round((now - d.lastSeen) / 1000),
    enabled: d.enabled !== false,
    debug: !!d.debug,
    score: Number(d.score) || 0,
    caps: d.caps || {},
    classes: d.classes || {},
    inflight: Number(d.inflight) || 0,
    handled: Number(d.handled) || 0,
    counts: d.counts || { toc: 0, search: 0, content: 0, other: 0 },
    lastSeen: d.lastSeen,
  }));
}

function stats() {
  purge();
  // 按类的积压与在途（观测用，不影响派发）
  const queue = { book: 0, content: 0, media: 0 };
  const inflightByClass = { book: 0, content: 0, media: 0 };
  for (const j of jobs.values()) {
    const k = j.taskClass || classOf(j.type);
    if (Object.prototype.hasOwnProperty.call(queue, k)) queue[k]++;
    if (j.dispatchedTo && Object.prototype.hasOwnProperty.call(inflightByClass, k)) inflightByClass[k]++;
  }
  return {
    pending: jobs.size,
    recent: recent.slice(-5),
    queue,
    inflight: inflightByClass,
    ...weights.summarize([...devices.values()], online),
  };
}

module.exports = {
  request, create, abandon, pending, complete, stats, hello, touch, bumpHandled, debugSnapshot,
  listDevices, setEnabled, isDebugDevice, classOf,
};
