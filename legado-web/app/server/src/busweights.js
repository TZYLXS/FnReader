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

// ---- 能力上报（对应软总线「发现报文携带能力映射表」）----
// 客户端在 hello 里报 cores / memMb / maxInflight / supports，服务端据此给初值分与额度，
// 不再让所有新设备一律从 50 分开始「盲配」。
const CAP_SCORE_MIN = 40;
const CAP_SCORE_MAX = 78;

// ---- 按任务类建模的超时（对应软总线「按业务传输建模」）----
// 基线是「典型书源一次解析要多久」，实测均值偏慢时按 3 倍均值放宽，但不超过基线的 1.5 倍。
const TIMEOUT_MODEL = { book: 20000, content: 25000, media: 8000, ebook: 30000 };
const TIMEOUT_MAX_FACTOR = 1.5;
const TIMEOUT_MIN_MS = 3000;
const TYPE_TIMEOUT_KEY = {
  search: 'book',
  toc: 'book',
  rank: 'book',
  'ebook-parse': 'ebook',
  'ebook-chapter': 'content',
  content: 'content',
  bookinfo: 'media',
  cover: 'media',
  intro: 'media',
};

// ---- 按类额度（对应软总线「Lane 资源池」）----
// 高分设备把额度切成 book/content/media 三段，慢任务（content）不再挤占快任务（toc）的槽；
// 低分设备额度全部给 media。总数仍受设备实际上报的并发上限约束。
const MEDIA_INFLIGHT_SOFT = 2; // 低分设备 media 软上限
const PER_CLASS_CAP = { book: 2, content: 1, media: 1 }; // 高分设备各类软上限

// ---- 饥饿保护（对应软总线「调度与均衡」）----
const AGING_AFTER_MS = 30000; // 排队超过 30 秒的任务优先级前移
const AGING_STEP = 3; // 每超一个 30 秒窗口，优先级前移的档数

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

/** 能力上报规整：字段缺失一律返回 null，不猜 */
function normalizeCaps(info = {}) {
  return safe(
    () => {
      const raw = info.caps && typeof info.caps === 'object' ? info.caps : info;
      const cores = Number(raw.cores);
      const memMb = Number(raw.memMb || raw.mem);
      const maxInflight = Number(raw.maxInflight || raw.concurrency);
      const supports = Array.isArray(raw.supports)
        ? raw.supports.map((x) => String(x)).filter(Boolean).slice(0, 16)
        : [];
      if (!Number.isFinite(cores) && !Number.isFinite(memMb) && !Number.isFinite(maxInflight) && !supports.length) {
        return null;
      }
      return {
        cores: Number.isFinite(cores) ? Math.max(1, Math.min(32, Math.round(cores))) : 0,
        memMb: Number.isFinite(memMb) ? Math.max(0, Math.min(32768, Math.round(memMb))) : 0,
        maxInflight: Number.isFinite(maxInflight) ? Math.max(1, Math.min(6, Math.round(maxInflight))) : 0,
        supports,
      };
    },
    null
  );
}

/**
 * 能力分：把「几核/多大内存/上报并发/是否支持正文类任务」折算成 40–78 的初值分。
 * 这不是性能实测，只是让新设备一开始就落在合理档位；实测（成功/失败/耗时）仍会继续修正它。
 */
function capabilityScore(caps) {
  return safe(
    () => {
      if (!caps) return DEFAULT_SCORE;
      let score = 40;
      const cores = Number(caps.cores) || 0;
      if (cores >= 8) score += 16;
      else if (cores >= 6) score += 12;
      else if (cores >= 4) score += 6;
      const mem = Number(caps.memMb) || 0;
      if (mem >= 6000) score += 8;
      else if (mem >= 3000) score += 5;
      else if (mem > 0 && mem < 2000) score -= 6;
      const inflight = Number(caps.maxInflight) || 0;
      if (inflight >= 4) score += 6;
      else if (inflight >= 3) score += 3;
      if (Array.isArray(caps.supports) && caps.supports.includes('content')) score += 8;
      return Math.max(CAP_SCORE_MIN, Math.min(CAP_SCORE_MAX, score));
    },
    DEFAULT_SCORE
  );
}

