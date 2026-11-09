"""@js: 沙箱。

Legado 用 Rhino 跑书源里的 JS。Python 侧没有内置 JS 引擎，因此这里抽象出一个
``JsEngine``，后端按优先级自动选择：

1. ``quickjs``      —— pip 可装的嵌入式 ES2020 引擎，纯 Python 调用，无外部进程；
2. ``node``         —— 若环境里装了 node，用一次性子进程执行（FnReader 的 FPK
                       环境自带 node，可作为兜底）；
3. 都没有           —— ``eval`` 返回空串并记录一条错误，不影响其他规则。

跨语言调用统一走 JSON 字符串，避免各引擎对 Python 对象的映射差异：
JS 侧 ``java.getString(...)`` → ``__pycall('getString', '["rule"]')`` →
Python 回调 → 返回 JSON 字符串 → JS ``JSON.parse``。

这样做的好处是 ``java.*`` 与书源里的用法完全一致，而 Python 侧只需要实现
一个 ``(name, args_json) -> result_json`` 的函数。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from typing import Any, Callable

PRELUDE = r"""
var __undefined = (function(){ return void 0; })();

function __bind(bindJson) {
  var b = JSON.parse(bindJson);
  for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) { globalThis[k] = b[k]; } }
}

function __run(code) {
  var v;
  try {
    v = eval(code);
  } catch (e) {
    return JSON.stringify({t: 'e', v: String((e && e.message) || e)});
  }
  if (v === undefined) { return JSON.stringify({t: 'u'}); }
  try {
    var s = JSON.stringify(v);
    if (s === undefined) { return JSON.stringify({t: 's', v: String(v)}); }
    return JSON.stringify({t: 'v', v: s});
  } catch (e2) {
    try { return JSON.stringify({t: 's', v: String(v)}); }
    catch (e3) { return JSON.stringify({t: 'u'}); }
  }
}

var __bridge = {
  call: function (name, args) { return JSON.parse(__pycall(name, JSON.stringify(args || []))); }
};

var java = {
  // Kotlin 签名：getString(rule, mContent = null, isUrl = false)
  getString: function (rule, mContent, isUrl) {
    var r = __bridge.call('getString', [String(rule),
      (mContent === undefined ? null : String(mContent)), !!isUrl]);
    return (r === null || r === undefined) ? '' : r;
  },
  getStringList: function (rule, mContent) {
    var r = __bridge.call('getStringList', [String(rule),
      (mContent === undefined ? null : String(mContent))]);
    return r || [];
  },
  getElements: function (rule) {
    return __bridge.call('getElements', [String(rule)]) || [];
  },
  put: function (key, value) {
    var r = __bridge.call('put', [String(key), String(value)]);
    return (r === null || r === undefined) ? String(value) : r;
  },
  get: function (key) { var r = __bridge.call('get', [String(key)]); return r === null ? '' : r; },
  ajax: function (url) { return __bridge.call('ajax', [String(url)]) || ''; },
  log: function (msg) { __bridge.call('log', [String(msg)]); },
  base64Encode: function (s) { return __bridge.call('base64Encode', [String(s)]) || ''; },
  base64Decode: function (s) { return __bridge.call('base64Decode', [String(s)]) || ''; },
  md5Encode: function (s) { return __bridge.call('md5Encode', [String(s)]) || ''; },
  timeFormat: function () { return Date.now(); },
  toast: function () {}
};

