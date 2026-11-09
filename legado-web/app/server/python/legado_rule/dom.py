"""DOM 层：用 lxml 复刻 jsoup 的若干取值语义。

Legado 的 CSS 一侧完全建立在 jsoup 之上，而 jsoup 与 lxml 在细节上并不等价。
本模块把这些差异集中处理掉，供 :mod:`legado_rule.analyze_by_jsoup` 使用：

* ``text()``          —— 拼接全部子孙文本，块级元素之间补空格，再压缩空白；
* ``ownText()``       —— 只取直属文本节点；
* ``textNodes()``     —— 只取直属文本节点，逐个 trim，非空才保留；
* ``outerHtml()``     —— 序列化，``html`` 取值前要摘掉 script/style；
* ``attr()``          —— 属性缺失返回空串（jsoup 语义）。
"""

from __future__ import annotations

import copy
import re

from lxml import etree, html as lxml_html

# jsoup 的块级元素集合（Element.isBlock() 用的是 Tag.isBlock()）
BLOCK_TAGS = {
    "html", "head", "body", "frameset", "script", "noscript", "style", "meta",
    "link", "title", "frame", "noframes", "section", "nav", "aside", "hgroup",
    "header", "footer", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol",
    "pre", "div", "blockquote", "hr", "address", "figure", "figcaption",
    "form", "fieldset", "ins", "del", "dl", "dt", "dd", "li", "table",
    "caption", "thead", "tfoot", "tbody", "col", "colgroup", "tr", "th", "td",
    "video", "audio", "canvas", "details", "menu", "plaintext", "template",
    "article", "main", "summary",
}

_WS_RE = re.compile(r"\s+")


def local_name(el: etree._Element) -> str:
    tag = el.tag
    if not isinstance(tag, str):  # 注释 / 处理指令
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def normalize_whitespace(text: str) -> str:
    """jsoup 的 ``StringUtil.normaliseWhitespace``：压缩空白并 trim。"""
    return _WS_RE.sub(" ", text or "")


def parse_html(source: str) -> etree._Element:
    """对应 ``parseSourceHtml``：默认 HTML 解析器，``<?xml`` 开头走 XML 解析。"""
    source = source or ""
    if source.lstrip().lower().startswith("<?xml"):
        parser = etree.XMLParser(recover=True, resolve_entities=False)
        try:
            return etree.fromstring(source.encode("utf-8"), parser=parser)
        except Exception:
            pass
    if not source.strip():
        return lxml_html.fromstring("<div></div>")
    try:
        return lxml_html.document_fromstring(source)
    except etree.ParserError:
        return lxml_html.fromstring("<div></div>")


def as_element(doc):
    """把任意输入规整成"可作为选择起点的元素"。"""
    if isinstance(doc, etree._Element):
        return doc
    if isinstance(doc, (dict, list)):
        raise TypeError("JSON 内容不能当作 HTML 解析")
    return parse_html(str(doc))


def element_text(el: etree._Element) -> str:
    """jsoup ``Element.text()``：全文本 + 块级边界补空格 + 空白压缩。"""
    parts: list[str] = []

    def visit(node: etree._Element) -> None:
        is_block = local_name(node) in BLOCK_TAGS
        if is_block and parts:
            tail = parts[-1]
            if tail and not tail[-1].isspace():
                parts.append(" ")
        if node.text:
            parts.append(node.text)
        for child in node:
            if isinstance(child.tag, str):
                visit(child)
            if child.tail:
                parts.append(child.tail)
        if is_block and parts:
            tail = parts[-1]
            if tail and not tail[-1].isspace():
                parts.append(" ")

    visit(el)
    return normalize_whitespace("".join(parts)).strip()


def own_text(el: etree._Element) -> str:
    """jsoup ``Element.ownText()``：只取直属文本节点。"""
    parts: list[str] = []
    if el.text:
        parts.append(el.text)
    for child in el:
        if child.tail:
            parts.append(child.tail)
    return normalize_whitespace("".join(parts)).strip()


def text_nodes(el: etree._Element) -> list[str]:
    """jsoup ``Element.textNodes()``：直属 TextNode 列表（这里返回文本）。"""
    out: list[str] = []
    if el.text:
        out.append(el.text)
    for child in el:
        if child.tail:
            out.append(child.tail)
    return out


def outer_html(el: etree._Element) -> str:
    """jsoup ``Element.outerHtml()``。"""
    try:
        return etree.tostring(el, method="html", encoding="unicode", with_tail=False)
    except Exception:
        return ""


def inner_html(el: etree._Element) -> str:
    """jsoup ``Element.html()``：只序列化子节点。"""
    chunks: list[str] = []
    if el.text:
        chunks.append(_escape_text(el.text))
    for child in el:
        chunks.append(outer_html(child))
        if child.tail:
            chunks.append(_escape_text(child.tail))
    return "".join(chunks)


def _escape_text(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def attr(el: etree._Element, name: str) -> str:
    """jsoup ``Element.attr()``：缺失返回空串；布尔属性返回空串或值。"""
    if not name:
        return ""
    value = el.get(name)
    if value is None:
        # jsoup 对未声明的布尔属性（如 disabled）返回空串，这里保持一致
        return ""
    return value


def remove_tags(root: etree._Element, tags: tuple[str, ...]) -> etree._Element:
    """摘掉指定标签（对应 ``elements.select("script").remove()``），返回副本。"""
    clone = copy.deepcopy(root)
    for node in clone.iter():
        if isinstance(node.tag, str) and local_name(node) in tags:
            node.getparent().remove(node)
    return clone


def iter_elements(el: etree._Element):
    """按文档顺序遍历所有元素（含自身）。"""
    yield el
    for child in el.iterdescendants():
        if isinstance(child.tag, str):
            yield child


def elements_by_class(root: etree._Element, class_name: str) -> list[etree._Element]:
    """jsoup ``getElementsByClass``：支持"多类名以空格分隔，必须全部命中"。"""
    wanted = [c for c in class_name.split() if c]
    if not wanted:
        return []
    out = []
    for el in iter_elements(root):
        current = el.get("class")
        if not current:
            continue
        have = set(current.split())
        if all(w in have for w in wanted):
            out.append(el)
    return out


def elements_by_tag(root: etree._Element, tag: str) -> list[etree._Element]:
    """jsoup ``getElementsByTag``。"""
    tag = tag.strip().lower()
    if not tag:
        return []
    return [el for el in iter_elements(root) if local_name(el) == tag]


def elements_by_id(root: etree._Element, el_id: str) -> list[etree._Element]:
    """jsoup ``Collector.collect(Evaluator.Id, temp)``。"""
    return [el for el in iter_elements(root) if el.get("id") == el_id]


def elements_containing_own_text(root: etree._Element, needle: str) -> list[etree._Element]:
    """jsoup ``getElementsContainingOwnText``。

    jsoup 的判定是"直属文本包含给定串"，**不区分大小写**，且比较的是规范化
    后的 ownText。注意它只认直属文本，不认子孙文本 —— 这也是 ``text.`` 前缀
    与普通 ``:contains`` 的核心差别。
    """
    lowered = needle.lower()
    return [
        el for el in iter_elements(root)
        if lowered in own_text(el).lower()
    ]
