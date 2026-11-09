"""书源规则主入口 —— AnalyzeRule.kt 的移植。

一条规则的生命周期：

1. :meth:`split_source_rule` 按 ``<js>``/``@js:``/``@webjs:`` 切成若干段；
2. 每段交给 :class:`SourceRule` 判定模式、摘出 ``@put``、拆出 ``{{ }}`` 与 ``$n``；
3. :meth:`get_string` / :meth:`get_string_list` / :meth:`get_elements` 逐段求值，
   上一段的结果就是下一段的内容（''链式''）；
4. 每段结束时按 ``##正则##替换##`` 做清洗，``###`` 表示只替换首个匹配。

对外只需要 ``set_content(...)`` + ``get_string/get_string_list/get_elements``。
"""

from __future__ import annotations

import html as html_lib
import json
import re
import urllib.parse
from typing import Any

from . import dom
from .analyze_by_jsoup import AnalyzeByJSoup
from .analyze_by_jsonpath import AnalyzeByJSonPath
from .analyze_by_regex import AnalyzeByRegex, split_not_blank
from .analyze_by_xpath import AnalyzeByXPath
from .js_engine import JsEngine
from .models import BaseSource, Book, BookChapter, RuleData
from .source_rule import Mode, SourceRule, is_json_text

def _to_text(value: Any) -> str:
    """Kotlin ``Any.toString()`` 的对齐版本：布尔小写，其余走 str()。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def java_replacement(replacement: str) -> str:
    """把 Java/Kotlin 风格的替换串翻译成 Python ``re.sub`` 的写法。

    Legado 的 ``##正则##$1###`` 里 ``$1`` 是**捕获组引用**（Kotlin
    ``Regex.replaceFirst(..., replacement)`` 与 Java 同义），而 Python 的
    ``re.sub`` 只认 ``\\1`` / ``\\g<1>``。书源库里 ``##.《([^》]+)》##$1###``
    这类写法非常常见，这里是必须做的翻译。

    ``$0`` → 整个匹配；``$12`` → 第 12 组（最多两位数，与 Java 一致）。
    """
    out: list[str] = []
    i = 0
    n = len(replacement)
    while i < n:
        ch = replacement[i]
        if ch == "\\":
            # Java 替换串里的反斜杠是转义符： ``\\$`` 表示字面 $
            if i + 1 < n:
                nxt = replacement[i + 1]
                if nxt == "$":
                    out.append("$")
                elif nxt == "\\":
                    out.append("\\\\")
                else:
                    out.append(re.escape(nxt))
                i += 2
                continue
            out.append("\\\\")
            i += 1
            continue
        if ch == "$" and i + 1 < n:
            nxt = replacement[i + 1]
            if nxt == "{":
                end = replacement.find("}", i + 2)
                if end != -1:
                    name = replacement[i + 2:end]
                    out.append("\\g<%s>" % name)
                    i = end + 1
                    continue
            elif nxt.isdigit():
                j = i + 1
                while j < n and replacement[j].isdigit():
                    j += 1
                out.append("\\g<%s>" % replacement[i + 1:j])
                i = j
                continue
        out.append(ch.replace("\\", "\\\\"))
        i += 1
    return "".join(out)


PUT_PATTERN = re.compile(r"@put:(\{[^}]+?\})", re.IGNORECASE)
EVAL_PATTERN = re.compile(r"@get:\{[^}]+?\}|\{\{[\s\S]*?\}\}", re.IGNORECASE)
JS_PATTERN = re.compile(r"<js>([\s\S]*?)</js>|@js:([\s\S]*)", re.IGNORECASE)
WEBJS_PATTERN = re.compile(r"@webjs:([\s\S]{5,})", re.IGNORECASE)


class AnalyzeRule:
    def __init__(
        self,
        rule_data: RuleData | None = None,
        source: BaseSource | None = None,
        js_engine: JsEngine | None = None,
        ajax: Any = None,
    ) -> None:
        self.rule_data = rule_data
        self.source = source
        self.book: Book | None = None
        self.chapter: BookChapter | None = None
        self.content: Any = None
        self.base_url: str | None = None
        self.redirect_url: str | None = None
        self.is_json: bool = False
        self.is_regex: bool = False
        self.local_bindings: dict[str, str] = {}
        self.variables: dict[str, str] = {}
        self.is_from_book_info: bool = False
        self.js_logs: list[str] = []
        self.ajax = ajax
        self.js = js_engine or JsEngine(host=self)
        if self.source and getattr(self.source, "js_lib", None):
            self.js.load_lib(self.source.js_lib)

    # ------------------------------------------------------------------ #
    # 内容
    # ------------------------------------------------------------------ #
    def set_content(self, content: Any, base_url: str | None = None) -> "AnalyzeRule":
        if content is None:
            raise AssertionError("内容不可空（Content cannot be null）")
        self.content = content
        self.base_url = base_url
        self.is_json = False if isinstance(content, dom.etree._Element) else (
            isinstance(content, (dict, list)) or is_json_text(str(content))
        )
        self.redirect_url = base_url
        return self

    def set_book(self, book: Book | None) -> "AnalyzeRule":
        self.book = book
        return self

    def set_chapter(self, chapter: BookChapter | None) -> "AnalyzeRule":
        self.chapter = chapter
        return self

    def set_local(self, key: str, value: str) -> "AnalyzeRule":
        self.local_bindings[key] = value
        return self

    # ------------------------------------------------------------------ #
    # 变量
    # ------------------------------------------------------------------ #
    def put(self, key: str, value: str) -> str:
        if self.chapter is not None:
            self.chapter.put_variable(key, value)
        elif self.book is not None:
            self.book.put_variable(key, value)
        elif self.rule_data is not None:
            self.rule_data.put_variable(key, value)
        elif self.source is not None:
            self.source.put(key, value)
        else:
            self.variables[key] = value
        return value

    def get(self, key: str) -> str:
        if key in self.local_bindings:
            return self.local_bindings[key]
        if key == "bookName" and self.book is not None:
            return self.book.name
        if key == "title" and self.chapter is not None:
            return self.chapter.title
        for holder in (self.chapter, self.book, self.rule_data, self.source):
            if holder is None:
                continue
            value = holder.get_variable(key)
            if value:
                return value
        return self.variables.get(key, "") or ""

    # ------------------------------------------------------------------ #
    # 规则切分
    # ------------------------------------------------------------------ #
    def split_source_rule(self, rule_str: str | None, all_in_one: bool = False) -> list[SourceRule]:
        if not rule_str:
            return []
        rule_list: list[SourceRule] = []
        mode = Mode.DEFAULT
        start = 0
        # 仅首字符为 : 时视为"整条正则"（: 与 CSS 伪类冲突，Legado 自己也吐槽过）
        if all_in_one and rule_str.startswith(":"):
            mode = Mode.REGEX
            self.is_regex = True
            start = 1
        elif self.is_regex:
            mode = Mode.REGEX

        for m in JS_PATTERN.finditer(rule_str):
            if m.start() > start:
                tmp = rule_str[start:m.start()].strip()
                if tmp:
                    rule_list.append(SourceRule(tmp, mode, self))
            payload = m.group(2) if m.group(2) is not None else (m.group(1) or "")
            rule_list.append(SourceRule(payload, Mode.JS, self))
            start = m.end()

        for m in WEBJS_PATTERN.finditer(rule_str):
            if m.start() > start:
                tmp = rule_str[start:m.start()].strip()
                if tmp:
                    rule_list.append(SourceRule(tmp, mode, self))
            rule_list.append(SourceRule(m.group(1) or "", Mode.WEBJS, self))
            start = m.end()

        if len(rule_str) > start:
            tmp = rule_str[start:].strip()
            if tmp:
                rule_list.append(SourceRule(tmp, mode, self))
        return rule_list

    # ------------------------------------------------------------------ #
    # 取字符串
    # ------------------------------------------------------------------ #
    def get_string(
        self,
        rule_str: str | None = None,
        m_content: Any = None,
        is_url: bool = False,
        unescape: bool = True,
    ) -> str:
        if not rule_str:
            return ""
        return self.get_string_rules(
            self.split_source_rule(rule_str), m_content, is_url, unescape
        )

    def get_string_rules(
        self,
        rule_list: list[SourceRule],
        m_content: Any = None,
        is_url: bool = False,
        unescape: bool = True,
    ) -> str:
        result: Any = None
        content = m_content if m_content is not None else self.content
        if content is not None and rule_list:

            if isinstance(content, dict):
                # NativeObject 分支：直接按键取值，不再走选择器
                source_rule = rule_list[0]
                self._put_rule(source_rule.put_map)
                source_rule.make_up_rule(content)
                if source_rule.mode == Mode.JS:
                    result = self.eval_js(source_rule.rule, content)
                elif source_rule.mode == Mode.JSON:
                    result = AnalyzeByJSonPath(content).get_string(source_rule.rule)
                elif source_rule.get_param_size() > 1:
                    result = source_rule.rule
                else:
                    result = content.get(source_rule.rule)
                if result is not None:
                    result = self.replace_regex(str(result), source_rule)
            else:
                result = content
                for source_rule in rule_list:
                    self._put_rule(source_rule.put_map)
                    source_rule.make_up_rule(result)
                    if result is None:
                        continue
                    rule = source_rule.rule
                    if rule.strip() or not source_rule.replace_regex:
                        result = self._dispatch_string(source_rule, rule, result, is_url)
                    if result is not None and source_rule.replace_regex:
                        result = self.replace_regex(str(result), source_rule)

        if result is None:
            result = ""
        result_str = _to_text(result)
        text = html_lib.unescape(result_str) if (unescape and "&" in result_str) else result_str
        if is_url:
            if not text.strip():
                return self.base_url or ""
            return self.get_absolute_url(text)
        return text

    def _dispatch_string(self, source_rule: SourceRule, rule: str, result: Any, is_url: bool) -> Any:
        mode = source_rule.mode
        if mode == Mode.WEBJS:
            return self.get_web_js_result(rule, result)
        if mode == Mode.JS:
            return self.eval_js(rule, result)
        if mode == Mode.JSON:
            return AnalyzeByJSonPath(result).get_string(rule)
        if mode == Mode.XPATH:
            return AnalyzeByXPath(result).get_string(rule)
        if mode == Mode.DEFAULT:
            parser = AnalyzeByJSoup(result)
            return parser.get_string0(rule) if is_url else parser.get_string(rule)
        if mode == Mode.REGEX:
            values = AnalyzeByRegex.get_element(str(result), split_not_blank(rule, "&&"))
            return "\n".join(values) if values else ""
        return rule

    # ------------------------------------------------------------------ #
    # 取列表
    # ------------------------------------------------------------------ #
    def get_string_list(
        self,
        rule_str: str | None = None,
        m_content: Any = None,
        is_url: bool = False,
    ) -> list[str] | None:
        if not rule_str:
            return None
        return self.get_string_list_rules(
            self.split_source_rule(rule_str), m_content, is_url
        )

    def get_string_list_rules(
        self,
        rule_list: list[SourceRule],
        m_content: Any = None,
        is_url: bool = False,
    ) -> list[str] | None:
        result: Any = None
        content = m_content if m_content is not None else self.content
        if content is not None and rule_list:

            if isinstance(content, dict):
                source_rule = rule_list[0]
                self._put_rule(source_rule.put_map)
                source_rule.make_up_rule(content)
                if source_rule.mode == Mode.JS:
                    result = self.eval_js(source_rule.rule, content)
                elif source_rule.mode == Mode.JSON:
                    result = AnalyzeByJSonPath(content).get_string_list(source_rule.rule)
                elif source_rule.get_param_size() > 1:
                    result = source_rule.rule
                else:
                    result = content.get(source_rule.rule)
                if result is not None:
                    if source_rule.replace_regex and isinstance(result, list):
                        result = [self.replace_regex(str(o), source_rule) for o in result]
                    elif source_rule.replace_regex:
                        result = self.replace_regex(str(result), source_rule)
            else:
                result = content
                for source_rule in rule_list:
                    self._put_rule(source_rule.put_map)
                    source_rule.make_up_rule(result)
                    if result is None:
                        continue
                    rule = source_rule.rule
                    if rule:
                        result = self._dispatch_list(source_rule, rule, result)
                    if source_rule.replace_regex and isinstance(result, list):
                        result = [self.replace_regex(str(item), source_rule) for item in result]
                    elif source_rule.replace_regex:
                        result = self.replace_regex(str(result), source_rule)

        if result is None:
            return None
        if isinstance(result, str):
            result = result.split("\n")
        if is_url:
            url_list: list[str] = []
            for url in result if isinstance(result, list) else []:
                absolute = self.get_absolute_url(str(url))
                if absolute and absolute not in url_list:
                    url_list.append(absolute)
            return url_list
        return [str(item) for item in result] if isinstance(result, list) else None

    def _dispatch_list(self, source_rule: SourceRule, rule: str, result: Any) -> Any:
        mode = source_rule.mode
        if mode == Mode.WEBJS:
            return self.get_web_js_result(rule, result)
        if mode == Mode.JS:
            return self.eval_js(rule, result)
        if mode == Mode.JSON:
            return AnalyzeByJSonPath(result).get_string_list(rule)
        if mode == Mode.XPATH:
            return AnalyzeByXPath(result).get_string_list(rule)
        if mode == Mode.DEFAULT:
            return AnalyzeByJSoup(result).get_string_list(rule)
        if mode == Mode.REGEX:
            values = AnalyzeByRegex.get_element(str(result), split_not_blank(rule, "&&"))
            return values or []
        return rule

    # ------------------------------------------------------------------ #
    # 取元素
    # ------------------------------------------------------------------ #
    def get_elements(self, rule_str: str) -> list[Any]:
        if not rule_str:
            return []
        result: Any = None
        content = self.content
        rule_list = self.split_source_rule(rule_str, True)
        if content is not None and rule_list:
            result = content
            for source_rule in rule_list:
                self._put_rule(source_rule.put_map)
                if result is None:
                    continue
                rule = source_rule.rule
                mode = source_rule.mode
                if mode == Mode.REGEX:
                    result = AnalyzeByRegex.get_elements(
                        str(result), split_not_blank(rule, "&&")
                    )
                elif mode == Mode.WEBJS:
                    result = self.get_web_js_result(rule, result)
                elif mode == Mode.JS:
                    result = self.eval_js(rule, result)
                elif mode == Mode.JSON:
                    result = AnalyzeByJSonPath(result).get_list(rule)
                elif mode == Mode.XPATH:
                    result = AnalyzeByXPath(result).get_elements(rule)
                else:
                    result = AnalyzeByJSoup(result).get_elements(rule)

        if isinstance(result, list):
            return [item for item in result if item is not None]
        return []

    # ------------------------------------------------------------------ #
    # 替换
    # ------------------------------------------------------------------ #
    def replace_regex(self, result: str, rule: SourceRule) -> str:
        if not rule.replace_regex:
            return result
        try:
            pattern = re.compile(rule.replace_regex, re.MULTILINE)
        except re.error:
            pattern = None

        translation = java_replacement(rule.replacement)

        if rule.replace_first:
            # ##match##replace### —— 只对"第一个匹配到的片段"做替换
            if pattern is not None:
                matcher = pattern.search(result)
                if matcher:
                    piece = matcher.group(0)
                    try:
                        return pattern.sub(translation, piece, count=1)
                    except re.error:
                        return rule.replacement
                return ""
            return rule.replacement

        if pattern is not None:
            try:
                return pattern.sub(translation, result)
            except re.error:
                return rule.replacement
        return result.replace(rule.replace_regex, rule.replacement)

    # ------------------------------------------------------------------ #
    # JS
    # ------------------------------------------------------------------ #
    def eval_js(self, js_str: str, result: Any = None) -> Any:
        bindings = {
            "source": self.source.vars if self.source else None,
            "book": self.book.vars if self.book else None,
            "chapter": self.chapter.vars if self.chapter else None,
            "result": result,
            "baseUrl": self.base_url,
            "src": self.content,
            "title": self.chapter.title if self.chapter else None,
            "fromBookInfo": self.is_from_book_info,
            "nextChapterUrl": None,
        }
        for key, value in self.local_bindings.items():
            if key == "page":
                try:
                    bindings[key] = int(value)
                except (TypeError, ValueError):
                    bindings[key] = value
            else:
                bindings[key] = value
        return self.js.eval(js_str, bindings)

    # JS 侧 java.* 的回调
    def js_get_string(self, rule: str, m_content: Any = None, is_url: bool = False) -> str:
        """对应 Kotlin ``java.getString(rule, mContent?, isUrl?)``。

        ``m_content`` 用于"对另一段内容取规则"（如 ``java.ajax`` 的结果），
        不传则沿用当前内容。
        """
        return self.get_string(rule, m_content=m_content, is_url=is_url)

    def js_get_string_list(self, rule: str, m_content: Any = None) -> list[str]:
        return self.get_string_list(rule, m_content=m_content) or []

    def js_get_elements(self, rule: str) -> list[Any]:
        return [self._element_to_text(el) for el in self.get_elements(rule)]

    @staticmethod
    def _element_to_text(el: Any) -> Any:
        if isinstance(el, dom.etree._Element):
            return dom.outer_html(el)
        return el

    def js_put(self, key: str, value: str) -> str:
        return self.put(key, value)

    def js_get(self, key: str) -> str:
        return self.get(key)

    def js_log(self, message: str) -> None:
        self.js_logs.append(str(message))

    def js_ajax(self, url: str) -> str:
        if self.ajax is None:
            return ""
        try:
            return self.ajax(url)
        except Exception:
            return ""

    # ------------------------------------------------------------------ #
    # 工具
    # ------------------------------------------------------------------ #
    def get_web_js_result(self, rule: str, result: Any = None) -> str:
        """``@webjs:`` 需要在真实浏览器里执行，纯 Python 侧不支持。"""
        self.js_logs.append("[webjs] 需要浏览器环境，已跳过")
        return ""

    def get_absolute_url(self, url: str) -> str:
        base = self.redirect_url or self.base_url or ""
        if not url:
            return url
        if url.startswith("//"):
            scheme = urllib.parse.urlparse(base).scheme or "https"
            return scheme + ":" + url
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
            return url
        if not base:
            return url
        return urllib.parse.urljoin(base, url)

    def _put_rule(self, put_map: dict[str, str]) -> None:
        for key, value in put_map.items():
            self.put(key, self.get_string(value))