/** 新设备初始化（保留历史分数/统计；首次报到时用能力上报决定初值分，不再一律 50） */
function newDevice(prev, info = {}) {
  return safe(
    () => {
      const p = prev || {};
      const caps = normalizeCaps(info) || p.caps || null;
      return {
        score: Number.isFinite(p.score) ? clampScore(p.score) : capabilityScore(caps),
        ok: Number(p.ok) || 0,
        fail: Number(p.fail) || 0,
        totalMs: Number(p.totalMs) || 0,
        samples: Number(p.samples) || 0,
        inflight: Number(p.inflight) || 0,
        caps,
        // 按任务类维护：成功率 EWMA + 平均耗时，用于「按类感知」与超时建模
        classes: p.classes && typeof p.classes === 'object' ? p.classes : {},
      };
    },
    () => ({ score: DEFAULT_SCORE, ok: 0, fail: 0, totalMs: 0, samples: 0, inflight: 0, caps: null, classes: {} })
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

const EWMA_ALPHA = 0.3; // 成功率 EWMA 权重：新样本占 30%，避免单次失败把设备永久打低

/**
 * 按任务类更新设备感知数据（对应软总线「感知 & 计算」：先分类再评估，而不是只看总耗时）
 * cls: book / content / media；ok: 是否成功；ms: 该任务从创建到回传的耗时。
 */
function updateClassStat(dev, cls, ok, ms) {
  safe(() => {
    if (!dev || !cls) return;
    if (!dev.classes || typeof dev.classes !== 'object') dev.classes = {};
    const st = dev.classes[cls] || { samples: 0, okRate: 0.5, avgMs: 0, timeout: 0, fail: 0 };
    const m = Math.max(0, Number(ms) || 0);
    const success = ok ? 1 : 0;
    st.okRate = st.samples ? st.okRate * (1 - EWMA_ALPHA) + success * EWMA_ALPHA : success;
    st.avgMs = st.samples ? Math.round(st.avgMs * (1 - EWMA_ALPHA) + m * EWMA_ALPHA) : Math.round(m);
    st.samples = (Number(st.samples) || 0) + 1;
    if (!ok) st.fail = (Number(st.fail) || 0) + 1;
    dev.classes[cls] = st;
  }, undefined);
}

/** 任务类型的超时基线 */
function timeoutOfType(type) {
  return safe(() => TIMEOUT_MODEL[TYPE_TIMEOUT_KEY[String(type)] || 'content'] || TIMEOUT_MODEL.content, TIMEOUT_MODEL.content);
}

/**
 * 按类建模的实际超时：基线 → 实测均值偏慢时放宽（≤1.5 倍基线）→ 不短于 3 秒。
 * 服务端等待时长与下发给客户端的执行预算都取这个值，两边口径一致。
 */
function timeoutFor(type, dev) {
  return safe(
    () => {
      const base = timeoutOfType(type);
      const cls = classOf(type);
      const st = dev && dev.classes ? dev.classes[cls] : null;
      const avg = st && st.samples ? Number(st.avgMs) || 0 : 0;
      if (!avg) return base;
      const p90 = avg * 3;
      return Math.round(Math.min(base * TIMEOUT_MAX_FACTOR, Math.max(TIMEOUT_MIN_MS, p90)));
    },
    TIMEOUT_MODEL.content
  );
}

/** 设备并发总上限：优先用上报值，缺省回落到分数档位 */
function totalSlots(dev) {
  return safe(
    () => {
      const rep = dev && dev.caps ? Number(dev.caps.maxInflight) || 0 : 0;
      if (rep > 0) return Math.max(1, Math.min(6, Math.round(rep)));
      return isHigh(dev) ? HIGH_INFLIGHT : LOW_INFLIGHT;
    },
    LOW_INFLIGHT
  );
}

/**
 * 按类额度（Lane 切分）：
 *   每类先给一个「软上限」，总量仍由 totalSlots 另行把关（两者取小）。
 *   目的只是防止某一类（尤其 content 长任务）把全部槽位占满，把 toc/search 这类快任务饿死；
 *   不是给每类预留固定槽位，所以各类之和允许大于总数。
 *   高分：book 2 / content 1 / media 1；低分：book 2 / content 1 / media 2。
 * 返回 {book, content, media, total}，未获准的类为 0。
 */
function slotsByClass(dev, classes) {
  return safe(
    () => {
      const allowed = Array.isArray(classes) && classes.length ? classes : ALL_CLASSES;
      const total = totalSlots(dev);
      const high = isHigh(dev);
      const softCap = (cls) => {
        if (cls === 'media') return high ? PER_CLASS_CAP.media : MEDIA_INFLIGHT_SOFT;
        // book 类：高分设备 2 路并行，低分设备 1 路——参与但让高分设备优先多一点
        if (cls === 'book') return high ? PER_CLASS_CAP.book : 1;
        return high ? PER_CLASS_CAP.content : 1;
      };
      const alloc = { book: 0, content: 0, media: 0, total };
      for (const cls of ALL_CLASSES) {
        if (!allowed.includes(cls)) continue;
        alloc[cls] = Math.min(softCap(cls), total);
      }
      return alloc;
    },
    () => ({ book: 0, content: 0, media: 0, total: LOW_INFLIGHT })
  );
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
      // 不再让低分设备在高分设备在线时只能领 media：那会导致「所有 search/toc 都堆到一台机器」，
      // 而且低分设备永远拿不到 book 任务、分数永远涨不上来。改为都参与，只限制额度。
      return ALL_CLASSES.slice();
    },
    () => ALL_CLASSES.slice()
  );
}

