'use strict';
// Python 规则引擎桥：持久进程池执行解析，失败时由调用方透明回退 Node。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const PY_DIR = [
  path.join(__dirname, 'python'),
  path.join(__dirname, '..', 'python'),
  path.join(__dirname, '..', '..', 'python'),
].find((d) => fs.existsSync(path.join(d, 'legado_bridge.py'))) || path.join(__dirname, 'python');
const BRIDGE = path.join(PY_DIR, 'legado_bridge.py');
const CANDIDATES = [
  'python3.9',
  process.env.LEGADO_PYTHON,
  path.join(__dirname, 'runtime', 'python', 'bin', 'python3'),
  '/usr/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3.11', '/opt/python/bin/python3',
  'python3', 'python',
].filter(Boolean);
let pythonBinCache = '';

function pythonBin() {
  if (pythonBinCache) return pythonBinCache;
  for (const bin of CANDIDATES) {
    try {
      const r = require('node:child_process').spawnSync(bin, ['--version'], { timeout: 4000, encoding: 'utf8' });
      if (r.status === 0) {
        pythonBinCache = bin;
        return bin;
      }
    } catch { /* 试下一个 */ }
  }
  pythonBinCache = CANDIDATES[0] || 'python3';
  return pythonBinCache;
}

function pythonEnv() {
  // LEGADO_PYTHONPATH 只用于开发机加载与系统架构匹配的依赖；FPK 默认仍用随包 vendor。
  const paths = [process.env.LEGADO_PYTHONPATH, PY_DIR, path.join(PY_DIR, 'vendor'), process.env.PYTHONPATH]
    .filter(Boolean).join(path.delimiter);
  return { ...process.env, PYTHONPATH: paths, PYTHONIOENCODING: 'utf-8' };
}

let probeCache = { at: 0, value: null };
function probe(force = false) {
  if (!force && probeCache.value && Date.now() - probeCache.at < 60000) return Promise.resolve(probeCache.value);
  return new Promise((resolve) => {
    const code = [
      'import sys, json', 'out = {"python": sys.version.split()[0]}', 'try:',
      '    import legado_rule', '    out["engine"] = getattr(legado_rule, "__version__", "unknown")',
      '    out["ok"] = True', 'except Exception as e:', '    out["ok"] = False',
      '    out["error"] = type(e).__name__ + ": " + str(e)[:200]', 'print(json.dumps(out))',
    ].join('\n');
    const child = spawn(pythonBin(), ['-c', code], { cwd: PY_DIR, timeout: 8000, env: pythonEnv() });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      const value = { ok: false, error: '无法启动 python3: ' + e.message };
      probeCache = { at: Date.now(), value };
      resolve(value);
    });
    child.on('close', () => {
      let value;
      try { value = JSON.parse(out.trim().split('\n').pop()); } catch {
        value = { ok: false, error: (err || out || '探测失败').trim().slice(0, 200) };
      }
      if (!value.ok && !value.error) value.error = 'legado_rule 未安装';
      probeCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

/** 单次模式仅供显式禁用进程池时使用；正常解析走持久 worker。 */
function callOnce(action, payload, timeout = 40000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BRIDGE)) return reject(new Error('缺少 legado_bridge.py'));
    const child = spawn(pythonBin(), [BRIDGE, action], { cwd: PY_DIR, timeout, env: pythonEnv() });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const data = JSON.parse(line);
        if (data.error) return reject(new Error(data.error));
        return resolve(data);
      } catch {
        reject(new Error(code === 0 ? 'Python 返回不是 JSON: ' + line.slice(0, 120) : err.trim().slice(0, 200) || 'python 退出码 ' + code));
      }
    });
    child.stdin.end(JSON.stringify(payload || {}));
  });
}

const workers = [];
const stats = { calls: 0, timeouts: 0, restarts: 0, responses: 0 };
let sequence = 0;
let closing = false;

function poolSize() {
  const raw = process.env.LEGADO_PYTHON_WORKERS;
  if (raw === '0') return 0;
  const explicit = Number(raw);
  if (explicit > 0) return Math.max(1, Math.min(16, explicit));
  // 多核优化：默认按 CPU 核数开池（留 1 核给 Node），2~16 之间
  const cores = (os.cpus && os.cpus().length) || 2;
  return Math.max(2, Math.min(16, cores - 1));
}

