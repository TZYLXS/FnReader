'use strict';
// 复杂书源解析池：把同步 JS / java.ajax 阻塞隔离到 worker_threads，主事件循环继续响应请求。
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_FILE = path.join(__dirname, 'parse-worker.js');
const METHODS = new Set(['searchSource', 'getBookInfo', 'getToc', 'getContent']);
const configured = Number(process.env.LEGADO_PARSE_WORKERS);
const WORKER_COUNT = Number.isFinite(configured) && configured >= 0
  ? Math.min(8, Math.floor(configured))
  : Math.min(4, Math.max(2, (os.cpus().length || 2) - 1));

function shouldOffload(source) {
  if (WORKER_COUNT === 0 || !source) return false;
  try {
    return /<js\b|<\/js>|@js:|java\s*\./i.test(JSON.stringify(source));
  } catch {
    return false;
  }
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

class ParsePool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.sequence = 0;
    this.completed = 0;
    this.failed = 0;
    this.closed = false;
    for (let i = 0; i < size; i++) this.addWorker();
  }

  addWorker() {
    const slot = { worker: null, current: null, error: null };
    const worker = new Worker(WORKER_FILE);
    slot.worker = worker;
    this.workers.push(slot);
    worker.on('message', (msg) => {
      const task = slot.current;
      if (!task || !msg || msg.id !== task.id) return;
      slot.current = null;
      if (msg.ok) {
        this.completed++;
        task.resolve(msg.value);
      } else {
        this.failed++;
        const error = new Error(msg.error && msg.error.message ? msg.error.message : '解析 worker 执行失败');
        if (msg.error && msg.error.stack) error.stack = msg.error.stack;
        task.reject(error);
      }
      this.pump();
    });
    worker.on('error', (error) => {
      slot.error = error;
    });
    worker.on('exit', (code) => {
      const index = this.workers.indexOf(slot);
      if (index >= 0) this.workers.splice(index, 1);
      const task = slot.current;
      slot.current = null;
      if (task) {
        this.failed++;
        task.reject(slot.error || new Error(`解析 worker 异常退出（code ${code}）`));
      }
      if (!this.closed) {
        try {
          this.addWorker();
        } catch (e) {
          console.error('[parsepool] worker 重建失败：' + (e.message || e));
        }
      }
      this.pump();
    });
    // 服务自身监听端口时保持运行；单独跑测试时 worker 不阻止进程退出。
    worker.unref();
  }

  run(method, args) {
    if (!METHODS.has(method)) return Promise.reject(new Error('不支持的解析方法: ' + method));
    let payload;
    try {
      payload = jsonClone(args);
    } catch (e) {
      return Promise.reject(new Error('解析参数无法序列化：' + (e.message || e)));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, method, args: payload, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.closed) return;
    for (const slot of this.workers) {
      if (slot.current || !this.queue.length) continue;
      const task = this.queue.shift();
      slot.current = task;
      try {
        slot.worker.postMessage({ id: task.id, method: task.method, args: task.args });
      } catch (e) {
        slot.current = null;
        this.failed++;
        task.reject(e);
      }
    }
  }

  stats() {
    return {
      workers: this.workers.length,
      busy: this.workers.filter((s) => !!s.current).length,
      queued: this.queue.length,
      completed: this.completed,
      failed: this.failed,
    };
  }

  close() {
    this.closed = true;
    for (const slot of this.workers) slot.worker.terminate();
    this.workers = [];
    const pending = this.queue.splice(0);
    for (const task of pending) task.reject(new Error('解析池已关闭'));
  }
}

let pool = null;
function getPool() {
  if (WORKER_COUNT === 0) throw new Error('解析 worker 池已禁用');
  if (!pool) pool = new ParsePool(WORKER_COUNT);
  return pool;
}

module.exports = {
  shouldOffload,
  run: (method, args) => getPool().run(method, args),
  stats: () => (pool ? pool.stats() : { workers: 0, busy: 0, queued: 0, completed: 0, failed: 0 }),
  workerCount: WORKER_COUNT,
};
