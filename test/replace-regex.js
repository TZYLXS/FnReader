'use strict';
// 正文净化规则：##正则##替换 / ##正则（只取匹配）/ ###正则##替换（只替首个）
const _fs = require('node:fs');
const _path = require('node:path');
const _root = _path.resolve(__dirname, '..');
const APP_DIR = ['legado-web', 'fnos-legado'].find((d) => _fs.existsSync(_path.join(_root, d))) || 'legado-web';
const { applyReplaceRules } = require('../' + APP_DIR + '/app/server/src/books');

let ok = 0;
let fail = 0;
const check = (label, got, want) => {
  if (got === want) {
    ok++;
    console.log('  ✓', label, '→', JSON.stringify(got));
  } else {
    fail++;
    console.log('  ✗', label, '期望', JSON.stringify(want), '实际', JSON.stringify(got));
  }
};

check('##替换（全局）', applyReplaceRules('广告AAA正文AAA', '##AAA##'), '广告正文');
check('只取匹配（无捕获组）', applyReplaceRules('第1章 标题', '##第.章 '), '第1章 ');
check('###只替首个', applyReplaceRules('aa-bb-cc', '###-##_'), 'aa_bb-cc');
check('##只取匹配（捕获组）', applyReplaceRules('【正文】剩余说明', '##【(.+?)】'), '正文');
check('非法正则原样返回', applyReplaceRules('原样', '##([##'), '原样');
check('空规则不改动', applyReplaceRules('原样', ''), '原样');
check('替换无匹配保持原样', applyReplaceRules('abc', '##xy##z'), 'abc');
check('提取无匹配返回空串', applyReplaceRules('abc', '##xy'), '');

console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
