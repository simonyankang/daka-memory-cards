#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成高可扫性二维码：纯黑白 + 逐格绘制 + 宽静区。
用途：WorkBuddy 分享链接带 ?sharecode= 参数，微信转发会洗掉该参数，
故用扫码（纯文本 URL 直开）绕开。青绿色对比度低、微信压缩后易解错，
本脚本改用纯黑白 + 更大模块 + 更宽静区，最大化各扫码器识别率。
每个成品都从 get_matrix() 逐格绘制并逐位回采校验，纯二值、无灰边。
"""
import os
import qrcode
from PIL import Image, ImageDraw, ImageFont

URL = "https://daka-memory-cards.app.workbuddy.host/?sharecode=KDDOWMTOVB"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.dirname(HERE)  # 项目根
FG = (0, 0, 0)       # 纯黑
BG = (255, 255, 255)  # 纯白

def font(sz, bold=False):
    for p in (["C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
               "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simsun.ttc"]):
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=12, border=4)
qr.add_data(URL)
qr.make(fit=True)
mat = qr.get_matrix()   # 含 4 模块静区
n = len(mat)

def paint(canvas, ox, oy, cell):
    d = ImageDraw.Draw(canvas)
    for r in range(n):
        for c in range(n):
            if mat[r][c]:
                x, y = ox + c * cell, oy + r * cell
                d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=FG)
    return canvas

def verify(canvas, ox, oy, cell):
    px = canvas.convert("RGB")
    def dark(p): return p[0] < 128
    return sum(1 for r in range(n) for c in range(n)
               if dark(px.getpixel((ox + c*cell + cell//2, oy + r*cell + cell//2))) != bool(mat[r][c]))

# 1) 纯码：逐格画，四周再加 40px 白边静区
C1 = 16
pure = paint(Image.new("RGB", (n*C1, n*C1), BG), 0, 0, C1)
mm1 = verify(pure, 0, 0, C1)
cols = pure.getcolors(maxcolors=100000)
pure_path = os.path.join(D, "打卡记忆卡-扫码打开.png")
pure.save(pure_path)
print(f"纯码: {n}x{n} cell={C1} 不一致={mm1} 颜色={len(cols)} -> {os.path.basename(pure_path)}")

# 2) 分享卡：二维码纯黑白，缩小上移，留足文字间距
C2, qy = 9, 205
qsize = n * C2
W, H = 720, 1000
card = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(card)
d.rectangle([0, 0, W, 180], fill=(15, 118, 110))  # 顶栏仍用品牌青绿（不参与扫码）
d.text((W//2, 66), "打卡 · 记忆卡", font=font(46, True), fill="#ffffff", anchor="mm")
d.text((W//2, 128), "扫码打开（链接含完整访问凭证）", font=font(22), fill="#d7f0eb", anchor="mm")
qx = (W - qsize)//2
paint(card, qx, qy, C2)
mm2 = verify(card, qx, qy, C2)
lines = [
    ("① 图片存到相册，退出微信", "#1f2329", True),
    ("② 用 iPhone「相机」扫相册里的码", "#1f2329", False),
    ("   别用微信扫一扫 / 长按识别（会丢参数）", "#a32d2d", True),
    ("③ Safari 打开 → 分享 → 添加到主屏幕", "#1f2329", False),
    ("   装好后从桌面图标进，断网也能用", "#6b7280", False),
]
y = 770
for t, c, b in lines:
    d.text((W//2, y), t, font=font(20, b), fill=c, anchor="mm")
    y += 37
card_path = os.path.join(D, "打卡记忆卡-扫码分享卡.png")
card.save(card_path)
print(f"分享卡: cell={C2} 码底={qy+qsize} 首行文字=770 间距={770-(qy+qsize)}px 不一致={mm2}")
print(f"-> {os.path.basename(card_path)}")
gap = 770 - (qy + qsize)
print("VERDICT:", "PASS" if (mm1==0 and mm2==0 and len(cols)==2 and gap >= 30) else f"FAIL (gap={gap})")
