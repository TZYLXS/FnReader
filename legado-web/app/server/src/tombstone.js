'use strict';
// 删除墓碑：记录被删掉的书，防止客户端同步又把它们推回来
const fs = require('node:fs');
const path = require('node:path');

let file = '';
let list = [];

function init(dataDir) {
  file = path.join(dataDir, 'deleted.json');
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

/** 记一条删除（同 URL 覆盖时间） */
function add(bookUrl, name) {
  if (!bookUrl) return;
  const at = Date.now();
  list = list.filter((x) => x.bookUrl !== bookUrl);
  list.push({ bookUrl, name: name || '', at });
  if (list.length > 2000) list = list.slice(-2000);
  persist();
}

/** 是否被删过；传入时间戳时，比删除时间新则视为「用户重新加」 */
function tombstoneOf(bookUrl, at) {
  const hit = list.find((x) => x.bookUrl === bookUrl);
  if (!hit) return null;
  const t = Number(at) || 0;
  if (t > hit.at) return null; // 客户端时间更新，允许重加
  return hit;
}

function remove(bookUrl) {
  const before = list.length;
  list = list.filter((x) => x.bookUrl !== bookUrl);
  if (list.length !== before) persist();
}

function all() {
  return list.slice();
}

module.exports = { init, add, remove, tombstoneOf, all };
