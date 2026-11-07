#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发版助手：递增版本号 + 写一条更新日志。

用法：
    python tools/release.py "更新说明1；说明2" [--build] [--dry-run]
"""
import io
import os
import re
import subprocess
import sys
from datetime import date

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(BASE, "legado-web", "manifest")
APPJS = os.path.join(BASE, "legado-web", "app", "web", "app.js")
INDEX = os.path.join(BASE, "legado-web", "app", "web", "index.html")
TXT = os.path.join(BASE, "docs", "更新日志.txt")
MD = os.path.join(BASE, "docs", "更新日志.md")

NL = "\n"


def bump(version):
    parts = version.split(".")
    while len(parts) < 3:
        parts.append("0")
    parts[-1] = str(int(parts[-1]) + 1)
    return ".".join(parts)


def split_notes(note):
    return [x.strip() for x in re.split(r"[；;]", note) if x.strip()]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print('用法: python tools/release.py "更新说明1；说明2" [--build] [--dry-run]')
        return 1
    note = args[0]
    do_build = "--build" in sys.argv
    dry = "--dry-run" in sys.argv

    manifest = io.open(MANIFEST, encoding="utf-8").read()
    m = re.search(r"^version=(.+)$", manifest, re.M)
    if not m:
        print("manifest 里找不到 version")
        return 1
    old = m.group(1).strip()
    new = bump(old)
    today = date.today().isoformat()
    notes = split_notes(note)

    # manifest
    manifest_new = re.sub(r"^version=.+$", "version=" + new, manifest, flags=re.M)
    manifest_new = re.sub(r"^changelog=.*$", "changelog=" + note, manifest_new, flags=re.M)

    # 更新日志 txt
    txt = io.open(TXT, encoding="utf-8").read()
    items = "".join("  ・" + n + NL for n in notes)
    entry = (
        "--------------------------------------------------" + NL
        + new + "    " + today + NL
        + "--------------------------------------------------" + NL
        + items + NL
    )
    idx = txt.find("--------------------------------------------------")
    txt_new = txt[:idx] + entry + txt[idx:]
    txt_new = re.sub(r"当前版本：V[\d.]+", "当前版本：V" + new, txt_new, count=1)

    # 更新日志 md
    md_new = None
    if os.path.exists(MD):
        md = io.open(MD, encoding="utf-8").read()
        bullets = "".join("- " + n + NL for n in notes)
        md_entry = "## " + new + " — " + today + NL + NL + bullets + "---" + NL + NL
        first = md.find("## ")
        if first >= 0:
            md_new = md[:first] + md_entry + md[first:]

    # app.js 版本显示
    js_new = None
    if os.path.exists(APPJS):
        js = io.open(APPJS, encoding="utf-8").read()
        js_new = re.sub(r"版本 V[\d.]+", "版本 V" + new, js)

    # index.html：版本 meta + 静态资源版本号
    idx_new = None
    if os.path.exists(INDEX):
        h = io.open(INDEX, encoding="utf-8").read()
        h = re.sub(
            r'<meta name="app-version" content="[\d.]+"',
            '<meta name="app-version" content="' + new + '"',
            h,
            count=1,
        )
        h = re.sub(r"\?v=[\d.]+", "?v=" + new, h)
        idx_new = h

    print(old + " -> " + new)
    for n in notes:
        print("  - " + n)

    if dry:
        print("(dry-run，未写入任何文件)")
        return 0

    io.open(MANIFEST, "w", encoding="utf-8", newline=NL).write(manifest_new)
    io.open(TXT, "w", encoding="utf-8", newline=NL).write(txt_new)
    if md_new is not None:
        io.open(MD, "w", encoding="utf-8", newline=NL).write(md_new)
    if js_new is not None:
        io.open(APPJS, "w", encoding="utf-8", newline=NL).write(js_new)
    if idx_new is not None:
        io.open(INDEX, "w", encoding="utf-8", newline=NL).write(idx_new)
    print("已写入 manifest / 更新日志 / app.js / index.html")

    if do_build:
        subprocess.run(["bash", os.path.join(BASE, "tools", "build-fpk.sh")], check=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
