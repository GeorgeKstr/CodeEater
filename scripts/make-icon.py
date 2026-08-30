#!/usr/bin/env python3
"""Generate the CodeEater app icon (dark rounded square, chevron + sparkle)."""
from PIL import Image, ImageDraw

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# background: vertical gradient dark blue-gray
top = (36, 39, 48)
bot = (18, 19, 24)
for y in range(SIZE):
    t = y / SIZE
    r = int(top[0] + (bot[0] - top[0]) * t)
    g = int(top[1] + (bot[1] - top[1]) * t)
    b = int(top[2] + (bot[2] - top[2]) * t)
    d.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

# rounded mask
mask = Image.new("L", (SIZE, SIZE), 0)
dm = ImageDraw.Draw(mask)
radius = 190
dm.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
img.putalpha(mask)

d = ImageDraw.Draw(img)

def chevron(cx, cy, half, stroke, color):
    """Two diagonal strokes forming a right-pointing chevron."""
    d.line([(cx - half, cy - half), (cx, cy - stroke), (cx - half, cy - half - 0)], fill=color, width=int(stroke))
    # draw as thick polygon strokes instead for crispness
    d.line([(cx - half, cy - half), (cx, cy)], fill=color, width=int(stroke))
    d.line([(cx, cy), (cx - half, cy + half)], fill=color, width=int(stroke))

# accent color
ACCENT = (110, 168, 255, 255)
GREEN = (125, 211, 160, 255)
WHITE = (236, 238, 244, 255)

# Big chevron (left part of "</>" feel) — two chevrons forming ">
cw = 300
cx0, cy0 = SIZE * 0.42, SIZE * 0.50
d.line([(cx0 - 260, cy0 - 200), (cx0, cy0)], fill=ACCENT, width=78)
d.line([(cx0, cy0), (cx0 - 260, cy0 + 200)], fill=ACCENT, width=78)
d.line([(cx0 - 40, cy0 - 200), (cx0 + 220, cy0)], fill=ACCENT, width=78)
d.line([(cx0 + 220, cy0), (cx0 - 40, cy0 + 200)], fill=ACCENT, width=78)

# sparkle: 4-point star top-right
sx, sy = SIZE * 0.72, SIZE * 0.30
R1, R2 = 150, 52
pts = []
for i in range(8):
    ang = i * 45 / 180 * 3.14159265 - 3.14159265 / 4
    rad = R1 if i % 2 == 0 else R2
    pts.append((sx + rad * (1 if abs(ang) < 0.01 else __import__("math").cos(ang)),
                sy + rad * __import__("math").sin(ang)))
d.polygon(pts, fill=GREEN)

# small terminal prompt bar bottom-center-left (underscore cursor)
bx0, by0 = SIZE * 0.34, SIZE * 0.76
d.rounded_rectangle([bx0, by0, bx0 + 250, by0 + 52], radius=26, fill=WHITE)

img = img.resize((512, 512), Image.LANCZOS)
img.save("build/icon.png")
img.save("build/icon-512.png")
img.resize((256, 256), Image.LANCZOS).save("build/icon-256.png")
img.resize((128, 128), Image.LANCZOS).save("build/icon-128.png")
img.resize((64, 64), Image.LANCZOS).save("build/icon-64.png")
img.save("build/icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (32, 32), (16, 16)])
print("icon written to build/")