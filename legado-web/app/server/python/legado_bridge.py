#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FnReader ↔ Python 规则引擎桥。

用法：python3 legado_bridge.py <action> < payload.json
action: probe | search | toc | content
stdout 只输出一行 JSON。
"""
import json
import os
import sys
import traceback
from toc_normalize import normalize_chapters

# 依赖装在 python/vendor 时也要能 import；开发机可显式跳过不匹配平台的 vendor。
_HERE = os.path.dirname(os.path.abspath(__file__))
_PATHS = (_HERE,) if os.environ.get("LEGADO_PYTHONPATH") else (os.path.join(_HERE, "vendor"), _HERE)
for _p in _PATHS:
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def need_engine():
    try:
        import legado_rule  # noqa: F401
    except Exception as e:  # pragma: no cover
        raise RuntimeError("legado_rule 未安装：%s" % (e,))


UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def make_fetcher():
    """带 UA / Referer 的抓取器：站点对裸 requests 会返回反爬页"""
    import requests

    def fetch(url, method="GET", headers=None, body=None, **_kw):
        h = {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
        if headers:
            h.update({k: v for k, v in headers.items() if v})
        if method.upper() == "POST" and isinstance(body, str) and "Content-Type" not in h:
            # 站点按表单解析，缺这个头会返回反爬页（内容明显变短）
            h["Content-Type"] = "application/x-www-form-urlencoded"
        resp = requests.request(method.upper(), url, headers=h, data=body, timeout=25)
        if not resp.encoding or resp.encoding.lower() in ("iso-8859-1", "ascii"):
            resp.encoding = resp.apparent_encoding or "utf-8"
        return resp.text

    return fetch


def engine_for(source):
    from legado_rule import BookSourceEngine

    try:
        return BookSourceEngine(source, fetcher=make_fetcher())
    except TypeError:
        return BookSourceEngine(source)


def do_search(payload):
    engine = engine_for(payload["source"])
    books = engine.search(payload.get("key", ""), int(payload.get("page") or 1))
    return {"books": books, "engine": "python"}


def do_toc(payload):
    engine = engine_for(payload["source"])
    chapters = engine.chapters(payload.get("tocUrl") or payload.get("bookUrl"))
    return {"chapters": normalize_chapters(chapters), "normalized": "python", "engine": "python"}


def do_content(payload):
    engine = engine_for(payload["source"])
    data = engine.content(payload.get("chapterUrl"))
    return {
        "paragraphs": data.get("content", "").split("\n") if isinstance(data.get("content"), str) else data.get("content", []),
        "nextContentUrl": data.get("nextContentUrl", ""),
        "engine": "python",
    }


def do_normalize_toc(payload):
    return {"chapters": normalize_chapters(payload.get("chapters")), "normalized": "python"}


ACTIONS = {"search": do_search, "toc": do_toc, "content": do_content, "normalize-toc": do_normalize_toc}


def execute(action, payload):
    if action == "probe":
        import legado_rule

        return {"ok": True, "engine": getattr(legado_rule, "__version__", "unknown"), "pid": os.getpid()}
    if action != "normalize-toc":
        need_engine()
    fn = ACTIONS.get(action)
    if not fn:
        return {"error": "不支持的动作: %s" % action}
    return fn(payload)


def worker():
    """持久 JSONL worker：一个进程服务多次调用，避免每次重建解释器和 HTTP 库。"""
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = execute(request.get("action", "probe"), request.get("payload") or {})
            result["id"] = request_id
            out(result)
        except Exception as e:
            out({"id": request_id, "error": "%s: %s" % (type(e).__name__, str(e)[:300]),
                 "trace": traceback.format_exc()[-800:]})


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "probe"
    if action == "--worker":
        worker()
        return
    if action == "probe":
        try:
            out(execute(action, {}))
        except Exception as e:
            out({"error": "%s: %s" % (type(e).__name__, str(e)[:300])})
        return
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}

    try:
        out(execute(action, payload))
    except Exception as e:
        out({"error": "%s: %s" % (type(e).__name__, str(e)[:300]), "trace": traceback.format_exc()[-800:]})


if __name__ == "__main__":
    main()
