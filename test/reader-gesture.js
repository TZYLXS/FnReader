'use strict';
const assert = require('node:assert/strict');
const gestures = require('../legado-web/app/web/reader-gesture');
let ok = 0;
function check(name, actual, expected) {
  assert.equal(actual, expected, name);
  ok++;
  console.log('  ✓', name);
}
const rect = { left: 0, width: 400 };
const start = (x, y = 200, pointerType = 'touch') => ({ x, y, at: 1000, pointerType });
const end = (x, y = 200) => ({ x, y });
console.log('== 阅读页手势');
check('左滑下一章', gestures.resolveGesture(start(300), end(180), rect, 1400), 1);
check('右滑上一章', gestures.resolveGesture(start(100), end(230), rect, 1400), -1);
check('纵向滚动不翻页', gestures.resolveGesture(start(200, 100), end(60, 300), rect, 1400), 0);
check('短横滑不误触', gestures.resolveGesture(start(200), end(155), rect, 1400), 0);
check('超慢滑动不翻页', gestures.resolveGesture(start(300), end(100), rect, 2600), 0);
check('右侧触摸热区下一章', gestures.resolveGesture(start(350), end(352), rect, 1200), 1);
check('左侧触摸热区上一章', gestures.resolveGesture(start(30), end(32), rect, 1200), -1);
check('中央点击不翻页', gestures.resolveGesture(start(200), end(200), rect, 1200), 0);
check('鼠标点击热区不误翻', gestures.resolveGesture(start(350, 200, 'mouse'), end(350), rect, 1200), 0);
check('横向斜滑满足比例可翻页', gestures.resolveGesture(start(300, 100), end(170, 170), rect, 1400), 1);

const listeners = {};
const fake = {
  addEventListener: (name, fn) => { listeners[name] = fn; },
  removeEventListener: (name) => { delete listeners[name]; },
  getBoundingClientRect: () => rect,
};
let navigated = 0;
const destroy = gestures.bind(fake, { navigate: (delta) => { navigated = delta; } });
listeners.pointerdown({ target: null, pointerType: 'touch', button: 0, clientX: 300, clientY: 200 });
listeners.pointerup({ target: null, clientX: 180, clientY: 200, cancelable: true, preventDefault() {} });
check('事件绑定执行下一章', navigated, 1);
destroy();
check('销毁后移除监听', Object.keys(listeners).length, 0);
console.log(`结果: ${ok} 通过, 0 失败`);
