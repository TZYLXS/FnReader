'use strict';
// 软总线「权重系统」独立模块
// 只做纯计算：任务分类、设备隐藏性能分、可领任务类、在途上限、优先级排序、统计。
// 所有导出函数都做了容错包装：权重计算异常时返回安全默认值，绝不把异常抛回总线主流程。
//
// 设计目标：
//   1) 与 remote.js 的队列/传输解耦，避免权重计算拖慢或卡死主流程；
//   2) 纯函数、无 I/O、无递归，单次计算复杂度 O(设备数 + 任务数)；
//   3) 任何函数内部异常都降级为默认策略（高分优先 → 全员可用）。

const HIGH_SCORE = 55; // 达到该分数才有资格领「书籍/正文」
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const DEFAULT_SCORE = 50;
const HIGH_INFLIGHT = 3;
const LOW_INFLIGHT = 2;

const TASK_CLASS = {
  search: 'book',
  toc: 'book',
  rank: 'book',
  'ebook-parse': 'content',
  'ebook-chapter': 'content',
  content: 'content',
  bookinfo: 'media',
  cover: 'media',
  intro: 'media',
};

const ALL_CLASSES = ['book', 'content', 'media'];

/** 权重系统的统一容错包装：异常时用兜底值，不让异常穿透到总线 */
function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    console.error('[busweights] 权重计算异常，使用降级策略：' + (e && e.message ? e.message : e));
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function classOf(type) {
  return safe(() => TASK_CLASS[String(type)] || 'media', 'media');
}

function clampScore(v) {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(Number(v) || 0)));
}

/** 新设备初始化（保留历史分数/统计） */
function newDevice(prev, info = {}) {
  return safe(
    () => {
      const p = prev || {};
      return {
        score: Number.isFinite(p.score) ? clampScore(p.score) : DEFAULT_SCORE,
        ok: Number(p.ok) || 0,
        fail: Number(p.fail) || 0,
        totalMs: Number(p.totalMs) || 0,
        samples: Number(p.samples) || 0,
        inflight: Number(p.inflight) || 0,
      };
    },
    () => ({ score: DEFAULT_SCORE, ok: 0, fail: 0, totalMs: 0, samples: 0, inflight: 0 })
  );
}

/** 隐藏分：成功 +4，失败 -8，慢（>8s）额外扣分；限制在 0..100 */
function updateScore(dev, ok, ms) {
  safe(() => {
    if (!dev) return;
    dev.ok = (Number(dev.ok) || 0) + (ok ? 1 : 0);
    dev.fail = (Number(dev.fail) || 0) + (ok ? 0 : 1);
    dev.totalMs = (Number(dev.totalMs) || 0) + Math.max(0, Number(ms) || 0);
    dev.samples = (Number(dev.samples) || 0) + 1;
    let score = Number.isFinite(dev.score) ? dev.score : DEFAULT_SCORE;
    if (ok) {
      score += 4;
      if (Number(ms) > 8000) score -= 2;
    } else {
      score -= 8;
    }
    dev.score = clampScore(score);
    dev.lastResultAt = Date.now();
  }, undefined);
}

function isHigh(dev) {
  return safe(() => !!dev && (Number(dev.score) || 0) >= HIGH_SCORE, false);
}

/**
 * 设备可领的任务类：
 * - 调试设备：不限（便于调试）
 * - 高分设备：book / content / media
 * - 低分设备：media（封面、简介）
 * - 没有任何高分设备在线时，放开全部类，避免新部署没人领任务
 */
function eligibleClasses(dev, anyHighOnline) {
  return safe(
    () => {
      if (!dev) return [];
      if (dev.debug) return ALL_CLASSES.slice();
      if (!anyHighOnline) return ALL_CLASSES.slice();
      return isHigh(dev) ? ALL_CLASSES.slice() : ['media'];
    },
    () => ALL_CLASSES.slice()
  );
}

function maxInflight(dev) {
  return safe(() => (isHigh(dev) ? HIGH_INFLIGHT : LOW_INFLIGHT), LOW_INFLIGHT);
}

/** 高分设备先领书籍/正文，低分设备先领封面/简介 */
function priorityOf(job, device, classes) {
  return safe(
    () => {
      if (!job) return 99;
      if (device && device.debug) return 0;
      if (Array.isArray(classes) && classes.length === 1) return 0;
      const order = ['book', 'content', 'media'];
      const i = order.indexOf(job.taskClass);
      return i < 0 ? 99 : i;
    },
    99
  );
}

/** 排序：优先级 → 任务创建时间（先来先做） */
function sortJobs(jobs, device, classes) {
  return safe(
    () =>
      (Array.isArray(jobs) ? jobs : []).slice().sort((a, b) => {
        const pa = priorityOf(a, device, classes);
        const pb = priorityOf(b, device, classes);
        return pa - pb || (a.createdAt || 0) - (b.createdAt || 0);
      }),
    () => (Array.isArray(jobs) ? jobs.slice() : [])
  );
}

/** 在线设备里有没有高分设备（用于决定是否放开全部任务类） */
function hasHighOnline(devices) {
  return safe(
    () => (Array.isArray(devices) ? devices : []).some((d) => d && !d.debug && (Number(d.score) || 0) >= HIGH_SCORE),
    false
  );
}

/** 统计（用于 /api/bus 的 usage，不暴露具体分数） */
function summarize(devices, isOnline) {
  return safe(
    () => {
      const list = Array.isArray(devices) ? devices : [];
      let high = 0;
      let low = 0;
      for (const d of list) {
        if (!d) continue;
        if (typeof isOnline === 'function' && !isOnline(d)) continue;
        if ((Number(d.score) || 0) >= HIGH_SCORE) high++;
        else low++;
      }
      return { highScore: high, lowScore: low };
    },
    () => ({ highScore: 0, lowScore: 0 })
  );
}

module.exports = {
  HIGH_SCORE,
  TASK_CLASS,
  classOf,
  newDevice,
  updateScore,
  eligibleClasses,
  maxInflight,
  sortJobs,
  priorityOf,
  hasHighOnline,
  summarize,
  isHigh,
  safe,
};
