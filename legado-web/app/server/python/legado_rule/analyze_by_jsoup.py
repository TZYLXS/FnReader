"""CSS/DOM 求值器 —— AnalyzeByJSoup.kt 的移植。

这个类是整个书源引擎里最"有性格"的一层，要点：

1. ``@CSS:`` 与普通 CSS 走两套完全不同的路径。
   普通路径先把 ``&&``/``||``/``%%`` 切开，再对每段用 ``@`` 切链，
   末段是"取值方式"（text/textNodes/ownText/html/all/属性名）；
   ``@CSS:`` 路径则用 ``lastIndexOf('@')`` 把整段切成"选择器 + 取值方式"，
   中间**不做链式切分**（因为选择器里可能含 ``@`` 之外的点、冒号）。
2. 索引有新旧两套语法，且两套的解析方向相反（都是逆序扫描、逆序入栈，
   再逆序展开以还原书写顺序），负数索引统一 ``+len``，排除式用 ``!``。
3. 尾缀 ``attr`` 取值会自动去重（jsoup 侧的历史行为）。
"""

from __future__ import annotations

from typing import Any

from lxml import etree

from . import css, dom
from .rule_analyzer import RuleAnalyzer


class AnalyzeByJSoup:
    def __init__(self, doc: Any) -> None:
        self.element: etree._Element = self._parse(doc)

    # ------------------------------------------------------------------ #
    # 解析入口
    # ------------------------------------------------------------------ #
    @staticmethod
    def _parse(doc: Any) -> etree._Element:
        if isinstance(doc, etree._Element):
            return doc
        if isinstance(doc, str) and doc.lstrip().lower().startswith("<?xml"):
            from lxml import etree as _etree
            parser = _etree.XMLParser(recover=True, resolve_entities=False)
            try:
                return _etree.fromstring(doc.encode("utf-8"), parser=parser)
            except Exception:
                pass
        return dom.parse_html(str(doc))

    # ------------------------------------------------------------------ #
    # 对外接口
    # ------------------------------------------------------------------ #
    def get_elements(self, rule: str) -> list[etree._Element]:
        return self._get_elements(self.element, rule)

    def get_string(self, rule_str: str) -> str | None:
        """多个元素的结果用 ``\\n`` 拼起来；一条都没命中返回 None。"""
        if not rule_str:
            return None
        result = self.get_string_list(rule_str)
        if not result:
            return None
        if len(result) == 1:
            return result[0]
        return "\n".join(result)

    def get_string0(self, rule_str: str) -> str:
        """URL 规则用：只取第一条，不拼接。"""
        result = self.get_string_list(rule_str)
        return result[0] if result else ""

    def get_string_list(self, rule_str: str) -> list[str]:
        text_s: list[str] = []
        if not rule_str:
            return text_s

        source_rule = SourceRule(rule_str)
        if not source_rule.elements_rule:
            text_s.append(self._data(self.element))
            return text_s

        analyzer = RuleAnalyzer(source_rule.elements_rule)
        rule_strs = analyzer.split_rule("&&", "||", "%%")

        results: list[list[str]] = []
        for rule_str_x in rule_strs:
            if source_rule.is_css:
                last_index = rule_str_x.rfind("@")
                if last_index == -1:
                    # Kotlin 这里 take(-1) 会抛异常，实际书源几乎不会出现；
                    # 这里退化为"整段都是选择器 + 空取值方式"。
                    selector, getter = rule_str_x, ""
                else:
                    selector, getter = rule_str_x[:last_index], rule_str_x[last_index + 1:]
                temp = self._get_result_last(css.select(self.element, selector), getter)
            else:
                temp = self._get_result_list(rule_str_x)

            if temp:
                results.append(temp)
                if analyzer.elements_type == "||":
                    break

        if results:
            if analyzer.elements_type == "%%":
                for i in range(len(results[0])):
                    for temp in results:
                        if i < len(temp):
                            text_s.append(temp[i])
            else:
                for temp in results:
                    text_s.extend(temp)
        return text_s

    # ------------------------------------------------------------------ #
    # 链式选择
    # ------------------------------------------------------------------ #
    def _get_elements(self, temp: etree._Element | None, rule: str) -> list[etree._Element]:
        if temp is None or not rule:
            return []

        source_rule = SourceRule(rule)
        analyzer = RuleAnalyzer(source_rule.elements_rule)
        rule_strs = analyzer.split_rule("&&", "||", "%%")

        elements_list: list[list[etree._Element]] = []
        if source_rule.is_css:
            for rule_str in rule_strs:
                temp_s = css.select(temp, rule_str)
                elements_list.append(temp_s)
                if temp_s and analyzer.elements_type == "||":
                    break
        else:
            for rule_str in rule_strs:
                rs_rule = RuleAnalyzer(rule_str)
                rs_rule.trim()
                rs = rs_rule.split_rule("@")

                if len(rs) > 1:
                    el: list[etree._Element] = [temp]
                    for rl in rs:
                        es: list[etree._Element] = []
                        for et in el:
                            es.extend(self._get_elements(et, rl))
                        el = es
                else:
                    el = ElementsSingle().get_elements_single(temp, rule_str)

                elements_list.append(el)
                if el and analyzer.elements_type == "||":
                    break

        out: list[etree._Element] = []
        if elements_list:
            if analyzer.elements_type == "%%":
                for i in range(len(elements_list[0])):
                    for es in elements_list:
                        if i < len(es):
                            out.append(es[i])
            else:
                for es in elements_list:
                    out.extend(es)
        return out

    def _get_result_list(self, rule_str: str) -> list[str] | None:
        if not rule_str:
            return None
        elements: list[etree._Element] = [self.element]
        rule = RuleAnalyzer(rule_str)
        rule.trim()
        rules = rule.split_rule("@")

        last = len(rules) - 1
        for i in range(last):
            es: list[etree._Element] = []
            for elt in elements:
                es.extend(ElementsSingle().get_elements_single(elt, rules[i]))
            elements = es
        if not elements:
            return None
        return self._get_result_last(elements, rules[last])

    # ------------------------------------------------------------------ #
    # 尾缀取值
    # ------------------------------------------------------------------ #
    def _get_result_last(self, elements: list[etree._Element], last_rule: str) -> list[str]:
        text_s: list[str] = []
        if last_rule == "text":
            for element in elements:
                text = dom.element_text(element)
                if text:
                    text_s.append(text)
        elif last_rule == "textNodes":
            for element in elements:
                tn: list[str] = []
                for item in dom.text_nodes(element):
                    text = (item or "").strip()
                    if text:
                        tn.append(text)
                if tn:
                    text_s.append("\n".join(tn))
        elif last_rule == "ownText":
            for element in elements:
                text = dom.own_text(element)
                if text:
                    text_s.append(text)
        elif last_rule == "html":
            # 注意：Kotlin 里 select("script").remove() 会真的改掉 DOM，
            # 这里改为在副本上摘除，避免污染后续规则。
            for element in elements:
                clone = dom.remove_tags(element, ("script", "style"))
                html = dom.outer_html(clone)
                if html:
                    text_s.append(html)
        elif last_rule == "all":
            text_s.append("".join(dom.outer_html(e) for e in elements))
        else:
            for element in elements:
                url = dom.attr(element, last_rule)
                if not url.strip() or url in text_s:
                    continue
                text_s.append(url)
        return text_s

    @staticmethod
    def _data(el: etree._Element) -> str:
        """jsoup ``Element.data()``：script/style 的原始内容，其余为空串。"""
        if dom.local_name(el) in ("script", "style"):
            return el.text or ""
        return ""


