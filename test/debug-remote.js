'use strict';
const assert = require('node:assert/strict');

const BASE = process.env.DEBUG_BASE;
assert.ok(BASE, '必须设置 DEBUG_BASE，例如 http://<服务器IP>:1123');
const origin = new URL(BASE);
assert.equal(origin.port, '1123', '禁止对生产端口执行测试');
const results = [];
function pass(name, detail = '') { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` ${detail}` : ''}`); }
async function request(path, options = {}) {
  const response = await fetch(new URL(path, BASE), { ...options, signal: AbortSignal.timeout(options.timeout || 30000) });
  const text = await response.text();
  assert.ok(response.ok, `${options.method || 'GET'} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { text, json };
}
(async () => {
  const { json: health } = await request('/api/health');
  assert.equal(health.app, 'legado-web-debug');
  assert.equal(health.version, '0.1.0');
  assert.equal(health.runtime?.node, 'v26.13.1');
  assert.match(health.runtime?.compileCache || '', /node-compile-cache/);
  assert.equal(health.python?.mode, 'persistent-pool');
  assert.equal(health.java?.running, true);
  pass('debug 0.1.0 / Node 26 / 内置运行时', `V8 ${health.runtime.v8}`);

  const { json: sourcePayload } = await request('/api/sources');
  const sources = sourcePayload.sources;
  assert.equal(sources.length, 1150);
  pass('书源完整恢复', `${sources.length} 条`);

  const { text: index } = await request('/');
  assert.match(index, /reader-gesture\.js/);
  const { text: appJs } = await request('/app.js');
  assert.match(appJs, /sw-java-engine/);
  assert.match(appJs, /Java 21 TOC/);
  pass('阅读页手势与 Java 设置资源已部署');

  const { json: engine } = await request('/api/engine');
  assert.equal(engine.python?.ok, true);
  assert.equal(engine.java?.ok, true);
  assert.equal(engine.java?.virtualThreads, true);
  assert.match(engine.java?.java || '', /^21\./);
  pass('Python 持久池与 Java 21 引擎健康', `virtualThreads=${engine.java.virtualThreads}`);

  const { json: original } = await request('/api/config');
  const originalEnabled = original.javaEngine !== false;
  try {
    await request('/api/engine', { method: 'POST', body: JSON.stringify({ javaEngine: false }) });
    const { json: off } = await request('/api/engine');
    assert.equal(off.javaEngine, false);
    assert.equal(off.java.enabled, false);
    pass('Java 设置关闭路径');

    await request('/api/engine', { method: 'POST', body: JSON.stringify({ javaEngine: true }) });
    const { json: on } = await request('/api/engine');
    assert.equal(on.javaEngine, true);
    assert.equal(on.java?.ok, true);
    assert.equal(on.java?.virtualThreads, true);
    pass('Java 设置重新开启路径');
  } finally {
    if (originalEnabled !== true) {
      await request('/api/engine', { method: 'POST', body: JSON.stringify({ javaEngine: originalEnabled }) }).catch(() => {});
    }
  }

  console.log(JSON.stringify({ base: BASE, passed: results.length, results }, null, 2));
  console.log('DEBUG_REMOTE_SMOKE_PASSED');
})().catch((error) => { console.error(error); process.exitCode = 1; });
