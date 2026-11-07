'use strict';
// 极简事件总线：/api/events 用 SSE 推给网页端，实现「App 回传进度后网页立即刷新」
const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify({ ...event, at: Date.now() })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function count() {
  return clients.size;
}

module.exports = { addClient, broadcast, count };
