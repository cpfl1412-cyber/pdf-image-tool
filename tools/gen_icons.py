#!/usr/bin/env python3
"""앱 아이콘 생성 (1024px 원본 → 512/192/180/167/152)."""
from PIL import Image, ImageDraw

S = 1024
TOP = (47, 107, 246)
BOTTOM = (18, 58, 168)
WHITE = (255, 255, 255, 255)
BLUE = (26, 86, 219, 255)
SOFT = (191, 214, 255, 255)


def gradient(size):
    img = Image.new('RGB', (size, size), TOP)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        c = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c)
    return img


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def make_base():
    img = gradient_master.copy()
    d = ImageDraw.Draw(img, 'RGBA')

    # 문서 카드
    rounded(d, (150, 232, 452, 648), 34, WHITE)
    for i, y in enumerate((318, 380, 442)):
        d.rounded_rectangle((200, y, 402 if i < 2 else 330, y + 24), radius=12, fill=BLUE)
    d.rounded_rectangle((200, 512, 402, 596), radius=14, fill=SOFT)

    # 사진 카드
    rounded(d, (572, 232, 874, 648), 34, WHITE)
    d.ellipse((624, 286, 690, 352), fill=BLUE)
    d.polygon([(592, 610), (700, 420), (790, 610)], fill=BLUE)
    d.polygon([(716, 610), (782, 492), (854, 610)], fill=SOFT)

    # 좌우 화살표
    ay0, ay1 = 736, 812
    mid = (S // 2)
    d.rounded_rectangle((300, (ay0 + ay1) // 2 - 14, 724, (ay0 + ay1) // 2 + 14), radius=14, fill=WHITE)
    d.polygon([(300, (ay0 + ay1) // 2), (372, ay0), (372, ay1)], fill=WHITE)
    d.polygon([(724, (ay0 + ay1) // 2), (652, ay0), (652, ay1)], fill=WHITE)
    return img


gradient_master = gradient(S)
art = make_base()

for name, size in [
    ('icon-512.png', 512),
    ('icon-192.png', 192),
    ('apple-touch-icon.png', 180),
    ('icon-167.png', 167),
    ('icon-152.png', 152),
    ('icon-1024.png', 1024),
]:
    art.resize((size, size), Image.LANCZOS).save('icons/' + name, optimize=True)

# maskable: 안전 영역(80%) 확보를 위해 배경 위에 축소 배치
mask_bg = gradient(S)
inner = art.resize((int(S * 0.78), int(S * 0.78)), Image.LANCZOS)
mask_bg.paste(inner, ((S - inner.width) // 2, (S - inner.height) // 2))
mask_bg.resize((512, 512), Image.LANCZOS).save('icons/icon-maskable-512.png', optimize=True)

print('icons written')
