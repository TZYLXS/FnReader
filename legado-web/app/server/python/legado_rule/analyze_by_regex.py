"""正则求值器 —— AnalyzeByRegex.kt 的移植。

规则形如 ``a&&b&&c``：逐级正则，非末级把所有 ``group(0)`` 拼起来喂给下一级，
末级收集 ``0..groupCount`` 的全部分组（``group(0)`` 是整段匹配）。
"""

from __future__ import annotations

import re


def _find_all(pattern: re.Pattern, text: str) -> list[re.Match]:
    """等价于 Java 的 ``while (matcher.find())``，并防止空匹配死循环。"""
    out: list[re.Match] = []
    pos = 0
    n = len(text)
    while pos <= n:
        m = pattern.search(text, pos)
        if not m:
            break
        out.append(m)
        pos = m.end() if m.end() > m.start() else m.end() + 1
    return out


def _groups(matcher: re.Match) -> list[str]:
    info: list[str] = []
    for group_index in range(0, (matcher.re.groups or 0) + 1):
        value = matcher.group(group_index)
        info.append(value if value is not None else "")
    return info


class AnalyzeByRegex:
    @staticmethod
    def get_element(res: str, regs: list[str], index: int = 0) -> list[str] | None:
        if index >= len(regs):
            return None
        try:
            pattern = re.compile(regs[index])
        except re.error:
            return None
        matcher = pattern.search(res)
        if not matcher:
            return None
        if index + 1 == len(regs):
            return _groups(matcher)

        chunks = "".join(m.group(0) for m in _find_all(pattern, res))
        return AnalyzeByRegex.get_element(chunks, regs, index + 1)

    @staticmethod
    def get_elements(res: str, regs: list[str], index: int = 0) -> list[list[str]]:
        if index >= len(regs):
            return []
        try:
            pattern = re.compile(regs[index])
        except re.error:
            return []
        matches = _find_all(pattern, res)
        if not matches:
            return []
        if index + 1 == len(regs):
            return [_groups(m) for m in matches]

        chunks = "".join(m.group(0) for m in matches)
        return AnalyzeByRegex.get_elements(chunks, regs, index + 1)


def split_not_blank(text: str, sep: str) -> list[str]:
    """Kotlin 的 ``splitNotBlank``：切分后丢掉空白段。"""
    return [part for part in (text or "").split(sep) if part.strip()]