function failWorker(worker, error, kill) {
  if (worker.failed) return;
  worker.failed = true;
  const index = workers.indexOf(worker);
  if (index >= 0) workers.splice(index, 1);
  for (const pending of worker.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  worker.pending.clear();
  if (kill) killTree(worker.child);
  if (!closing) stats.restarts++;
}

function createWorker() {
  const child = spawn(pythonBin(), [BRIDGE, '--worker'], { cwd: PY_DIR, env: pythonEnv() });
  const worker = { child, pending: new Map(), failed: false, stderr: '' };
  workers.push(worker);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let data;
    try { data = JSON.parse(line); } catch { return; }
    const pending = worker.pending.get(data.id);
    if (!pending) return;
    worker.pending.delete(data.id);
    clearTimeout(pending.timer);
    stats.responses++;
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve(data);
  });
  child.stderr.on('data', (d) => { worker.stderr = (worker.stderr + d.toString()).slice(-4000); });
  child.on('error', (e) => failWorker(worker, e, false));
  // worker 已退出时再写 stdin 会 EPIPE，这里吞掉并标记 worker 失效，避免 uncaughtException
  child.stdin.on('error', () => failWorker(worker, new Error('Python worker stdin 断开'), false));
  child.on('close', (code) => {
    lines.close();
    failWorker(worker, new Error(`Python worker 退出(${code})${worker.stderr ? ': ' + worker.stderr.slice(-200) : ''}`), false);
  });
  return worker;
}

function ensurePool() {
  const size = poolSize();
  if (!size || closing) return;
  while (workers.length < size) createWorker();
}

function call(action, payload, timeout = 40000) {
  if (!poolSize()) return callOnce(action, payload, timeout);
  if (!fs.existsSync(BRIDGE)) return Promise.reject(new Error('缺少 legado_bridge.py'));
  ensurePool();
  if (!workers.length) return callOnce(action, payload, timeout);
  const worker = workers.reduce((best, item) => item.pending.size < best.pending.size ? item : best, workers[0]);
  const id = ++sequence;
  stats.calls++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stats.timeouts++;
      failWorker(worker, new Error(`Python ${action} 超时(${timeout}ms)`), true);
    }, timeout);
    if (timer.unref) timer.unref();
    worker.pending.set(id, { resolve, reject, timer });
    try {
      worker.child.stdin.write(JSON.stringify({ id, action, payload: payload || {} }) + '\n');
    } catch (e) {
      failWorker(worker, e, true);
    }
  });
}

function poolStats() {
  return {
    mode: poolSize() ? 'persistent-pool' : 'single-call', configured: poolSize(), workers: workers.length,
    queued: workers.reduce((sum, worker) => sum + worker.pending.size, 0), ...stats,
  };
}

function closePool() {
  closing = true;
  for (const worker of [...workers]) failWorker(worker, new Error('Python worker 池正在关闭'), true);
  closing = false;
}

/** 后台启动一次桥接调用（TXT 等大文件仍用独立进程，支持整组强杀）。 */
function start(action, payload, opts = {}) {
  if (!fs.existsSync(BRIDGE)) return { child: null, promise: Promise.resolve({ ok: false, error: '缺少 legado_bridge.py' }) };
  const child = spawn(pythonBin(), [BRIDGE, action], {
    cwd: PY_DIR, detached: true, env: pythonEnv(),
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  try { child.stdin.end(JSON.stringify(payload || {})); } catch { /* ignore */ }
  const promise = new Promise((resolve) => {
    child.on('close', (code) => {
      let data = null;
      try { data = out ? JSON.parse(out) : null; } catch { data = null; }
      resolve({ ok: code === 0 && data && !data.error, code, data, stdout: out, stderr: err });
    });
    child.on('error', (e) => resolve({ ok: false, code: -1, error: e.message, stdout: out, stderr: err }));
  });
  return { child, promise };
}

function killTree(child) {
  if (!child) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* 退回单进程杀 */ }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

module.exports = { probe, call, start, killTree, PY_DIR, poolStats, closePool, pythonEnv };
