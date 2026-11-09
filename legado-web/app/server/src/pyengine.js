'use strict';
// Python 规则引擎桥：调用 legado_rule（外部进程），不可用时透明回退 Node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PY_DIR = [path.join(__dirname, 'python'), path.join(__dirname, '..', '..', 'python')].find((d) => fs.existsSync(path.join(d, 'legado_bridge.py'))) || path.join(__dirname, 'python');
const BRIDGE = path.join(PY_DIR, 'legado_bridge.py');

const CANDIDATES = [
  process.env.LEGADO_PYTHON,
  '/usr/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3.11',
  '/opt/python/bin/python3',
  'python3',
  'python',
].filter(Boolean);

let pythonBinCache = '';

/** 找到可用的 python 解释器（fnOS 上 PATH 里可能没有 python3） */
function pythonBin() {
  if (pythonBinCache) return pythonBinCache;
  for (const bin of CANDIDATES) {
    try {
      const r = require('node:child_process').spawnSync(bin, ['--version'], { timeout: 4000, encoding: 'utf8' });
      if (r.status === 0) {
        pythonBinCache = bin;
        return bin;
      }
    } catch {
      /* 试下一个 */
    }
  }
  pythonBinCache = CANDIDATES[0] || 'python3';
  return pythonBinCache;
}

let probeCache = { at: 0, value: null };

/** 探测 python + legado_rule 是否可用（缓存 60 秒） */
function probe(force = false) {
  if (!force && probeCache.value && Date.now() - probeCache.at < 60000) return Promise.resolve(probeCache.value);
  return new Promise((resolve) => {
    const code = [
      'import sys, json',
      'out = {"python": sys.version.split()[0]}',
      'try:',
      '    import legado_rule',
      '    out["engine"] = getattr(legado_rule, "__version__", "unknown")',
      '    out["ok"] = True',
      'except Exception as e:',
      '    out["ok"] = False',
      '    out["error"] = type(e).__name__ + ": " + str(e)[:200]',
      'print(json.dumps(out))',
    ].join('\n');
    const child = spawn(pythonBin(), ['-c', code], {
      cwd: PY_DIR,
      timeout: 8000,
      env: { ...process.env, PYTHONPATH: [PY_DIR, path.join(PY_DIR, 'vendor')].join(path.delimiter), PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      const v = { ok: false, error: '无法启动 python3: ' + e.message };
      probeCache = { at: Date.now(), value: v };
      resolve(v);
    });
    child.on('close', () => {
      let v;
      try {
        v = JSON.parse(out.trim().split('\n').pop());
      } catch {
        v = { ok: false, error: (err || out || '探测失败').trim().slice(0, 200) };
      }
      if (!v.ok && !v.error) v.error = 'legado_rule 未安装';
      probeCache = { at: Date.now(), value: v };
      resolve(v);
    });
  });
}

/** 调用桥接脚本：payload 走 stdin，结果走 stdout */
function call(action, payload, timeout = 40000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BRIDGE)) return reject(new Error('缺少 legado_bridge.py'));
    const child = spawn(pythonBin(), [BRIDGE, action], {
      cwd: PY_DIR,
      timeout,
      env: { ...process.env, PYTHONPATH: [PY_DIR, path.join(PY_DIR, 'vendor')].join(path.delimiter), PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const j = JSON.parse(line);
        if (j.error) return reject(new Error(j.error));
        return resolve(j);
      } catch {
        reject(new Error(code === 0 ? 'Python 返回不是 JSON: ' + line.slice(0, 120) : err.trim().slice(0, 200) || 'python 退出码 ' + code));
      }
    });
    child.stdin.end(JSON.stringify(payload || {}));
  });
}

module.exports = { probe, call, PY_DIR };
