'use strict';
// parsepool.js 的 worker 入口；每次只处理主线程分配的一项任务。
const { parentPort } = require('node:worker_threads');
const books = require('./books');
const methods = {
  searchSource: books.searchSource,
  getBookInfo: books.getBookInfo,
  getToc: books.getToc,
  getContent: books.getContent,
};

parentPort.on('message', async ({ id, method, args }) => {
  try {
    if (!methods[method]) throw new Error('未知解析方法: ' + method);
    const value = await methods[method](...args);
    parentPort.postMessage({ id, ok: true, value });
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: { message: String(e && e.message ? e.message : e), stack: e && e.stack ? String(e.stack) : '' },
    });
  }
});