# ---------------------------------------------------------------------- #
# 索引处理器
# ---------------------------------------------------------------------- #
class ElementsSingle:
    """把 ``tag.div.-1:10:2`` / ``tag.a[!0,-1]`` 这类规则作用到一棵子树上。

    对应 Kotlin 的 ``data class ElementsSingle``。索引集合是"逆序插入、逆序
    展开"的，因为扫描是从字符串尾部往前的。
    """

    def __init__(self) -> None:
        self.split: str = "."
        self.before_rule: str = ""
        self.index_default: list[int] = []
        self.indexes: list[Any] = []

    # ------------------------------------------------------------------ #
    def get_elements_single(
        self, temp: etree._Element, rule: str
    ) -> list[etree._Element]:
        self.find_index_set(rule)

        if not self.before_rule:
            elements = list(temp)
        else:
            rules = self.before_rule.split(".")
            head = rules[0]
            arg = rules[1] if len(rules) > 1 else ""
            if head == "children":
                elements = list(temp)
            elif head == "class":
                elements = dom.elements_by_class(temp, arg)
            elif head == "tag":
                elements = dom.elements_by_tag(temp, arg)
            elif head == "id":
                elements = dom.elements_by_id(temp, arg)
            elif head == "text":
                elements = dom.elements_containing_own_text(temp, arg)
            else:
                elements = css.select(temp, self.before_rule)

        length = len(elements)
        if self.index_default:
            last_indexes = len(self.index_default) - 1
        else:
            last_indexes = len(self.indexes) - 1

        index_set: list[int] = []
        seen: set[int] = set()

        def add(value: int) -> None:
            if value not in seen:
                seen.add(value)
                index_set.append(value)

        if not self.indexes:
            for ix in range(last_indexes, -1, -1):
                it = self.index_default[ix]
                if 0 <= it < length:
                    add(it)
                elif it < 0 and length >= -it:
                    add(it + length)
        else:
            for ix in range(last_indexes, -1, -1):
                item = self.indexes[ix]
                if isinstance(item, tuple):
                    start_x, end_x, step_x = item
                    start = 0 if start_x is None else start_x
                    if start < 0:
                        start += length
                    end = (length - 1) if end_x is None else end_x
                    if end < 0:
                        end += length

                    if (start < 0 and end < 0) or (start >= length and end >= length):
                        continue

                    if start >= length:
                        start = length - 1
                    elif start < 0:
                        start = 0
                    if end >= length:
                        end = length - 1
                    elif end < 0:
                        end = 0

                    if start == end or step_x >= length:
                        add(start)
                        continue

                    if step_x > 0:
                        step = step_x
                    elif -step_x < length:
                        step = step_x + length
                    else:
                        step = 1
                    if step <= 0:
                        step = 1

                    if end > start:
                        values = list(range(start, end + 1, step))
                    else:
                        values = list(range(start, end - 1, -step))
                    for v in values:
                        add(v)
                else:
                    it = item
                    if 0 <= it < length:
                        add(it)
                    elif it < 0 and length >= -it:
                        add(it + length)

        if self.split == "!":
            for pc_int in sorted(index_set, reverse=True):
                if 0 <= pc_int < len(elements):
                    del elements[pc_int]
        elif self.split == ".":
            elements = [elements[pc_int] for pc_int in index_set]

        return elements

    # ------------------------------------------------------------------ #
    # 索引串解析（严格按 Kotlin 的逆序扫描移植）
    # ------------------------------------------------------------------ #
    def find_index_set(self, rule: str) -> None:
        rus = (rule or "").strip()
        if not rus:
            self.split = " "
            self.before_rule = rus
            return

        length = len(rus)
        cur_int: int | None = None
        cur_minus = False
        cur_list: list[int | None] = []
        l = ""
        head = rus[-1] == "]"

        if head:
            i = length - 1  # 指向 ']'
            while True:
                i -= 1
                if i < 0:
                    break
                rl = rus[i]
                if rl == " ":
                    continue

                if "0" <= rl <= "9":
                    l = rl + l
                    continue
                if rl == "-":
                    cur_minus = True
                    continue

                cur_int = None if not l else (-int(l) if cur_minus else int(l))
                if rl == ":":
                    cur_list.append(cur_int)
                else:
                    if not cur_list:
                        if cur_int is None:
                            break
                        self.indexes.append(cur_int)
                    else:
                        self.indexes.append(
                            (
                                cur_int,
                                cur_list[-1],
                                cur_list[0] if len(cur_list) == 2 else 1,
                            )
                        )
                        cur_list.clear()

                    if rl == "!":
                        self.split = "!"
                        while True:
                            i -= 1
                            if i < 0:
                                break
                            rl = rus[i]
                            if not (i > 0 and rl == " "):
                                break

                    if rl == "[":
                        self.before_rule = rus[:i]
                        return
                    if rl != ",":
                        break
                l = ""
                cur_minus = False
        else:
            i = length
            while True:
                i -= 1
                if i < 0:
                    break
                rl = rus[i]
                if rl == " ":
                    continue

                if "0" <= rl <= "9":
                    l = rl + l
                    continue
                if rl == "-":
                    cur_minus = True
                    continue

                if rl in ("!", ".", ":"):
                    self.index_default.append(
                        (-int(l) if cur_minus else int(l)) if l else 0
                    )
                    if rl != ":":
                        self.split = rl
                        self.before_rule = rus[:i]
                        return
                else:
                    break
                l = ""
                cur_minus = False

        self.split = " "
        self.before_rule = rus


# AnalyzeByJSoup 内部的 SourceRule（只管 @CSS: 识别，别和外层同名类混淆）
class SourceRule:
    def __init__(self, rule_str: str) -> None:
        self.is_css = False
        if rule_str.lower().startswith("@css:"):
            self.is_css = True
            self.elements_rule = rule_str[5:].strip()
        else:
            self.elements_rule = rule_str
