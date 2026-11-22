#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FnReader ↔ Python 规则引擎桥。

用法：python3 legado_bridge.py <action> < payload.json
action: probe | search | toc | content
stdout 只输出一行 JSON。
"""
import json
import os
import re
import sys
import traceback

# 依赖装在 python/vendor（cp311）或 python/vendor39（cp39）时都要能 import
_HERE = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.environ.get("LEGADO_VENDOR") or (
    "vendor39" if sys.version_info[:2] == (3, 9) else "vendor"
)
for _p in (os.path.join(_HERE, _VENDOR), os.path.join(_HERE, "vendor"), _HERE):
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
    "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0"
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
    books = engine.search(payload.get("key", ""))
    return {"books": books}


def do_toc(payload):
    """目录：支持分页（规则里有 nextTocUrl，或页面有「下一页」链接）"""
    engine = engine_for(payload["source"])
    start = payload.get("tocUrl") or payload.get("bookUrl")
    chapters = []
    seen_urls = set()
    visited = set()
    url = start
    pages = 0

    while url and pages < 40 and url not in visited:
        visited.add(url)
        pages += 1
        try:
            page = engine.chapters(url)
        except Exception:
            page = []
        fresh = [c for c in page if c.get("url") and c["url"] not in seen_urls]
        for c in fresh:
            seen_urls.add(c["url"])
        chapters.extend(fresh)
        if not fresh and pages > 1:
            break

        # 下一页：优先用规则，其次页面上的「下一页」链接
        nxt = ""
        try:
            rule_str = engine._rule("ruleToc", "nextTocUrl")
            if rule_str:
                text = engine._fetch(url)
                rule = engine._new_rule(text, url)
                nxt = engine._absolutize(rule.get_string(rule_str, is_url=True) or "")
        except Exception:
            nxt = ""
        if not nxt:
            try:
                text = engine._fetch(url)
                rule = engine._new_rule(text, url)
                for a in rule.get_elements("tag.a"):
                    label = (rule.get_string("text", m_content=a) or "").strip()
                    if label in ("下一页", "下页", "下一頁", "next", "›", "»", "下一页»"):
                        nxt = engine._absolutize(rule.get_string("href", m_content=a) or "")
                        if nxt:
                            break
            except Exception:
                nxt = ""
        if not nxt or nxt in visited:
            break
        url = nxt

    return {"chapters": chapters, "pages": pages}


def do_content(payload):
    engine = engine_for(payload["source"])
    data = engine.content(payload.get("chapterUrl"))
    return {
        "paragraphs": data.get("content", "").split("\n") if isinstance(data.get("content"), str) else data.get("content", []),
        "nextContentUrl": data.get("nextContentUrl", ""),
    }


def do_txt(payload):
    """TXT 分章：用 TXT 目录规则（Legado txtTocRule 启用项）"""
    from legado_rule.txt_toc import split_chapters

    text = str(payload.get("text") or "")
    name = str(payload.get("name") or "未命名")
    if payload.get("useRules", True):
        r = split_chapters(text, name)
        chs = r["chapters"]
        for i, c in enumerate(chs):
            c["index"] = i
            c["paragraphs"] = [p for p in c["paragraphs"] if p]
        return {
            "name": name,
            "chapters": chs,
            "chars": sum(len("".join(c["paragraphs"])) for c in chs),
            "rule": r["rule"],
            "hits": r["hits"],
        }

    import re
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    chap_re = re.compile(r"^\s*(第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷]|Chapter\s+\d+)", re.I)
    chapters = []
    cur = {"title": name, "paragraphs": []}
    for line in lines:
        t = line.strip().replace("\u3000", " ")
        if not t:
            continue
        if chap_re.match(t) and len(t) <= 40:
            if cur["paragraphs"] or cur["title"] != name:
                chapters.append(cur)
            cur = {"title": t, "paragraphs": []}
        else:
            cur["paragraphs"].append(t)
    if cur["paragraphs"] or cur["title"] != name:
        chapters.append(cur)
    if not chapters:
        chapters = [{"title": name, "paragraphs": [l.strip() for l in lines if l.strip()]}]
    for i, c in enumerate(chapters):
        c["index"] = i
    return {"name": name, "chapters": chapters, "chars": sum(len("".join(c["paragraphs"])) for c in chapters)}


def do_dedupe(payload):
    """书架去重：书名+作者相同即同一本，保留章数最多的一条，其余并入 altOrigins"""
    import re

    def norm(text):
        t = str(text or "")
        t = re.sub(r"作者[:：]", "", t)
        t = re.sub(r"作\s*者[:：]", "", t)
        t = re.sub(r"[《》「」【】\[\]()（）\s·・.。,:：;；!！?？\"'’“”]", "", t)
        t = re.sub(r"^第.{1,6}[章节回]", "", t)
        return t.strip().lower()

    def chapters_of(b):
        ch = b.get("chapters") or []
        if isinstance(ch, list) and ch:
            return len(ch)
        for k in ("totalChapterNum", "chapterCount", "numChapter"):
            try:
                v = int(b.get(k) or 0)
                if v:
                    return v
            except Exception:
                pass
        return 0

    books = payload.get("books") or []
    groups = {}
    order = []
    for b in books:
        key = norm(b.get("name")) + "|" + norm(b.get("author"))
        if not key.strip("|"):
            order.append(("__single__", b))
            continue
        groups.setdefault(key, []).append(b)
        if key not in order:
            order.append(key)

    out = []
    removed = 0
    for item in order:
        if isinstance(item, tuple):
            out.append(item[1])
            continue
        group = groups[item]
        if len(group) == 1:
            out.append(group[0])
            continue
        group.sort(key=lambda x: (chapters_of(x), 1 if x.get("cachedDir") else 0,
                                  int(x.get("durChapterIndex") or 0), 1 if x.get("intro") else 0), reverse=True)
        winner = dict(group[0])
        alt = list(winner.get("altOrigins") or [])
        for loser in group[1:]:
            key2 = loser.get("origin") or loser.get("bookUrl")
            if key2 and key2 != winner.get("origin") and not any((a.get("origin") or a.get("bookUrl")) == key2 for a in alt):
                alt.append({"origin": loser.get("origin") or "", "originName": loser.get("originName") or "",
                            "bookUrl": loser.get("bookUrl") or "", "chapters": chapters_of(loser)})
            for f in ("intro", "coverUrl", "author", "kind", "lastChapter"):
                if not winner.get(f) and loser.get(f):
                    winner[f] = loser[f]
            if chapters_of(loser) > chapters_of(winner):
                winner["chapters"] = loser.get("chapters")
            winner["totalChapterNum"] = max(chapters_of(winner), chapters_of(loser))
            removed += 1
        winner["altOrigins"] = alt
        out.append(winner)
    return {"books": out, "removed": removed, "kept": len(out)}


def _html_to_text(raw: str) -> str:
    """正文 HTML → 纯文本段落"""
    import re
    from html import unescape

    t = str(raw or "")
    t = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", t)
    t = re.sub(r"(?i)<br\s*/?>", "\n", t)
    t = re.sub(r"(?i)</p\s*>", "\n\n", t)
    t = re.sub(r"(?i)</div\s*>", "\n", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = unescape(t)
    t = t.replace("\u3000", " ").replace("\xa0", " ")
    lines = [ln.strip() for ln in t.split("\n")]
    out = []
    for ln in lines:
        if ln:
            out.append(ln)
    return "\n\n".join(out)


def do_book_txt(payload):
    """整本下载：Python 侧用 4 线程抓章节正文，写 txt 并落进度文件"""
    import json
    import threading
    from concurrent.futures import ThreadPoolExecutor

    source = payload.get("source") or {}
    chapters = payload.get("chapters") or []
    out_path = str(payload.get("outPath") or "")
    progress_path = str(payload.get("progressPath") or "")
    threads = max(1, min(8, int(payload.get("threads") or 4)))
    header = str(payload.get("header") or "")

    if not out_path or not chapters:
        return {"error": "缺少 outPath 或 chapters"}

    engine = engine_for(source)
    results = [None] * len(chapters)
    done = 0
    failed = 0
    lock = threading.Lock()

    def flush(done_n, failed_n, finished=False):
        if not progress_path:
            return
        try:
            with open(progress_path, "w", encoding="utf-8") as f:
                json.dump({"done": done_n, "total": len(chapters), "failed": failed_n, "finished": finished}, f)
        except Exception:
            pass

    def work(idx):
        nonlocal done, failed
        ch = chapters[idx]
        try:
            r = engine.content(ch.get("url") or "")
            text = _html_to_text(r.get("content") or "")
            if not text:
                text = "（本章为空）"
            results[idx] = {"title": ch.get("title") or f"第{idx + 1}章", "text": text}
        except Exception:
            with lock:
                failed += 1
            results[idx] = {"title": ch.get("title") or f"第{idx + 1}章", "text": "（本章抓取失败）"}
        with lock:
            done += 1
            if done % 5 == 0:
                flush(done, failed)

    with ThreadPoolExecutor(max_workers=threads) as ex:
        list(ex.map(work, range(len(chapters))))

    parts = [header.rstrip("\n"), ""]
    for item in results:
        if not item:
            continue
        parts.append("\n\n" + str(item["title"]) + "\n\n" + str(item["text"]))
    text = "\n".join(parts)
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
    except Exception as e:
        return {"error": f"写入失败：{e}"}
    flush(done, failed, True)
    return {"ok": True, "done": done, "failed": failed, "total": len(chapters), "chars": len(text), "outPath": out_path}



def _render_txt(chapters):
    """把 [{title, paragraphs:[...]}] 拼成 TXT 文本（去空白、章节间空行）"""
    import re

    out = []
    for c in chapters or []:
        title = str(c.get("title") or "").strip()
        paras = c.get("paragraphs") or []
        if title:
            out.append(title)
        for p in paras:
            t = str(p or "").replace("\r", "").replace("\u3000", " ").strip()
            if t:
                out.append(t)
        if out and out[-1] != "":
            out.append("")
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"
    return text


def _render_files(files):
    """把缓存目录里的一批 .txt 按文件名排序拼接（去掉文件名前缀里的章节号）"""
    import re

    parts = []
    for f in files or []:
        try:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                body = fh.read()
        except Exception:
            continue
        name = os.path.basename(f)
        title = re.sub(r"^\d+[\s._-]*", "", re.sub(r"\.txt$", "", name)).strip()
        if title:
            parts.append(title)
        parts.append(body.replace("\r", "").strip())
        parts.append("")
    return re.sub(r"\n{3,}", "\n\n", "\n".join(parts)).strip() + "\n"


def do_export_txt(payload):
    """导出 TXT：single=返回文本；write=写文件；batch=多本写文件（4 线程）"""
    import json as _json
    from concurrent.futures import ThreadPoolExecutor

    mode = str(payload.get("mode") or "single")
    name = str(payload.get("name") or "book").strip() or "book"

    def safe_name(n):
        import re

        return (re.sub(r'[\\/:*?"<>|\r\n\t]', "_", str(n or "未命名"))[:80] or "未命名")

    def text_of(item):
        if item.get("files"):
            return _render_files(item.get("files"))
        return _render_txt(item.get("chapters"))

    if mode == "single":
        text = text_of(payload)
        return {"ok": True, "text": text, "chars": len(text), "bytes": len(text.encode("utf-8"))}

    if mode == "write":
        out_path = str(payload.get("outPath") or "")
        if not out_path:
            return {"error": "缺少 outPath"}
        text = text_of(payload)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        return {"ok": True, "path": out_path, "chars": len(text), "bytes": len(text.encode("utf-8"))}

    if mode == "batch":
        out_dir = str(payload.get("outDir") or "")
        if not out_dir:
            return {"error": "缺少 outDir"}
        os.makedirs(out_dir, exist_ok=True)

        def one(item):
            n = safe_name(item.get("name"))
            path = os.path.join(out_dir, n + ".txt")
            try:
                text = text_of(item)
                if len(text) < 20:
                    return {"name": n, "skipped": True}
                with open(path, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(text)
                return {"name": n, "path": path, "chars": len(text)}
            except Exception as e:
                return {"name": n, "error": str(e)[:120]}

        books = payload.get("books") or []
        with ThreadPoolExecutor(max_workers=max(1, min(4, int(payload.get("threads") or 4)))) as pool:
            results = list(pool.map(one, books))
        return {
            "ok": True,
            "written": [r["name"] for r in results if r.get("path")],
            "skipped": [r["name"] for r in results if r.get("skipped") or r.get("error")],
            "results": results,
        }

    return {"error": "不支持的模式: %s" % mode}


_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}
_CHAPTER_RE = re.compile(r"^\s*第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回卷]")
_NUMBER_RE = re.compile(r"第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*[章节回卷]")


def _cn_to_int(text):
    total = section = number = 0
    for ch in text:
        if ch.isdigit():
            number = number * 10 + int(ch)
        elif ch in _CN_DIGITS:
            number = _CN_DIGITS[ch]
        elif ch in _CN_UNITS:
            unit = _CN_UNITS[ch]
            if unit == 10000:
                section = (section + number) * unit
                total += section
                section = 0
            else:
                section += (number or 1) * unit
            number = 0
    return total + section + number


def _chapter_no(title):
    m = _NUMBER_RE.search(str(title or ""))
    return _cn_to_int(m.group(1)) if m else 0


def do_normalize_toc(payload):
    """目录规范化（原 Java 引擎职责）：去重 / 剔除杂项 / 按章节号稳定排序"""
    chapters = payload.get("chapters") or []
    if not isinstance(chapters, list) or len(chapters) < 2:
        return {"chapters": chapters}
    seen_url = set()
    seen_title = set()
    deduped = []
    for c in chapters:
        if not isinstance(c, dict):
            continue
        url = str(c.get("url") or "").strip()
        title = re.sub(r"\s+", "", str(c.get("title") or ""))
        if (url and url in seen_url) or (title and title in seen_title):
            continue
        if url:
            seen_url.add(url)
        if title:
            seen_title.add(title)
        deduped.append(c)
    if len(deduped) < 2:
        return {"chapters": deduped}
    std = sum(1 for c in deduped if _CHAPTER_RE.search(str(c.get("title") or "")))
    filtered = [c for c in deduped if _CHAPTER_RE.search(str(c.get("title") or ""))] if std >= len(deduped) * 0.7 else deduped
    nums = [_chapter_no(c.get("title")) for c in filtered]
    known = sum(1 for n in nums if n > 0)
    if known < len(filtered) * 0.6:
        return {"chapters": filtered}
    # 稳定排序：已知章节号按号，未知的排最后但保持原相对顺序
    indexed = sorted(enumerate(filtered), key=lambda p: (nums[p[0]] if nums[p[0]] > 0 else 1 << 60, p[0]))
    return {"chapters": [c for _, c in indexed]}


ACTIONS = {"search": do_search, "toc": do_toc, "content": do_content, "txt": do_txt, "dedupe": do_dedupe, "book_txt": do_book_txt, "export_txt": do_export_txt, "export-txt": do_export_txt, "normalize_toc": do_normalize_toc, "normalize-toc": do_normalize_toc}


def worker_loop():
    """持久 worker 模式：逐行读取 {id, action, payload}，逐行回 {id, ...result}"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        action = req.get("action")
        payload = req.get("payload") or {}
        try:
            fn = ACTIONS.get(action)
            if not fn:
                raise RuntimeError("不支持的动作: %s" % action)
            if action in ("search", "toc", "content", "txt"):
                need_engine()
            res = fn(payload)
            resp = {"id": rid}
            if isinstance(res, dict):
                resp.update(res)
            else:
                resp["result"] = res
            out(resp)
        except Exception as e:
            out({"id": rid, "error": "%s: %s" % (type(e).__name__, str(e)[:300])})



def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "probe"
    if action == "--worker":
        worker_loop()
        return
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}

    try:
        if action == "probe":
            import legado_rule

            out({"ok": True, "engine": getattr(legado_rule, "__version__", "unknown")})
            return
        # 只有规则解析类动作需要 legado_rule（lxml）；导出/去重等纯处理动作不依赖
        if action in ("search", "toc", "content", "txt"):
            need_engine()
        fn = ACTIONS.get(action)
        if not fn:
            out({"error": "不支持的动作: %s" % action})
            return
        out(fn(payload))
    except Exception as e:
        out({"error": "%s: %s" % (type(e).__name__, str(e)[:300]), "trace": traceback.format_exc()[-800:]})


if __name__ == "__main__":
    main()
