"""书源 → 前端参数。

书源 JSON 有两种写法，Legado 都支持，这里也都要兼容：

* **分组写法**（现行标准）::

      "ruleSearch": {"bookList": ".result@li", "name": "tag.a@text", ...}
      "ruleBookInfo": {"name": "...", "tocUrl": "..."}
      "ruleToc": {"chapterList": "...", "chapterName": "..."}
      "ruleContent": {"content": "..."}

* **扁平写法**（老版本导出）::

      "ruleSearchList": ..., "ruleSearchName": ..., "ruleBookContent": ...

:meth:`_rule` 优先取分组值，取不到再回落扁平字段，与 Legado 的实体映射一致。

输出全部是纯 dict / list，``json.dumps`` 后前端直接消费 —— 前端不再需要自己
解析规则，只负责渲染。
"""

from __future__ import annotations

import functools
import json
import re
import urllib.parse
from typing import Any, Callable

from .analyze_rule import AnalyzeRule, java_replacement
from .models import BaseSource, Book, BookChapter

DEFAULT_UA = (
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/110.0 Mobile Safari/537.36"
)

# 分组名 → 扁平字段前缀
_SECTION_PREFIX = {
    "ruleSearch": "ruleSearch",
    "ruleBookInfo": "ruleBook",
    "ruleToc": "ruleChapter",
    "ruleContent": "ruleContent",
}

# 分组内的字段名 → 扁平字段里的驼峰名（老导出用的名字不完全一样）
_FLAT_ALIAS = {
    ("ruleSearch", "bookList"): "ruleSearchList",
    ("ruleSearch", "bookUrl"): "ruleSearchNoteUrl",
    ("ruleSearch", "intro"): "ruleSearchIntroduce",
    ("ruleSearch", "name"): "ruleSearchName",
    ("ruleSearch", "author"): "ruleSearchAuthor",
    ("ruleSearch", "kind"): "ruleSearchKind",
    ("ruleSearch", "lastChapter"): "ruleSearchLastChapter",
    ("ruleSearch", "coverUrl"): "ruleSearchCoverUrl",
    ("ruleBookInfo", "init"): "ruleBookInfoInit",
    ("ruleBookInfo", "name"): "ruleBookName",
    ("ruleBookInfo", "author"): "ruleBookAuthor",
    ("ruleBookInfo", "kind"): "ruleBookKind",
    ("ruleBookInfo", "lastChapter"): "ruleBookLastChapter",
    ("ruleBookInfo", "intro"): "ruleIntroduce",
    ("ruleBookInfo", "coverUrl"): "ruleCoverUrl",
    ("ruleBookInfo", "tocUrl"): "ruleChapterUrl",
    ("ruleToc", "chapterList"): "ruleChapterList",
    ("ruleToc", "chapterName"): "ruleChapterName",
    ("ruleToc", "chapterUrl"): "ruleChapterUrl",
    ("ruleContent", "content"): "ruleBookContent",
    ("ruleContent", "nextContentUrl"): "ruleContentUrlNext",
}


