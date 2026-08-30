#!/usr/bin/env python3
"""Generate the CodeEater app icon — "CE" in the previous angular style.

Same dark rounded square, same VS Code-ish blue (#569CD6) / gold (#D7BA7D)
palette, and the same thick, /-slanted "shard" bars as the classic icon —
but the shards now compose into a readable C (blue) and E (gold) resting
on the blue base bar, with the gold glint above. Rendered with
supersampling for crisp edges at every size.
"""
from PIL import Image, ImageDraw

SS = 4                      # supersampling factor
BASE = 1024
SIZE = BASE * SS            # 4096 canvas

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# ----------------------------------------------------------------- background
top = (36, 39, 48)
bot = (18, 19, 24)
for y in range(SIZE):
    t = y / SIZE
    r = int(top[0] + (bot[0] - top[0]) * t)
    g = int(top[1] + (bot[1] - top[1]) * t)
    b = int(top[2] + (bot[2] - top[2]) * t)
    d.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

M = int(44 * SS)
R = int(195 * SS)
mask = Image.new("L", (SIZE, SIZE), 0)
dm = ImageDraw.Draw(mask)
dm.rounded_rectangle([M, M, SIZE - M - 1, SIZE - M - 1], radius=R, fill=255)
img.putalpha(mask)
d = ImageDraw.Draw(img)

# ------------------------------------------------------------------- palette
BLUE = (86, 156, 214, 255)     # #569CD6 — the classic icon's blue
GOLD = (215, 186, 125, 255)    # #D7BA7D — the classic icon's gold

# The classic mark's shards lean "/" (top right, bottom left): 11°.
CY = 550 * SS                  # shear pivot (letter mid-height)
K = 0.2                        # Δx = Δy * 0.2 → ~11°

def shear_poly(poly):
    return [(x + (CY - y) * K, y) for (x, y) in poly]

def rect(x0, y0, x1, y1, color):
    """Thick sheared parallelogram bar (the shard stroke)."""
    d.polygon(shear_poly([(x0 * SS, y0 * SS), (x1 * SS, y0 * SS),
                          (x1 * SS, y1 * SS), (x0 * SS, y1 * SS)]), fill=color)

def diamond(cx, cy, radius, color):
    rr = radius * SS
    cx, cy = cx * SS, cy * SS
    d.polygon([(cx, cy - rr), (cx + rr, cy), (cx, cy + rr), (cx - rr, cy)], fill=color)

# ------------------------------------------------------------------ letters
# Blue "C" — /-leaning stroke + top/bottom shard arms, open to the right.
rect(190, 300, 312, 800, BLUE)
rect(190, 300, 480, 420, BLUE)
rect(190, 680, 480, 800, BLUE)

# Gold "E" — /-leaning stroke + three shard arms.
rect(532, 300, 652, 800, GOLD)
rect(532, 300, 860, 420, GOLD)
rect(532, 560, 768, 680, GOLD)
rect(532, 680, 860, 800, GOLD)

# ----------------------------------------------------------------- underline
# Full-width blue base bar, low on the square (as in the classic icon).
d.rounded_rectangle([int(70 * SS), int(860 * SS), int(954 * SS), int(904 * SS)],
                    radius=int(22 * SS), fill=BLUE)

# ------------------------------------------------------------- accent glint
# Gold diamond above the letters' right side (classic glint position).
diamond(812, 185, 70, GOLD)

# Tiny micro-bars at the very bottom — the classic icon's ground detail.
for i, x0 in enumerate((128, 192, 256)):
    color = GOLD if i == 2 else BLUE
    d.polygon(shear_poly([(x0 * SS, 957 * SS), ((x0 + 46) * SS, 957 * SS),
                          ((x0 + 36) * SS, 991 * SS), ((x0 - 10) * SS, 991 * SS)]),
              fill=color)

# ------------------------------------------------------------------- export
img = img.resize((BASE, BASE), Image.LANCZOS)
img.save("build/icon.png")
img.save("build/icon-512.png")
img.resize((256, 256), Image.LANCZOS).save("build/icon-256.png")
img.resize((128, 128), Image.LANCZOS).save("build/icon-128.png")
img.resize((64, 64), Image.LANCZOS).save("build/icon-64.png")
img.resize((48, 48), Image.LANCZOS).save("build/icon-48.png")
img.save("build/icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (32, 32), (16, 16)])
print("icon written to build/")