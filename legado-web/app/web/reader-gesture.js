(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReaderGestures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INTERACTIVE = 'a,button,input,textarea,select,summary,[role="button"],[contenteditable="true"]';

  /** 返回 -1 上一章、1 下一章、0 不翻页。滑动对所有指针可用，热区点击只用于触摸/笔。 */
  function resolveGesture(start, end, rect, now) {
    if (!start || !end || !rect || !rect.width) return 0;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const elapsed = Math.max(0, now - start.at);
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (elapsed <= 1000 && ax >= 56 && ax >= ay * 1.35 && ay <= 90) return dx < 0 ? 1 : -1;
    const isTap = elapsed <= 450 && ax <= 12 && ay <= 12;
    if (!isTap || start.pointerType === 'mouse') return 0;
    const ratio = (start.x - rect.left) / rect.width;
    if (ratio <= 0.22) return -1;
    if (ratio >= 0.78) return 1;
    return 0;
  }

  function bind(element, options) {
    if (!element || !options || typeof options.navigate !== 'function') return function () {};
    let start = null;
    const hasSelection = options.hasSelection || function () { return false; };
    const isBlocked = options.isBlocked || function () { return false; };
    const interactive = (target) => !!(target && typeof target.closest === 'function' && target.closest(INTERACTIVE));

    function onDown(event) {
      if (isBlocked() || interactive(event.target) || hasSelection()) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      start = { x: event.clientX, y: event.clientY, at: Date.now(), pointerType: event.pointerType || 'mouse' };
    }
    function onUp(event) {
      if (!start) return;
      const origin = start;
      start = null;
      if (isBlocked() || interactive(event.target) || hasSelection()) return;
      const delta = resolveGesture(origin, { x: event.clientX, y: event.clientY }, element.getBoundingClientRect(), Date.now());
      if (!delta) return;
      if (event.cancelable) event.preventDefault();
      options.navigate(delta, origin.pointerType);
    }
    function onCancel() { start = null; }
    element.addEventListener('pointerdown', onDown, { passive: true });
    element.addEventListener('pointerup', onUp, { passive: false });
    element.addEventListener('pointercancel', onCancel, { passive: true });
    return function destroy() {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
    };
  }

  return { resolveGesture, bind };
});
