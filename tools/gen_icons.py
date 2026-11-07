# -*- coding: utf-8 -*-
"""生成 fnOS 应用图标（圆角方形 + 打开的书）"""
from PIL import Image, ImageDraw, ImageFilter
import os

BG_TOP = (58, 123, 213)
BG_BOTTOM = (35, 66, 150)
ACCENT = (255, 255, 255)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def gradient(size):
    w, h = size
    img = Image.new("RGB", size)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    return img


def draw_book(img, s):
    """在 s x s 画布上画一本打开的书"""
    d = ImageDraw.Draw(img)
    cx, cy = s / 2, s * 0.52
    w = s * 0.60      # 书宽
    h = s * 0.42      # 书高
    left = cx - w / 2
    top = cy - h / 2
    spine = s * 0.035

    # 左右两页（略带弧度用多边形近似）
    lobe = [
        (left, top + h * 0.14),
        (cx - spine, top + h * 0.02),
        (cx - spine, top + h * 0.92),
        (left + w * 0.06, top + h),
    ]
    robe = [
        (left + w, top + h * 0.14),
        (cx + spine, top + h * 0.02),
        (cx + spine, top + h * 0.92),
        (left + w - w * 0.06, top + h),
    ]
    d.polygon(lobe, fill=ACCENT)
    d.polygon(robe, fill=ACCENT)

    # 书页内侧阴影线
    shade = (210, 226, 250)
    d.line([(cx - spine, top + h * 0.06), (cx - spine, top + h * 0.9)], fill=shade, width=max(1, int(s * 0.012)))
    d.line([(cx + spine, top + h * 0.06), (cx + spine, top + h * 0.9)], fill=(190, 210, 242), width=max(1, int(s * 0.012)))

    # 书页横线
    lw = max(1, int(s * 0.010))
    for i in range(3):
        y = top + h * (0.24 + i * 0.2)
        d.line([(left + w * 0.10, y), (cx - spine - w * 0.06, y)], fill=(120, 160, 220), width=lw)
        d.line([(cx + spine + w * 0.06, y), (left + w - w * 0.10, y)], fill=(120, 160, 220), width=lw)


def make_icon(size, radius_ratio=0.225, transparent_bg=False):
    ss = 4  # 超采样
    big = size * ss
    base = gradient((big, big))
    draw_book(base, big)
    mask = rounded_mask((big, big), int(big * radius_ratio))
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pkg = os.path.join(root, "fnos-legado")
    ui = os.path.join(pkg, "app", "ui", "images")
    os.makedirs(ui, exist_ok=True)

    icon64 = make_icon(64)
    icon256 = make_icon(256)
    icon64.save(os.path.join(pkg, "ICON.PNG"))
    icon256.save(os.path.join(pkg, "ICON_256.PNG"))
    icon64.save(os.path.join(ui, "icon_64.png"))
    icon256.save(os.path.join(ui, "icon_256.png"))
    # 网页 favicon
    icon256.resize((64, 64), Image.LANCZOS).save(os.path.join(root, "fnos-legado", "app", "web", "icon.png"))
    print("icons written")


if __name__ == "__main__":
    main()
