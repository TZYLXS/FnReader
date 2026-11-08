'use strict';
// 书源规则语法测试：显式前缀 / && 拼接 / ## 净化 / 取值尾缀
const { makeDoc, evalString } = require('../fnos-legado/app/server/src/rules');

const html = `<div class="book">
  <h1 class="title">JS 权威指南</h1>
  <p class="author">David</p>
  <span class="price">价格：128.50元</span>
  <img class="cover" src="/c.jpg" />
</div>`;

const ctx = { doc: makeDoc(html), json: { data: { title: 'JSON 标题' } }, baseUrl: 'http://x' };

let ok = 0;
let fail = 0;
const check = (rule, want, label) => {
  let got;
  try {
    got = evalString(rule, ctx);
  } catch (e) {
    got = 'ERR:' + e.message;
  }
  if (got === want) {
    ok++;
    console.log('  ✓', label, '→', JSON.stringify(got));
  } else {
    fail++;
    console.log('  ✗', label, '期望', JSON.stringify(want), '实际', JSON.stringify(got));
  }
};

console.log('\n== 显式前缀');
check('@css:.title@text', 'JS 权威指南', '@css: 取文本');
check('@css:.cover@src', '/c.jpg', '@css: 取属性');
check('@xpath://h1/text()', 'JS 权威指南', '@xpath:');
check('@json:$.data.title', 'JSON 标题', '@json:');
check('@text:固定文本', '固定文本', '@text: 常量');

console.log('\n== 操作符');
check('@css:.price@text##[^0-9.]##', '128.50', '## 净化');
check('@css:.none@text || @css:.title@text', 'JS 权威指南', '|| 回退');
check('@css:.title@text && @text:（完整版）', 'JS 权威指南（完整版）', '&& 拼接常量');
check('(@css:.title@text || @text:默认) && @text: - && @css:.author@text', 'JS 权威指南 -David', '括号 + 拼接');

console.log('\n== 取值尾缀');
check('@css:.title@innerText', 'JS 权威指南', '@innerText');
check('@css:h1@length', '1', '@length');

console.log('\n== 兼容旧写法');
check('class.title@text', 'JS 权威指南', 'class. 前缀');
check('class.title@text || text.默认', 'JS 权威指南', 'text. 回退');

console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