function maxInflight(dev, taskClass) {
  return safe(
    () => {
      if (taskClass) {
        const alloc = slotsByClass(dev, ALL_CLASSES);
        const key = String(taskClass);
        return Object.prototype.hasOwnProperty.call(alloc, key) ? alloc[key] : 0;
      }
      return totalSlots(dev);
    },
    LOW_INFLIGHT
  );
}

/** 交互式 TOC 优先于批量搜索；低分设备仍只在可领类别内排序。
 *  排队超过 AGING_AFTER_MS 的任务按窗口前移，避免 toc/content 一直插队把媒体任务饿死。 */
function priorityOf(job, device, classes, now) {
  return safe(
    () => {
      if (!job) return 99;
      if (Array.isArray(classes) && classes.length === 1) return 0;
      const typeOrder = {
        toc: 0,
        content: 1,
        'ebook-chapter': 1,
        search: 2,
        rank: 2,
        'ebook-parse': 2,
        bookinfo: 3,
        cover: 3,
        intro: 3,
      };
      let p;
      if (Object.prototype.hasOwnProperty.call(typeOrder, job.type)) p = typeOrder[job.type];
      else {
        const order = ['book', 'content', 'media'];
        const i = order.indexOf(job.taskClass);
        p = i < 0 ? 99 : i;
      }
      const t = typeof now === 'number' ? now : Date.now();
      const age = t - (Number(job.createdAt) || t);
      if (age > AGING_AFTER_MS) {
        const windows = Math.floor(age / AGING_AFTER_MS);
        p = Math.max(0, p - windows * AGING_STEP);
      }
      return p;
    },
    99
  );
}

/** 排序：优先级（含饥饿老化）→ 任务创建时间（先来先做） */
function sortJobs(jobs, device, classes, now) {
  return safe(
    () =>
      (Array.isArray(jobs) ? jobs : []).slice().sort((a, b) => {
        const pa = priorityOf(a, device, classes, now);
        const pb = priorityOf(b, device, classes, now);
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
  TIMEOUT_MODEL,
  classOf,
  newDevice,
  updateScore,
  updateClassStat,
  timeoutOfType,
  timeoutFor,
  normalizeCaps,
  capabilityScore,
  totalSlots,
  slotsByClass,
  eligibleClasses,
  maxInflight,
  sortJobs,
  priorityOf,
  hasHighOnline,
  summarize,
  isHigh,
  safe,
};
