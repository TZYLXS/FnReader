# -*- coding: utf-8 -*-
"""TXT 目录规则（Legado txtTocRule 的启用项）+ 分章实现"""
import re

RULES = [
  {
    "id": -1,
    "name": "目录(去空白)",
    "rule": "(?<=[　\\s])(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|集(?![合和]))).{0,30}$"
  },
  {
    "id": -2,
    "name": "目录",
    "rule": "^[ 　\\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|集(?![合和])|部(?![分赛游])|篇(?!张))).{0,30}$"
  },
  {
    "id": -8,
    "name": "数字 分隔符 标题名称",
    "rule": "^[ 　\\t]{0,4}\\d{1,5}[:：,.， 、_—\\-].{1,30}$"
  },
  {
    "id": -9,
    "name": "大写数字 分隔符 标题名称",
    "rule": "^[ 　\\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|[零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}章?)[ 、_—\\-].{1,30}$"
  },
  {
    "id": -11,
    "name": "正文 标题/序号",
    "rule": "^[ 　\\t]{0,4}正文[ 　]{1,4}.{0,20}$"
  },
  {
    "id": -12,
    "name": "Chapter/Section/Part/Episode 序号 标题",
    "rule": "^[ 　\\t]{0,4}(?:[Cc]hapter|[Ss]ection|[Pp]art|ＰＡＲＴ|[Nn][oO][.、]|[Ee]pisode|(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外)\\s{0,4}\\d{1,4}.{0,30}$"
  },
  {
    "id": -14,
    "name": "特殊符号 序号 标题",
    "rule": "(?<=[\\s　])[【〔〖「『〈［\\[](?:第|[Cc]hapter)[\\d零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,10}[章节].{0,20}$"
  },
  {
    "id": -16,
    "name": "特殊符号 标题(单个)",
    "rule": "(?<=[\\s　]{0,4})(?:[☆★✦✧].{1,30}|(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外)[ 　]{0,4}$"
  },
  {
    "id": -17,
    "name": "章/卷 序号 标题",
    "rule": "^[ \\t　]{0,4}(?:(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|[卷章][\\d零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8})[ 　]{0,4}.{0,30}$"
  },
  {
    "id": -21,
    "name": "书名 括号 序号",
    "rule": "^[一-龥]{1,20}[ 　\\t]{0,4}[(（][\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}[)）][ 　\\t]{0,4}$"
  },
  {
    "id": -22,
    "name": "书名 序号",
    "rule": "^[一-龥]{1,20}[ 　\\t]{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}[ 　\\t]{0,4}$"
  },
  {
    "id": -24,
    "name": "字数分割 分节阅读",
    "rule": "(?<=[ 　\\t]{0,4})(?:.{0,15}分[页节章段]阅读[-_ ]|第\\s{0,4}[\\d零一二两三四五六七八九十百千万]{1,6}\\s{0,4}[页节]).{0,30}$"
  }
]

_COMPILED = []
for _r in RULES:
    try:
        _COMPILED.append({**_r, "re": re.compile(_r["rule"], re.IGNORECASE | re.MULTILINE)})
    except Exception:
        continue


def pick_rule(lines):
    best = (None, 0)
    for r in _COMPILED:
        hits = 0
        for line in lines:
            t = str(line or "").strip()
            if t and len(t) <= 60 and r["re"].search(t):
                hits += 1
        if hits > best[1]:
            best = (r, hits)
    return best


def split_chapters(text, fallback_title="正文"):
    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    rule, hits = pick_rule(lines)
    rx = rule["re"] if rule else None
    chapters = []
    cur = None
    for raw in lines:
        t = raw.strip().lstrip("\ufeff")
        if not t:
            continue
        if rx is not None and len(t) <= 60 and rx.search(t) and (cur is None or cur["paragraphs"]):
            if cur and cur["paragraphs"]:
                chapters.append(cur)
            cur = {"title": t, "paragraphs": []}
            continue
        if cur is None:
            cur = {"title": fallback_title, "paragraphs": []}
        cur["paragraphs"].append(t)
    if cur and cur["paragraphs"]:
        chapters.append(cur)
    if not chapters:
        chapters = [{"title": fallback_title, "paragraphs": [str(text or "")[:4000]]}]
    return {"chapters": chapters, "rule": (rule or {}).get("name", ""), "hits": hits}
