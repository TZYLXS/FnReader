const { makeDoc, evalRule } = require('../fnos-legado/app/server/src/rules');
const { evaluateXPath } = require('../fnos-legado/app/server/src/xpath');
const html = `<html><body><ul id="list"><li><a href="/c/1">第1章</a></li><li><a href="/c/2">第2章</a></li></ul></body></html>`;
const doc = makeDoc(html);
const n1 = evaluateXPath(doc.root, '//ul[@id="list"]/li');
console.log('nodes:', n1.length);
const n2 = evaluateXPath(doc.root, '//li');
console.log('li:', n2.length);
const ctx = { doc, json: null, baseUrl: 'http://x/', source: {}, book: {} };
const r = evalRule('//ul[@id="list"]/li', ctx);
console.log('rule nodes:', r.nodes.length, r.values);
if (r.nodes[0]) {
  console.log('name:', evalRule('.//a/text()', ctx, { scope: r.nodes[0] }).values);
  console.log('href:', evalRule('.//a/@href', ctx, { scope: r.nodes[0] }).values);
}
