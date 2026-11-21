"""目录清洗：去重、过滤非章节、按章节号稳定排序。

与 Node chapter-order.js 的语义对齐，让 Python 引擎直接返回可展示目录，
避免大目录再回到 Node 主线程做重复 CPU 工作。
"""

import re

_CN_DIGITS = {
    "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}
_CHAPTER_RE = re.compile(r"第\s*([零一二三四五六七八九十百千万两\d]+)\s*[章节回卷]")
_LOOKS_CHAPTER_RE = re.compile(r"^\s*第\s*[零一二三四五六七八九十百千万两\d]+\s*[章节回卷]")


def normalize_circled(text):
    chars = []
    for ch in str(text or ""):
        code = ord(ch)
        if 0x2460 <= code <= 0x2473:
            chars.append(str(code - 0x2460 + 1))
        elif 0x3251 <= code <= 0x325F:
            chars.append(str(code - 0x3251 + 21))
        else:
            chars.append(ch)
    return "".join(chars)


def cn_to_number(text):
    total = section = number = 0
    for ch in str(text or ""):
        if ch.isascii() and ch.isdigit():
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


def chapter_number(title):
    match = _CHAPTER_RE.search(normalize_circled(title))
    if not match:
        return 0
    raw = match.group(1)
    return int(raw) if raw.isdigit() else cn_to_number(raw)


def normalize_chapters(chapters):
    if not isinstance(chapters, list) or len(chapters) < 2:
        return chapters if isinstance(chapters, list) else []

    result = []
    seen_url = set()
    seen_title = set()
    for chapter in chapters:
        if not isinstance(chapter, dict):
            continue
        url = str(chapter.get("url") or "").strip()
        title = str(chapter.get("title") or "").strip()
        title_key = re.sub(r"\s+", "", title)
        if url and url in seen_url:
            continue
        if title_key and title_key in seen_title:
            continue
        if url:
            seen_url.add(url)
        if title_key:
            seen_title.add(title_key)
        item = dict(chapter)
        item["title"] = title
        item["url"] = url
        result.append(item)

    standard = sum(1 for c in result if _LOOKS_CHAPTER_RE.match(str(c.get("title") or "")))
    if result and standard >= len(result) * 0.7:
        result = [c for c in result if _LOOKS_CHAPTER_RE.match(str(c.get("title") or ""))]

    numbers = [chapter_number(c.get("title")) for c in result]
    known = sum(1 for n in numbers if n > 0)
    if not result or known < len(result) * 0.6:
        return result
    indexed = list(enumerate(result))
    indexed.sort(key=lambda pair: (numbers[pair[0]] if numbers[pair[0]] > 0 else 2**53 - 1, pair[0]))
    return [chapter for _, chapter in indexed]
