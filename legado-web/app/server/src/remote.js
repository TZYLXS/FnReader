'use strict';
// 手机端解析桥：服务端跑不了的书源（需要 WebView / 加密接口）交给 App 解析
//   网页 → POST /api/remote/job       建任务并等待结果
//   App  → GET  /api/m/remote/pending  领任务（长轮询）
//   App  → POST /api/m/remote/result   回结果
const crypto = require('node:crypto');

const jobs = new Map(); // id -> { id, type, payload, createdAt, resolve, timer }
const WAIT_MS = 20000;
const MAX_AGE = 120000;

function purge() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > MAX_AGE) {
      if (job.resolve) job.resolve({ ok: false, error: 'timeout' });
      jobs.delete(id);
    }
  }
}

/** 创建任务并等待手机回传；超时返回 {ok:false,error:'timeout'} */
function request(type, payload, waitMs = WAIT_MS) {
  purge();
  const id = crypto.randomBytes(6).toString('hex');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (jobs.has(id)) jobs.delete(id);
      resolve({ ok: false, error: 'timeout' });
    }, waitMs);
    jobs.set(id, { id, type, payload, createdAt: Date.now(), resolve, timer });
  });
}

/** 手机领任务：把当前待处理的任务吐出去（不删，等回结果） */
function pending(limit = 5) {
  purge();
  return [...jobs.values()].slice(0, limit).map((j) => ({
    id: j.id,
    type: j.type,
    payload: j.payload,
    age: Date.now() - j.createdAt,
  }));
}

function complete(id, ok, data, error) {
  const job = jobs.get(id);
  if (!job) return false;
  clearTimeout(job.timer);
  jobs.delete(id);
  job.resolve(ok ? { ok: true, data } : { ok: false, error: error || 'failed' });
  return true;
}

function stats() {
  purge();
  return { pending: jobs.size };
}

module.exports = { request, pending, complete, stats };
