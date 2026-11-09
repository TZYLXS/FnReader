"""CSS 选择器执行层。

Legado 用的是 jsoup 的选择器引擎，它支持一部分 CSS4 语法以及若干自有的
伪类（``:contains``、``:containsOwn``、``:matches``、``:has``、``:eq``、
``:lt``、``:gt``）。Python 侧主引擎用 ``cssselect`` 翻译成 XPath，遇到
cssselect 不认的 jsoup 伪类再退化成"先选基集，再在 Python 里过滤"。

已知差异（写进实现说明的"限制"一节）：
* jsoup 的 ``:contains`` 不区分大小写；cssselect 无此伪类，走退化路径。
* jsoup 支持 ``:nth-child(an+b)``、``:not(...)``、属性正则 ``[attr~=regex]``，
  cssselect 对前两者支持、对 ``[attr~=regex]`` 不支持（退化处理）。
"""

from __future__ import annotations

import re

from lxml import etree
from lxml.cssselect import CSSSelector

from . import dom

_JS0UP_PSEUDO = (
    "contains",
    "containsown",
    "containsdata",
    "matches",
    "matchesown",
    "has",
    "eq",
    "lt",
    "gt",
    "not",
    "first",
    "last",
)


def select(root: etree._Element, selector: str) -> list[etree._Element]:
    """等价于 jsoup 的 ``Element.select(selector)``（含自身命中）。"""
    selector = (selector or "").strip()
    if not selector:
        return []
    try:
        path = CSSSelector(selector)
        result = root.xpath(path.path)
        return [el for el in result if isinstance(el.tag, str)]
    except Exception:
        pass
    return _select_with_jsoup_pseudos(root, selector)


# ---------------------------------------------------------------------- #
# jsoup 专有伪类的退化处理
# ---------------------------------------------------------------------- #
def _find_last_pseudo(selector: str) -> tuple[int, int] | None:
    """找出最后一个"顶层"伪类的位置，返回 (冒号位置, 参数右括号位置或 -1)。"""
    depth_bracket = 0
    depth_paren = 0
    in_quote: str | None = None
    candidates: list[tuple[int, int]] = []
    i = 0
    n = len(selector)
    while i < n:
        ch = selector[i]
        if in_quote:
            if ch == "\\":
                i += 2
                continue
            if ch == in_quote:
                in_quote = None
            i += 1
            continue
        if ch in "\"'":
            in_quote = ch
            i += 1
            continue
        if ch == "[":
            depth_bracket += 1
        elif ch == "]":
            depth_bracket -= 1
        elif ch == "(":
            depth_paren += 1
        elif ch == ")":
            depth_paren -= 1
        elif ch == ":" and depth_bracket == 0 and depth_paren == 0:
            name_start = i + 1
            j = name_start
            while j < n and (selector[j].isalnum() or selector[j] in "-_"):
                j += 1
            if j > name_start and selector[name_start:j].lower() in _JS0UP_PSEUDO:
                if j < n and selector[j] == "(":
                    close = _matching_paren(selector, j)
                    candidates.append((i, close))
                    i = (close + 1) if close >= 0 else j
                    continue
                candidates.append((i, -1))
        i += 1
    if not candidates:
        return None
    return candidates[-1]


def _matching_paren(text: str, open_idx: int) -> int:
    depth = 0
    in_quote: str | None = None
    for i in range(open_idx, len(text)):
        ch = text[i]
        if in_quote:
            if ch == "\\":
                continue
            if ch == in_quote:
                in_quote = None
            continue
        if ch in "\"'":
            in_quote = ch
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _select_with_jsoup_pseudos(root: etree._Element, selector: str):
    pos = _find_last_pseudo(selector)
    if pos is None:
        # 完全没有可识别的伪类，说明是别的语法问题，交给空结果兜底
        return []
    colon, close = pos
    base = selector[:colon].strip()
    if close >= 0:
        name = re.match(r":([\w-]+)", selector[colon:]).group(1).lower()
        arg = selector[colon + len(name) + 2:close]
    else:
        name = selector[colon + 1:].lower()
        arg = ""

    base_list = select(root, base) if base else [root]

    if name == "contains":
        return [el for el in base_list if arg.lower() in dom.element_text(el).lower()]
    if name == "containsown":
        return [el for el in base_list if arg.lower() in dom.own_text(el).lower()]
    if name == "containsdata":
        return [el for el in base_list if arg.lower() in (el.text or "").lower()]
    if name == "matches":
        try:
            pattern = re.compile(arg, re.DOTALL)
        except re.error:
            return []
        return [el for el in base_list if pattern.search(dom.element_text(el))]
    if name == "matchesown":
        try:
            pattern = re.compile(arg, re.DOTALL)
        except re.error:
            return []
        return [el for el in base_list if pattern.search(dom.own_text(el))]
    if name == "has":
        return [el for el in base_list if select(el, arg)]
    if name == "not":
        excluded = {id(el) for el in select(root, arg)}
        return [el for el in base_list if id(el) not in excluded]
    if name in ("eq", "lt", "gt"):
        try:
            index = int(arg)
        except ValueError:
            return base_list
        if index < 0:
            index += len(base_list)
        if name == "eq":
            return base_list[index:index + 1] if 0 <= index < len(base_list) else []
        if name == "lt":
            return base_list[:max(index, 0)]
        return base_list[index + 1:]
    if name == "first":
        return base_list[:1]
    if name == "last":
        return base_list[-1:]
    return []