def _guard(action: str, default: Any) -> Callable[[Callable], Callable]:
    """单条规则/单个站点出错不应该炸掉整条链路：记日志、返回空结构。

    Legado 在调用侧（``BookSource.getBookList`` 等）也是 try/catch 后返回空
    列表 + 报错信息，这里把同样的策略下沉到引擎层。
    """
    def deco(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(self: "BookSourceEngine", *args: Any, **kwargs: Any) -> Any:
            try:
                return fn(self, *args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"{action}: {type(exc).__name__}: {exc}"
                self.logs.append(self.last_error)
                return default() if callable(default) else default
        return wrapper
    return deco


def default_fetch(url: str, method: str = "GET", headers: dict[str, str] | None = None,
                  body: str | None = None, charset: str | None = None) -> str:
    import requests

    resp = requests.request(method.upper(), url, headers=headers or {}, data=body, timeout=20)
    if charset:
        resp.encoding = charset
    elif not resp.encoding or resp.encoding.lower() == "iso-8859-1":
        resp.encoding = resp.apparent_encoding or "utf-8"
    return resp.text


class BookSourceEngine:
    def __init__(self, source: dict[str, Any], fetcher: Callable[..., str] | None = None) -> None:
        self.source = source
        self.base = BaseSource.from_dict(source)
        self.fetcher = fetcher or default_fetch
        self.headers = self._build_headers()
        self.logs: list[str] = []
        self.last_error: str | None = None

    # ------------------------------------------------------------------ #
    # 规则取值（分组优先，扁平兜底）
    # ------------------------------------------------------------------ #
    def _rule(self, section: str, field: str, default: str = "") -> str:
        group = self.source.get(section)
        if isinstance(group, dict) and field in group:
            value = group.get(field)
            if isinstance(value, str):
                return value
        alias = _FLAT_ALIAS.get((section, field))
        if alias:
            value = self.source.get(alias)
            if isinstance(value, str):
                return value
        # 再退一步：驼峰直拼（ruleSearch + Name）
        camel = self.source.get(section + field[0].upper() + field[1:])
        if isinstance(camel, str):
            return camel
        return default

    def _build_headers(self) -> dict[str, str]:
        headers = {"User-Agent": self.source.get("httpUserAgent") or DEFAULT_UA}
        raw = self.source.get("header")
        if isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    headers.update({str(k): str(v) for k, v in parsed.items()})
            except Exception:
                pass
        return headers

    def _new_rule(self, content: Any, base_url: str, book: Book | None = None,
                  chapter: BookChapter | None = None) -> AnalyzeRule:
        rule = AnalyzeRule(source=self.base, ajax=self._ajax)
        rule.set_content(content, base_url)
        rule.set_book(book)
        rule.set_chapter(chapter)
        return rule

    def _ajax(self, url: str) -> str:
        try:
            return self.fetcher(url, headers=self.headers)
        except Exception:
            return ""

    # ------------------------------------------------------------------ #
    # URL 规则
    # ------------------------------------------------------------------ #
    @staticmethod
    def split_options(url_rule: str) -> tuple[str, dict[str, Any]]:
        """拆出 ``url,{...}`` 尾部的请求选项（Legado 的 AnalyzeUrl 语法）。"""
        m = re.match(r"^(.*),\s*(\{[\s\S]*\})\s*$", url_rule)
        if m and m.group(1) and not m.group(1).strip().startswith("{"):
            try:
                options = json.loads(m.group(2))
                if isinstance(options, dict):
                    return m.group(1), options
            except Exception:
                pass
        return url_rule, {}

    def _eval_url_rule(self, url_rule: str, key: str = "", page: int = 1,
                       base_url: str = "") -> tuple[str, dict[str, Any]]:
        """``searchUrl`` / ``tocUrl`` 可能是 ``@js:`` 规则，也可能是模板。"""
        if "@js:" in url_rule or "<js>" in url_rule:
            rule = AnalyzeRule(source=self.base, ajax=self._ajax)
            rule.set_content("", base_url)
            rule.set_local("key", key)
            rule.set_local("page", str(page))
            value = rule.eval_js(
                url_rule.split("@js:", 1)[-1] if "@js:" in url_rule else url_rule
            )
            if isinstance(value, list):
                url = str(value[0]) if value else ""
                options = value[1] if len(value) > 1 and isinstance(value[1], dict) else {}
                return url, options
            if isinstance(value, dict):
                return str(value.get("url", "")), value
            if value:
                return str(value), {}

        encoded_key = urllib.parse.quote(key, safe="")
        body_rule = url_rule.replace("{{key.}}", key)
        body_rule = body_rule.replace("{{key}}", encoded_key).replace("{{page}}", str(page))
        url, options = self.split_options(body_rule)
        return self._absolutize(url), options

    def _absolutize(self, url: str) -> str:
        """相对 URL 一律按 bookSourceUrl 补全（Legado 的 AnalyzeUrl 同样如此）。"""
        if not url or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
            return url
        base = self.base.book_source_url or ""
        if not base:
            return url
        return urllib.parse.urljoin(base if base.endswith("/") else base + "/", url)

    def build_search_url(self, key: str, page: int = 1) -> tuple[str, str, str | None]:
        url_rule = self.source.get("searchUrl") or ""
        url, options = self._eval_url_rule(url_rule, key=key, page=page)
        body = options.get("body")
        if isinstance(body, str):
            encoded_key = urllib.parse.quote(key, safe="")
            body = body.replace("{{key}}", encoded_key).replace("{{page}}", str(page))
        return url, str(options.get("method", "GET")), body

    def _fetch(self, url: str, options: dict[str, Any] | None = None) -> str:
        options = options or {}
        headers = dict(self.headers)
        extra = options.get("headers")
        if isinstance(extra, dict):
            headers.update({str(k): str(v) for k, v in extra.items()})
        return self.fetcher(
            url,
            method=str(options.get("method", "GET")),
            headers=headers,
            body=options.get("body"),
            charset=options.get("charset"),
        )

    # ------------------------------------------------------------------ #
    # 搜索
    # ------------------------------------------------------------------ #
    @_guard("search", list)
    def search(self, key: str, page: int = 1) -> list[dict[str, Any]]:
        url_rule = self.source.get("searchUrl") or ""
        if not url_rule:
            return []
        url, options = self._eval_url_rule(url_rule, key=key, page=page)
        body = options.get("body")
        if isinstance(body, str):
            encoded_key = urllib.parse.quote(key, safe="")
            body = body.replace("{{key}}", encoded_key).replace("{{page}}", str(page))
            options = dict(options, body=body)
        text = self._fetch(url, options)
        rule = self._new_rule(text, url)
        items = rule.get_elements(self._rule("ruleSearch", "bookList"))
        books: list[dict[str, Any]] = []
        for item in items:
            book = self._parse_search_item(item, url)
            if book.get("name"):
                books.append(book)
        return books

    def _parse_search_item(self, item: Any, base_url: str) -> dict[str, Any]:
        rule = self._new_rule(item, base_url)
        return {
            "name": rule.get_string(self._rule("ruleSearch", "name")),
            "author": rule.get_string(self._rule("ruleSearch", "author")),
            "kind": rule.get_string(self._rule("ruleSearch", "kind")),
            "lastChapter": rule.get_string(self._rule("ruleSearch", "lastChapter")),
            "intro": rule.get_string(self._rule("ruleSearch", "intro")),
            "coverUrl": rule.get_string(self._rule("ruleSearch", "coverUrl"), is_url=True),
            "bookUrl": rule.get_string(self._rule("ruleSearch", "bookUrl"), is_url=True),
            "origin": self.base.book_source_url,
        }

    # ------------------------------------------------------------------ #
    # 详情
    # ------------------------------------------------------------------ #
    @_guard("bookInfo", dict)
    def book_info(self, book_url: str, book: Book | None = None) -> dict[str, Any]:
        book = book or Book(book_url=book_url, origin=self.base.book_source_url)
        text = self._fetch(book_url)
        rule = self._new_rule(text, book_url, book=book)

        init = self._rule("ruleBookInfo", "init")
        if init:
            name = rule.get_string(init)
            if name:
                book.name = name

        info = {
            "name": rule.get_string(self._rule("ruleBookInfo", "name")) or book.name,
            "author": rule.get_string(self._rule("ruleBookInfo", "author")) or book.author,
            "kind": rule.get_string(self._rule("ruleBookInfo", "kind")),
            "lastChapter": rule.get_string(self._rule("ruleBookInfo", "lastChapter")),
            "intro": rule.get_string(self._rule("ruleBookInfo", "intro")),
            "coverUrl": rule.get_string(self._rule("ruleBookInfo", "coverUrl"), is_url=True),
            "tocUrl": rule.get_string(self._rule("ruleBookInfo", "tocUrl"), is_url=True) or book_url,
            "bookUrl": book_url,
            "origin": self.base.book_source_url,
        }
        return info

    # ------------------------------------------------------------------ #
    # 目录
    # ------------------------------------------------------------------ #
    @_guard("chapters", list)
    def chapters(self, toc_url: str, book: Book | None = None) -> list[dict[str, Any]]:
        text = self._fetch(toc_url)
        book = book or Book(book_url=toc_url, origin=self.base.book_source_url)
        rule = self._new_rule(text, toc_url, book=book)
        items = rule.get_elements(self._rule("ruleToc", "chapterList"))

        chapters: list[dict[str, Any]] = []
        for index, item in enumerate(items):
            sub = self._new_rule(item, toc_url, book=book)
            title = sub.get_string(self._rule("ruleToc", "chapterName"))
            url = sub.get_string(self._rule("ruleToc", "chapterUrl"), is_url=True)
            if not url:
                continue
            chapters.append({
                "index": index,
                "title": title or f"第{index + 1}章",
                "url": url,
                "bookUrl": book.book_url,
            })
        return chapters

    # ------------------------------------------------------------------ #
    # 正文
    # ------------------------------------------------------------------ #
    @_guard("content", dict)
    def content(self, chapter_url: str, book: Book | None = None,
                chapter: BookChapter | None = None) -> dict[str, Any]:
        text = self._fetch(chapter_url)
        book = book or Book(book_url=chapter_url, origin=self.base.book_source_url)
        chapter = chapter or BookChapter(url=chapter_url)
        rule = self._new_rule(text, chapter_url, book=book, chapter=chapter)

        content = rule.get_string(self._rule("ruleContent", "content"))
        replace_regex = self._rule("ruleContent", "replaceRegex")
        if content and replace_regex:
            content = _apply_content_replace(content, replace_regex)

        return {
            "content": content,
            "nextContentUrl": rule.get_string(
                self._rule("ruleContent", "nextContentUrl"), is_url=True
            ),
            "url": chapter_url,
            "title": chapter.title,
            "logs": rule.js_logs,
        }

    # ------------------------------------------------------------------ #
    @_guard("explore", list)
    def explore(self, url: str) -> list[dict[str, Any]]:
        """发现页：``exploreUrl`` 是 ``标题::url`` 的列表，这里只做单页解析。"""
        text = self._fetch(url)
        rule = self._new_rule(text, url)
        items = rule.get_elements(self._rule("ruleExplore", "bookList"))
        books = []
        for item in items:
            sub = self._new_rule(item, url)
            books.append({
                "name": sub.get_string(self._rule("ruleExplore", "name")),
                "author": sub.get_string(self._rule("ruleExplore", "author")),
                "coverUrl": sub.get_string(self._rule("ruleExplore", "coverUrl"), is_url=True),
                "bookUrl": sub.get_string(self._rule("ruleExplore", "bookUrl"), is_url=True),
                "kind": sub.get_string(self._rule("ruleExplore", "kind")),
                "intro": sub.get_string(self._rule("ruleExplore", "intro")),
            })
        return books


def _apply_content_replace(content: str, rule: str) -> str:
    """正文替换规则：``##正则##替换`` 或 ``##正则``（只删不换）。

    替换串里的 ``$1`` 与书源规则同义（捕获组引用），因此走同一个翻译函数。
    """
    parts = rule.split("##")
    if len(parts) < 2:
        return content
    pattern = parts[1]
    replacement = parts[2] if len(parts) > 2 else ""
    try:
        return re.sub(pattern, java_replacement(replacement), content)
    except re.error:
        return content
