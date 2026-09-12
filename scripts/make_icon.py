# -*- coding: utf-8 -*-
"""生成 MusicFreeDesktop 应用图标: 1024 绘制 -> iconset -> icon.icns"""
import os
import shutil
import subprocess
import math

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
SIZE = 1024

# ---------- 1. 画布与圆角方形底板 (macOS Big Sur 网格: 824 居中, 圆角 185) ----------
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
shape_bounds = 100, 100, 924, 924
radius = 185

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle(shape_bounds, radius=radius, fill=255)

# 对角渐变底板: 顶部 #6E5BFF -> 底部 #3D6BFF
grad = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
top = (122, 92, 255)
bottom = (58, 106, 255)
px = grad.load()
for y in range(SIZE):
    for x in range(0, SIZE, 4):  # 水平 4px 步进 + 后续平滑即可
        t = (x + y) / (2 * SIZE)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for dx in range(4):
            if x + dx < SIZE:
                px[x + dx, y] = (*c, 255)
grad = grad.filter(ImageFilter.GaussianBlur(2))

img.paste(grad, (0, 0), mask)

# 左上柔和高光
hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(hl).ellipse((-260, -260, 620, 620), fill=(255, 255, 255, 46))
hl = hl.filter(ImageFilter.GaussianBlur(90))
img = Image.composite(Image.alpha_composite(img, hl), img, mask)

# ---------- 2. 白色双音符 ----------
note = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(note)
W = (255, 255, 255, 255)

def note_head(cx, cy):
    """椭圆符头, 长轴 128 短轴 96, 旋转 -20 度"""
    head = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(head).ellipse((36, 52, 164, 148), fill=W)
    head = head.rotate(20, resample=Image.BICUBIC)
    note.alpha_composite(head, (int(cx - 100), int(cy - 100)))

def stem(x, y_top, y_bottom):
    d.rounded_rectangle((x - 13, y_top, x + 13, y_bottom), radius=13, fill=W)

# 符头
note_head(398, 706)
note_head(648, 664)

# 符干
stem(446, 336, 706)
stem(696, 300, 664)

# 连音梁 (略上斜): 底边覆盖两根符干顶端, 上移 82px 得到顶边
beam = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(beam).polygon(
    [(433, 340), (709, 304), (709, 222), (433, 258)], fill=W)
note.alpha_composite(beam)

# 音符柔和投影
shadow = note.split()[3].point(lambda a: int(a * 0.28))
sh = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
black = Image.new("RGBA", (SIZE, SIZE), (10, 10, 40, 255))
sh.paste(black, (0, 14), shadow)
sh = sh.filter(ImageFilter.GaussianBlur(16))
img = Image.alpha_composite(img, sh)
img = Image.alpha_composite(img, note)

# ---------- 3. 导出 iconset + icns ----------
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
