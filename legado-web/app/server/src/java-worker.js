'use strict';
// Java 21 本机 worker：只在显式 LEGADO_JAVA_WORKER=1 时启用。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const SOURCE = [path.join(__dirname, 'java', 'FnReaderJavaWorker.java'), path.join(__dirname, 'src', 'java', 'FnReaderJavaWorker.java')]
  .find((file) => fs.existsSync(file));
const CLASS_DIR = [path.join(__dirname, 'java'), path.join(__dirname, 'src', 'java')]
  .find((dir) => fs.existsSync(path.join(dir, 'FnReaderJavaWorker.class')));
const stats = { requests: 0, failures: 0, restarts: 0, lastMs: 0 };
let child = null;
let port = 0;
let starting = null;
let lastError = '';
let runtimeEnabled = process.env.LEGADO_JAVA_WORKER === '1';

function enabled() { return runtimeEnabled && process.env.LEGADO_JAVA_WORKER !== '0'; }
function setEnabled(value) {
  runtimeEnabled = value === true;
  if (!runtimeEnabled) close();
}
function javaBin() {
  // 1) 随包 jlink 运行时（可选）2) 环境变量 3) fnOS 的 JDK 应用 4) 系统 java
  const bundled = path.join(__dirname, 'runtime', 'java', 'bin', 'java');
  if (fs.existsSync(bundled)) return bundled;
  if (process.env.LEGADO_JAVA) return process.env.LEGADO_JAVA;
  const candidates = [
    '/var/apps/java-21-openjdk/target/bin/java',
    '/opt/java/bin/java',
    '/usr/local/bin/java',
    '/usr/bin/java',
  ];
  for (const bin of candidates) {
    try { if (fs.existsSync(bin)) return bin; } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'java' : 'java';
}

function start() {
  if (!enabled()) return Promise.reject(new Error('Java worker 未启用'));
  if (child && port) return Promise.resolve(port);
  if (starting) return starting;
  if (!SOURCE) return Promise.reject(new Error('缺少 FnReaderJavaWorker.java'));
  starting = new Promise((resolve, reject) => {
    const bin = javaBin();
    const args = CLASS_DIR ? ['-cp', CLASS_DIR, 'FnReaderJavaWorker'] : ['-Dfile.encoding=UTF-8', SOURCE];
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Java worker 启动超时(15s)'), true), 15000);
    function finish(error, kill) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        lastError = error.message;
        stats.failures++;
        if (child === proc) { child = null; port = 0; }
        if (kill) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
        starting = null;
        reject(error);
      } else {
        starting = null;
        resolve(port);
      }
    }
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      const match = stdout.match(/PORT=(\d+)/);
      if (match && child === proc) {
        port = Number(match[1]);
        lastError = '';
        finish(null, false);
      }
    });
    proc.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-4000); });
    proc.on('error', (error) => finish(new Error(`无法启动 ${bin}: ${error.message}`), false));
    proc.on('close', (code) => {
      if (child === proc) { child = null; port = 0; }
      stats.restarts++;
      finish(new Error(`Java worker 退出(${code})${stderr ? ': ' + stderr.slice(-300) : ''}`), false);
    });
  });
  return starting;
}

function request(route, body, timeout = 10000) {
  return start().then((targetPort) => new Promise((resolve, reject) => {
    const started = Date.now();
    stats.requests++;
    const req = http.request({
      hostname: '127.0.0.1', port: targetPort, path: route, method: body == null ? 'GET' : 'POST',
      headers: body == null ? {} : { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
      timeout,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        stats.lastMs = Date.now() - started;
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Java HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        resolve(text);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Java ${route} 超时(${timeout}ms)`)));
    req.on('error', (error) => { stats.failures++; lastError = error.message; reject(error); });
    if (body != null) req.write(body);
    req.end();
  }));
}

function encode(value) { return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64'); }
function decode(value) { return Buffer.from(value, 'base64').toString('utf8'); }

async function normalizeToc(chapters) {
  if (!enabled() || !Array.isArray(chapters)) return null;
  const body = chapters.map((chapter, index) => [
    encode(chapter && chapter.url), encode(chapter && chapter.title),
    Number.isFinite(Number(chapter && chapter.index)) ? Number(chapter.index) : index,
  ].join('\t')).join('\n') + '\n';
  const text = await request('/toc/normalize', body);
  return text.split('\n').filter(Boolean).map((line) => {
    const columns = line.split('\t');
    return { url: decode(columns[0]), title: decode(columns[1]), index: Number(columns[2]) };
  });
}

async function health() {
  if (!enabled()) return { enabled: false, ok: false, ...stats };
  try {
    const text = await request('/health', null, 5000);
    return { enabled: true, ...JSON.parse(text), port, ...stats, lastError };
  } catch (error) {
    return { enabled: true, ok: false, port: 0, ...stats, lastError: error.message };
  }
}

function close() {
  if (child) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
  child = null;
  port = 0;
  starting = null;
}

function status() {
  return { enabled: enabled(), running: !!(child && port), port, ...stats, lastError };
}

module.exports = { start, normalizeToc, health, status, setEnabled, close, stats };
