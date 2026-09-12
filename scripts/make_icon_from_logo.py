# -*- coding: utf-8 -*-
"""用 MusicFree logo 生成 macOS 风格图标: 圆角方形底板 + logo -> icon.icns"""
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
SRC = sys.argv[1] if len(sys.argv) > 1 else (
    "/Users/huah/Desktop/WorkSpace/MusicFree/android/app/src/main/ic_launcher-playstore.png")
SIZE = 1024

src = Image.open(SRC).convert("RGBA")

# macOS Big Sur 网格: 824x824 圆角方形居中, 圆角 185
shape_bounds = 100, 100, 924, 924
radius = 185

# logo 放大铺满底板区域
logo = src.resize((824, 824), Image.LANCZOS)
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
img.paste(logo, (100, 100))

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle(shape_bounds, radius=radius, fill=255)
img.putalpha(mask)

# ---------- 导出 iconset + icns ----------
os.makedirs(BUILD, exist_ok=True)
img.save(os.path.join(BUILD, "icon.png"))

iconset = os.path.join(BUILD, "icon.iconset")
shutil.rmtree(iconset, ignore_errors=True)
os.makedirs(iconset)
for s in (16, 32, 64, 128, 256, 512, 1024):
    img.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}.png"))
    if s <= 512:
        img.resize((s * 2, s * 2), Image.LANCZOS).save(
            os.path.join(iconset, f"icon_{s}x{s}@2x.png"))

subprocess.run(["iconutil", "-c", "icns", iconset, "-o",
                os.path.join(BUILD, "icon.icns")], check=True)
print("icon.icns ->", os.path.join(BUILD, "icon.icns"))
