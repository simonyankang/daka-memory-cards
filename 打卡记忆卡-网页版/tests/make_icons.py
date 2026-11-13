#!/usr/bin/env python3
# 生成 PWA 图标：品牌青绿圆角方块 + 白色记忆卡/对勾，输出 192/512 PNG。
# 用 Pillow 高分辨率绘制再 LANCZOS 缩小，保证边缘抗锯齿。仅构建期用，运行时不依赖。
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..')
BRAND = (15, 118, 110)        # #0f766e
BRAND_DARK = (10, 90, 84)     # 稍深，做上下微渐变
WHITE = (255, 255, 255)
CARD = (230, 242, 240)        # #e6f2f0 浅青，卡片底色
SCALE = 4                      # 超采样倍数


def rounded_gradient(size):
    s = size * SCALE
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    # 竖向微渐变底
    grad = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / max(1, s - 1)
        c = tuple(int(BRAND[i] * (1 - t) + BRAND_DARK[i] * t) for i in range(3)) + (255,)
        d.line([(0, y), (s, y)], fill=c)
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    return img, mask, s


def draw_mark(img, s):
    d = ImageDraw.Draw(img)
    # 记忆卡：白色描边卡片，略微倾斜的“叠放”暗示
    pad = int(s * 0.24)
    card_w = s - pad * 2
    card_h = int(card_w * 0.72)
    top = (s - card_h) // 2
    # 后层卡（浅青，右移一点）
    d.rounded_rectangle(
        [pad + int(s * 0.06), top - int(s * 0.05), pad + card_w + int(s * 0.06), top + card_h - int(s * 0.05)],
        radius=int(s * 0.05), fill=CARD + (210,))
    # 前层卡（白）
    d.rounded_rectangle([pad, top, pad + card_w, top + card_h], radius=int(s * 0.05), fill=WHITE + (255,))
    # 卡上文字行（3 条青色短线，代表“文字卡片”）
    lx = pad + int(s * 0.07)
    ly = top + int(s * 0.10)
    line_w = int(card_w * 0.5)
    for i, w in enumerate([line_w, int(line_w * 0.78), int(line_w * 0.9)]):
        yy = ly + i * int(s * 0.065)
        d.rounded_rectangle([lx, yy, lx + w, yy + int(s * 0.022)], radius=int(s * 0.011), fill=BRAND + (170,))
    # 右下角对勾圆章（品牌色圆 + 白勾）
    cx, cy, r = pad + card_w - int(s * 0.03), top + card_h - int(s * 0.03), int(s * 0.085)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BRAND + (255,))
    d.line([(cx - int(r * 0.45), cy), (cx - int(r * 0.08), cy + int(r * 0.38)), (cx + int(r * 0.5), cy - int(r * 0.34))],
           fill=WHITE + (255,), width=max(2, int(s * 0.018)), joint='curve')


def make(size):
    img, mask, s = rounded_gradient(size)
    draw_mark(img, s)
    # 应用圆角遮罩
    out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out = out.resize((size, size), Image.LANCZOS)
    path = os.path.join(OUT, 'icon-%d.png' % size)
    out.save(path, 'PNG', optimize=True)
    print('wrote %s (%d bytes)' % (path, os.path.getsize(path)))


if __name__ == '__main__':
    for sz in (192, 512):
        make(sz)
