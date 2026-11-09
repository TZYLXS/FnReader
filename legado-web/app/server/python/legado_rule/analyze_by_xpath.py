"""XPath 求值器 —— AnalyzeByXPath.kt 的移植。

底层能力用 lxml 的 XPath 1.0（libxml2），比 Legado 依赖的 JsoupXpath 更完整。
取值语义按 JsoupXpath 的 ``JXNode.asString()`` 对齐：

* 元素节点   → ``outerHtml``（JsoupXpath 里就是 ``Element.toString()``）
* 文本节点   → 该节点的文本，**规范化空白并 trim**（JsoupXpath 把它包成
  ``JX_TEXT`` 伪元素，取的是 ``ownText()``）
* 属性节点   → 属性值原样返回
* 数字/布尔  → ``String.valueOf`` 风格（``2.0`` 保留小数点、``true`` 小写）

另外移植了 ``strToJXDocument`` 的三段包裹逻辑：文档以 ``</td>`` 结尾时包一层
``<tr>``，以 ``</tr>``/``</tbody>`` 结尾时再包一层 ``<table>``，否则 XPath 无法
在片段上定位。
"""

from __future__ import annotations

from typing import Any

from lxml import etree

from . import dom
from .rule_analyzer import RuleAnalyzer


class AnalyzeByXPath:
    def __init__(self, doc: Any) -> None:
        self.roots: list[etree._Element] = self._parse(doc)

    # ------------------------------------------------------------------ #
    @staticmethod
    def _parse(doc: Any) -> list[etree._Element]:
        if isinstance(doc, AnalyzeByXPath):
            return doc.roots
        if isinstance(doc, etree._Element):
            return [doc]
        if isinstance(doc, list):
            roots: list[etree._Element] = []
            for item in doc:
                if isinstance(item, etree._Element):
                    roots.append(item)
                elif item is None:
                    continue
                else:
                    roots.extend(AnalyzeByXPath._parse(str(item)))
            return roots
        return [AnalyzeByXPath._str_to_doc(str(doc))]

    @staticmethod
    def _str_to_doc(html: str) -> etree._Element:
        text = html
        if text.endswith("</td>"):
            text = "<tr>" + text + "</tr>"
        if text.endswith("</tr>") or text.endswith("</tbody>"):
            text = "<table>" + text + "</table>"
        return dom.parse_html(text)

    # ------------------------------------------------------------------ #
    def _get_result(self, path: str) -> list[Any]:
        out: list[Any] = []
        for root in self.roots:
            try:
                values = root.xpath(path)
            except Exception:
                continue
            if not isinstance(values, list):
                values = [values]
            out.extend(values)
        return out

    def get_elements(self, xpath: str) -> list[Any] | None:
        if not xpath:
            return None
        analyzer = RuleAnalyzer(xpath)
        rules = analyzer.split_rule("&&", "||", "%%")

        if len(rules) == 1:
            return self._get_result(rules[0])

        results: list[list[Any]] = []
        for rl in rules:
            temp = self.get_elements(rl)
            if temp:
                results.append(temp)
                if analyzer.elements_type == "||":
                    break
        merged: list[Any] = []
        if results:
            if analyzer.elements_type == "%%":
                for i in range(len(results[0])):
                    for temp in results:
                        if i < len(temp):
                            merged.append(temp[i])
            else:
                for temp in results:
                    merged.extend(temp)
        return merged

    def get_string_list(self, xpath: str) -> list[str]:
        result: list[str] = []
        analyzer = RuleAnalyzer(xpath)
        rules = analyzer.split_rule("&&", "||", "%%")

        if len(rules) == 1:
            for node in self._get_result(xpath):
                result.append(_as_string(node))
            return result

        results: list[list[str]] = []
        for rl in rules:
            temp = self.get_string_list(rl)
            if temp:
                results.append(temp)
                if analyzer.elements_type == "||":
                    break
        if results:
            if analyzer.elements_type == "%%":
                for i in range(len(results[0])):
                    for temp in results:
                        if i < len(temp):
                            result.append(temp[i])
            else:
                for temp in results:
                    result.extend(temp)
        return result

    def get_string(self, rule: str) -> str | None:
        """注意：Kotlin 这里只切 ``&&``/``||``，不切 ``%%``，结果用 ``\\n`` 连接。"""
        analyzer = RuleAnalyzer(rule)
        rules = analyzer.split_rule("&&", "||")
        if len(rules) == 1:
            nodes = self._get_result(rule)
            if nodes is None:
                return None
            return "\n".join(_as_string(n) for n in nodes)

        text_list: list[str] = []
        for rl in rules:
            temp = self.get_string(rl)
            if temp:
                text_list.append(temp)
                if analyzer.elements_type == "||":
                    break
        return "\n".join(text_list)


def _as_string(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, etree._Element):
        if not isinstance(node.tag, str):
            # 注释 / 处理指令
            return node.text or ""
        return dom.outer_html(node)
    if isinstance(node, bool):
        return "true" if node else "false"
    if isinstance(node, float):
        # Java String.valueOf(2.0) == "2.0"
        return repr(node) if node != int(node) else f"{node:.1f}"
    if isinstance(node, int):
        return str(node)
    if isinstance(node, str):
        # lxml 的 _ElementUnicodeResult 会带上来源信息：属性节点不规范化，
        # 文本节点按 JsoupXpath 的 ownText() 语义规范化。
        if getattr(node, "is_attribute", False):
            return str(node)
        if getattr(node, "is_text", False) or getattr(node, "is_tail", False):
            return dom.normalize_whitespace(str(node)).strip()
        return str(node)
    return str(node)