var cookie = { getCookie: function () { return ''; }, setCookie: function () {} };
var cache = { get: function () { return null; }, put: function () {} };
"""


class JsError(RuntimeError):
    pass


class JsEngine:
    """对外只暴露 ``eval(code, bindings)``，内部按后端分派。"""

    def __init__(self, host: Any = None, prefer: str | None = None) -> None:
        self.host = host
        self.logs: list[str] = []
        self._backend = None
        self._backend_name = "none"
        order = [prefer] if prefer else ["quickjs", "node"]
        for name in order:
            if name == "quickjs":
                try:
                    import quickjs  # noqa: F401
                    self._backend = _QuickJsBackend(self)
                    self._backend_name = "quickjs"
                    break
                except Exception:
                    continue
            if name == "node":
                node = shutil.which("node") or (
                    "/opt/nodejs/22/bin/node" if os.path.exists("/opt/nodejs/22/bin/node") else None
                )
                if node:
                    self._backend = _NodeBackend(self, node)
                    self._backend_name = "node"
                    break

    @property
    def backend_name(self) -> str:
        return self._backend_name

    @property
    def available(self) -> bool:
        return self._backend is not None

    def load_lib(self, js_lib: str | None) -> None:
        """书源的 ``jsLib``：在全局作用域里预先声明一次。"""
        if not js_lib or not self._backend:
            return
        self._backend.eval_raw(js_lib)

    def eval(self, code: str, bindings: dict[str, Any] | None = None) -> Any:
        if not self._backend:
            self.logs.append("[js] 没有可用的 JS 引擎，@js 规则被跳过")
            return None
        return self._backend.eval(code, _jsonable(bindings or {}))

    # ------------------------------------------------------------------ #
    def pycall(self, name: str, args_json: str) -> str:
        """JS 侧 ``__pycall`` 的落点。"""
        try:
            args = json.loads(args_json or "[]")
        except Exception:
            args = []
        try:
            value = self._dispatch(name, args)
        except Exception as exc:
            self.logs.append(f"[js] java.{name} 调用失败: {exc}")
            value = None
        return json.dumps(value, ensure_ascii=False, default=str)

    def _dispatch(self, name: str, args: list[Any]) -> Any:
        host = self.host
        if host is None:
            return None
        if name == "getString":
            # Kotlin 签名：getString(rule, mContent = null, isUrl = false)
            content, is_url = None, False
            if len(args) > 1:
                if isinstance(args[1], bool):
                    is_url = args[1]
                else:
                    content = args[1]
            if len(args) > 2:
                is_url = bool(args[2])
            return host.js_get_string(args[0], content, is_url)
        if name == "getStringList":
            return host.js_get_string_list(args[0], args[1] if len(args) > 1 else None)
        if name == "getElements":
            return host.js_get_elements(args[0])
        if name == "put":
            return host.js_put(args[0], args[1])
        if name == "get":
            return host.js_get(args[0])
        if name == "ajax":
            return host.js_ajax(args[0])
        if name == "log":
            self.logs.append(str(args[0]))
            host.js_log(args[0])
            return None
        if name == "base64Encode":
            import base64
            return base64.b64encode(str(args[0]).encode("utf-8")).decode("ascii")
        if name == "base64Decode":
            import base64
            try:
                return base64.b64decode(str(args[0])).decode("utf-8", "ignore")
            except Exception:
                return ""
        if name == "md5Encode":
            import hashlib
            return hashlib.md5(str(args[0]).encode("utf-8")).hexdigest()
        return None


class _QuickJsBackend:
    def __init__(self, engine: JsEngine) -> None:
        import quickjs
        self.ctx = quickjs.Context()
        self.engine = engine
        self.ctx.add_callable("__pycall", engine.pycall)
        self.ctx.eval(PRELUDE)

    def eval_raw(self, code: str) -> Any:
        try:
            return self.ctx.eval(code)
        except Exception as exc:
            raise JsError(str(exc)) from exc

    def eval(self, code: str, bindings: dict[str, Any]) -> Any:
        self.ctx.eval("__bind(%s)" % json.dumps(json.dumps(bindings, ensure_ascii=False)))
        raw = self.ctx.eval("__run(%s)" % json.dumps(code))
        return _decode_result(raw)


class _NodeBackend:
    """一次性 node 子进程，避免常驻进程的管道复杂度。"""

    def __init__(self, engine: JsEngine, node_path: str) -> None:
        self.engine = engine
        self.node = node_path
        self.lib = ""
        self.script = self._make_script()

    @staticmethod
    def _make_script() -> str:
        # 用 stdin 传入 payload，stdout 只输出一行结果 JSON
        return PRELUDE + r"""
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const calls = [];
  globalThis.__pycall = function (name, argsJson) {
    const reply = payload.replies && payload.replies[name + '#' + String(argsJson)]
      ? payload.replies[name + '#' + String(argsJson)]
      : null;
    if (reply === null) {
      return JSON.stringify(payload.cache && payload.cache[name] !== undefined ? payload.cache[name] : null);
    }
    return reply;
  };
  try {
    if (payload.lib) { eval(payload.lib); }
    __bind(payload.bindingsJson);
    const out = __run(payload.code);
    process.stdout.write(out);
  } catch (e) {
    process.stdout.write(JSON.stringify({t: 'e', v: String((e && e.message) || e)}));
  }
});
"""

    def eval_raw(self, code: str) -> Any:
        self.lib += "\n" + code
        return None

    def eval(self, code: str, bindings: dict[str, Any]) -> Any:
        payload = {
            "lib": self.lib,
            "bindingsJson": json.dumps(bindings, ensure_ascii=False),
            "code": code,
            "replies": {},
        }
        # node 侧无法回调 Python，这里只在"无 java.* 调用"的简单场景可用；
        # 需要回调时我们会把预计算结果放进 cache（见 analyze_rule 的 bindings）。
        proc = subprocess.run(
            [self.node, "-e", self.script],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            raise JsError(proc.stderr.strip() or "node 执行失败")
        return _decode_result(proc.stdout.strip())


def _jsonable(value: Any) -> Any:
    """把绑定转成可 JSON 化的值。

    ``result`` / ``src`` 在"按条目取值"时是 lxml 元素，Kotlin 那边是
    ``Jsoup.Element`` 对象（JS 里做字符串运算会走 toString，即 outerHtml），
    这里做同样的降级：元素 → outerHtml，其余不可序列化的 → str。
    """
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "tag") and hasattr(value, "attrib"):  # lxml / ElementTree
        try:
            from .dom import outer_html
            return outer_html(value)
        except Exception:
            return str(value)
    return str(value)


def _decode_result(raw: Any) -> Any:
    if raw is None:
        return None
    text = str(raw)
    try:
        data = json.loads(text)
    except Exception:
        return text
    if not isinstance(data, dict):
        return data
    kind = data.get("t")
    if kind == "u":
        return None
    if kind == "e":
        raise JsError(data.get("v") or "JS 执行出错")
    if kind == "s":
        return data.get("v")
    value = data.get("v")
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value
    return value
