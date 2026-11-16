'use strict';
// 手机端解析桥：服务端跑不了的书源（需要 WebView / 加密接口）交给 App 解析
//   网页 → POST /api/remote/job       建任务并等待结果
//   App  → GET  /api/m/remote/pending  领任务（长轮询）
//   App  → POST /api/m/remote/result   回结果
const crypto = require('node:crypto');

const jobs = new Map(); // id -> { id, type, payload, createdAt, resolve, timer }
const devices = new Map(); // id -> { id, name, model, version, lastSeen, handled, enabled }

const ONLINE_MS = 60000; // 60 秒内有心跳算在线

/** App 报到 / 心跳 */
function hello(info = {}) {
  const id = String(info.id || info.deviceId || '').trim() || 'unknown';
  const prev = devices.get(id) || { handled: 0, enabled: true };
  const dev = {
    id,
    name: String(info.name || prev.name || '未命名设备'),
    model: String(info.model || prev.model || ''),
    version: String(info.version || prev.version || ''),
    lastSeen: Date.now(),
    handled: prev.handled || 0,
    enabled: prev.enabled !== false,
    debug: isDebugDevice(id, info.name || prev.name),
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
const WAIT_MS = 20000;

/** 调试设备：ID 含 bus-debug/debug，或名称含“调试” */
function isDebugDevice(id, name) {
  const text = String(id || '') + ' ' + String(name || '');
  return /(bus[-_]?debug|\bdebug\b)/i.test(text) || /调试/.test(text);
}
const MAX_AGE = 120000;

function purge() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const expireAt = job.expireAt || job.createdAt + MAX_AGE;
    if (now > expireAt) {
      if (job.resolve) job.resolve({ ok: false, error: 'timeout' });
      jobs.delete(id);
    }
  }
}

/**
 * 建任务并返回 {id, promise}；ebook-parse 这类长任务用 ttlMs 单独放宽存活时间
 * @param {string} type
 * @param {object} payload
 * @param {{waitMs?:number, ttlMs?:number}} opts
 */
function create(type, payload, opts = {}) {
  purge();
  const waitMs = Number(opts.waitMs) || WAIT_MS;
  const ttlMs = Number(opts.ttlMs) || Math.max(waitMs, MAX_AGE);
  const id = crypto.randomBytes(6).toString('hex');
  const createdAt = Date.now();
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (jobs.has(id)) jobs.delete(id);
      resolve({ ok: false, error: 'timeout' });
    }, waitMs);
    jobs.set(id, {
      id, type, payload, createdAt, expireAt: createdAt + ttlMs, resolve, timer,
      debug: !!(payload && payload.debug === true),
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
  clearTimeout(job.timer);
  jobs.delete(id);
  if (job.resolve) job.resolve({ ok: false, error: 'abandoned' });
  return true;
}

/** 手机领任务：把当前待处理的任务吐出去（不删，等回结果） */
function pending(limit = 5, deviceId = '') {
  purge();
  const dev = devices.get(String(deviceId || ''));
  const debugDevice = !!(dev && dev.debug) || isDebugDevice(deviceId, '');
  const list = [...jobs.values()].filter((j) => (debugDevice ? j.debug : !j.debug));
  return list.slice(0, limit).map((j) => ({
    id: j.id,
    type: j.type,
    payload: j.payload,
    age: Date.now() - j.createdAt,
  }));
}

function complete(id, ok, data, error, deviceId = '') {
  const dev = devices.get(String(deviceId || ''));
  if ((dev && dev.debug) || isDebugDevice(deviceId, '')) {
    // 调试设备的回传一律丢弃：不 resolve、不写 recent，任务等真正设备或超时
    console.log('[softbus] 忽略调试设备回传 device=' + deviceId + ' job=' + id);
    return 'ignored';
  }
  const job = jobs.get(id);
  if (!job) return false;
  try {
    recent.push({
      at: Date.now(),
      type: job.type,
      ok: !!ok,
      keys: data && typeof data === 'object' ? Object.keys(data) : [],
      sample: JSON.stringify(data || error || '').slice(0, 300),
    });
    if (recent.length > 20) recent.shift();
  } catch {
    /* ignore */
  }
  clearTimeout(job.timer);
  jobs.delete(id);
  job.resolve(ok ? { ok: true, data } : { ok: false, error: error || 'failed' });
  return true;
}

const recent = []; // 最近的回传，排查用

function stats() {
  purge();
  return { pending: jobs.size, recent: recent.slice(-5) };
}

module.exports = { request, create, abandon, pending, complete, stats, hello, touch, bumpHandled, listDevices, setEnabled, isDebugDevice };
