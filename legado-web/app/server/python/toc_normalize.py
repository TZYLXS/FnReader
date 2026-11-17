#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Python 侧目录清洗：与 Node chapter-order.js 保持同一契约。"""
from __future__ import annotations

import re
from typing import Any

_CN_DIGITS = str.maketrans("", "")
CN_DIGITS = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
             "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}
NUMBER_RE = re.compile(r"第\s*([零一二三四五六七八九十百千万两\d]+)\s*[章节回卷]")
LOOKS_CHAPTER_RE = re.compile(r"^\s*第\s*[零一二三四五六七八九十百千万两\d]+\s*[章节回卷]")


def normalize_circled(value: Any) -> str:
    chars = []
    for ch in str(value or ""):
        code = ord(ch)
        if 0x2460 <= code <= 0x2473:
            chars.append(str(code - 0x2460 + 1))
        elif 0x3251 <= code <= 0x325F:
            chars.append(str(code - 0x3251 + 21))
        else:
            chars.append(ch)
    return "".join(chars)


def cn_to_number(value: str) -> int:
    total = section = number = 0
    for ch in value:
        if ch.isascii() and ch.isdigit():
            number = number * 10 + int(ch)
        elif ch in CN_DIGITS:
            number = CN_DIGITS[ch]
        elif ch in CN_UNITS:
            unit = CN_UNITS[ch]
            if unit == 10000:
                section = (section + number) * unit
                total += section
                section = 0
            else:
                section += (number or 1) * unit
            number = 0
    return total + section + number


def chapter_number(title: Any) -> int:
    match = NUMBER_RE.search(normalize_circled(title))
    if not match:
        return 0
    raw = match.group(1)
    return int(raw) if raw.isascii() and raw.isdigit() else cn_to_number(raw)


def normalize_chapters(chapters: Any) -> list[dict[str, Any]]:
    if not isinstance(chapters, list) or len(chapters) < 2:
        return chapters if isinstance(chapters, list) else []

    seen_url: set[str] = set()
    seen_title: set[str] = set()
    result: list[dict[str, Any]] = []
    for chapter in chapters:
        if not isinstance(chapter, dict):
            continue
        url = str(chapter.get("url") or "").strip()
        title = re.sub(r"\s+", "", str(chapter.get("title") or "").strip())
        if (url and url in seen_url) or (title and title in seen_title):
            continue
        if url:
            seen_url.add(url)
        if title:
            seen_title.add(title)
        result.append(chapter)

    standard = sum(1 for c in result if LOOKS_CHAPTER_RE.search(str(c.get("title") or "")))
    filtered = [c for c in result if LOOKS_CHAPTER_RE.search(str(c.get("title") or ""))] \
        if result and standard >= len(result) * 0.7 else result
    if not filtered:
        return filtered

    numbers = [chapter_number(c.get("title")) for c in filtered]
    known = sum(1 for n in numbers if n > 0)
    if known < len(filtered) * 0.6:
        return filtered
    # Python sort 稳定；未知章节号保持相对顺序并排到已知章节之后。
    return [item[1] for item in sorted(
        enumerate(filtered),
        key=lambda item: (numbers[item[0]] if numbers[item[0]] > 0 else 2**53 - 1, item[0]),
    )]
